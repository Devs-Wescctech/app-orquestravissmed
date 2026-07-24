import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerService } from '../integrations/docplanner.service';
import { QueueService } from './queue.service';
import { RateLimiterService } from './rate-limiter.service';

/**
 * Rede de segurança para agendamentos Doctoralia perdidos.
 *
 * Caso real: paciente marca pelo site da Doctoralia, mas a notificação (webhook e
 * polling de notificações) nunca chega ao servidor. As reconciliações existentes só
 * consultam a Doctoralia para registros que JÁ existem no banco — um booking novo cuja
 * notificação se perde fica invisível para sempre.
 *
 * Esta varredura consulta os bookings DIRETO na Doctoralia (endpoint por
 * facility/médico/endereço) para todos os médicos vinculados, num horizonte de hoje
 * até +N dias, e enfileira qualquer booking desconhecido pelo MESMO handler de
 * `slot-booked` (mesma dedupKey do polling → idempotente). Cancelamentos posteriores
 * seguem o fluxo existente (`reconcileCancelledOnDoctoralia` cobre startAt futuros).
 *
 * Configuração (defaults seguros):
 * - DISABLE_BOOKING_SWEEP=true          → kill switch (padrão dos demais crons)
 * - BOOKING_SWEEP_INTERVAL_MIN (20)     → intervalo entre varreduras
 * - BOOKING_SWEEP_HORIZON_DAYS (60)     → horizonte futuro (alinhado ao poll da VisMed)
 */

const SWEEP_STARTUP_DELAY_MS = 60 * 1000; // deixa o boot/polling normal assentar primeiro
const SWEEP_STAGGER_PER_CLINIC_MS = 15 * 1000;

function envInt(name: string, def: number, min: number, max: number): number {
    const raw = parseInt(process.env[name] || '', 10);
    if (isNaN(raw)) return def;
    return Math.min(max, Math.max(min, raw));
}

@Injectable()
export class BookingSafetySweepService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(BookingSafetySweepService.name);
    private readonly disabled = process.env.DISABLE_BOOKING_SWEEP === 'true';
    private readonly intervalMin = envInt('BOOKING_SWEEP_INTERVAL_MIN', 20, 5, 24 * 60);
    private readonly horizonDays = envInt('BOOKING_SWEEP_HORIZON_DAYS', 60, 1, 365);
    private timer: NodeJS.Timeout | null = null;
    private startupTimer: NodeJS.Timeout | null = null;
    private isRunning = false;
    private isShuttingDown = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly docplannerService: DocplannerService,
        private readonly queueService: QueueService,
        private readonly rateLimiter: RateLimiterService,
    ) {}

    onModuleInit() {
        if (this.disabled) {
            this.logger.warn('[SAFETY-SWEEP] Varredura de segurança DESATIVADA via DISABLE_BOOKING_SWEEP=true.');
            return;
        }
        this.logger.log(
            `[SAFETY-SWEEP] ATIVA — varredura direta de bookings Doctoralia a cada ${this.intervalMin}min, horizonte hoje→+${this.horizonDays}d.`,
        );
        this.startupTimer = setTimeout(() => {
            this.runSweepAllClinics();
            this.timer = setInterval(() => {
                if (!this.isShuttingDown) this.runSweepAllClinics();
            }, this.intervalMin * 60 * 1000);
        }, SWEEP_STARTUP_DELAY_MS);
    }

    onModuleDestroy() {
        this.isShuttingDown = true;
        if (this.startupTimer) clearTimeout(this.startupTimer);
        if (this.timer) clearInterval(this.timer);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async runSweepAllClinics(): Promise<{ clinics: number; enqueued: number }> {
        if (this.isRunning) {
            this.logger.warn('[SAFETY-SWEEP] Varredura anterior ainda em andamento — pulando este ciclo.');
            return { clinics: 0, enqueued: 0 };
        }
        this.isRunning = true;
        const startedAt = Date.now();
        let totalEnqueued = 0;
        let clinicsSwept = 0;
        try {
            const connections = await this.prisma.integrationConnection.findMany({
                where: { provider: 'doctoralia', status: 'connected' },
            });

            for (let i = 0; i < connections.length; i++) {
                if (this.isShuttingDown) break;
                // Staggering entre clínicas para diluir a carga (30 clínicas × médicos vinculados).
                if (i > 0) await this.sleep(SWEEP_STAGGER_PER_CLINIC_MS);
                try {
                    const enqueued = await this.sweepClinic(connections[i]);
                    totalEnqueued += enqueued;
                    clinicsSwept++;
                } catch (err: any) {
                    this.logger.warn(`[SAFETY-SWEEP] Falha na clínica ${connections[i].clinicId}: ${err?.message}`);
                }
            }

            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            if (totalEnqueued > 0) {
                this.logger.warn(
                    `[SAFETY-SWEEP] ⚠️ Ciclo concluído em ${elapsed}s: ${totalEnqueued} booking(s) PERDIDO(S) recuperado(s) em ${clinicsSwept} clínica(s) — webhook/notificações podem estar quebrados.`,
                );
            } else {
                this.logger.log(`[SAFETY-SWEEP] Ciclo concluído em ${elapsed}s: nenhum booking perdido (${clinicsSwept} clínica(s)).`);
            }
        } catch (err: any) {
            this.logger.error(`[SAFETY-SWEEP] Erro inesperado no ciclo: ${err?.message}`);
        } finally {
            this.isRunning = false;
        }
        return { clinics: clinicsSwept, enqueued: totalEnqueued };
    }

    /**
     * Varre uma clínica: para cada médico Doctoralia vinculado (Mapping LINKED),
     * consulta os bookings em todos os endereços conhecidos e enfileira os desconhecidos.
     * Retorna o número de bookings enfileirados.
     */
    async sweepClinic(conn: any): Promise<number> {
        if (!conn?.clientId || !conn?.clientSecret) return 0;

        const pairs = await this.collectDoctorAddressPairs(conn.clinicId);
        if (pairs.length === 0) {
            this.logger.debug(`[SAFETY-SWEEP] Clínica ${conn.clinicId}: nenhum médico vinculado com endereço conhecido.`);
            return 0;
        }

        // Conjunto de bookings já conhecidos (idempotência primária, além da dedupKey da fila).
        const known = new Set(
            (
                await this.prisma.bookingSync.findMany({
                    where: { clinicId: conn.clinicId, doctoraliaBookingId: { not: null } },
                    select: { doctoraliaBookingId: true },
                })
            ).map(r => r.doctoraliaBookingId!),
        );

        const client = this.docplannerService.createClient(
            conn.domain || 'doctoralia.com.br',
            conn.clientId,
            conn.clientSecret,
        );

        const { startIso, endIso } = this.horizonWindow();
        const jobs: Array<{ clinicId: string; type: string; payload: any; priority?: number; dedupKey?: string }> = [];
        const seenInSweep = new Set<string>();

        for (const pair of pairs) {
            if (this.isShuttingDown) break;
            try {
                await this.rateLimiter.acquire('doctoralia');
                const res = await client.getBookings(pair.facilityId, pair.doctorId, pair.addressId, startIso, endIso);
                const bookings = (res?._items || (Array.isArray(res) ? res : [])) as any[];
                if (!Array.isArray(bookings)) continue;

                for (const booking of bookings) {
                    const bid = booking?.id ? String(booking.id) : '';
                    if (!bid || known.has(bid) || seenInSweep.has(bid)) continue;
                    if (this.isCancelled(booking)) continue;
                    seenInSweep.add(bid);

                    // Booking existe na Doctoralia mas NUNCA chegou via webhook/notificações —
                    // forte indício de que o caminho de notificações está quebrado.
                    this.logger.warn(
                        `[SAFETY-SWEEP] ⚠️ NOTIFICAÇÃO PERDIDA: booking ${bid} (médico ${pair.doctorId}, ${booking.start_at}, paciente "${booking?.patient?.name || '?'}") existe na Doctoralia mas não chegou via webhook/polling. Enfileirando criação na VisMed.`,
                    );

                    const data = {
                        visit_booking: booking,
                        doctor: { id: pair.doctorId },
                        facility: { id: pair.facilityId },
                        address: { id: pair.addressId },
                    };
                    jobs.push({
                        clinicId: conn.clinicId,
                        type: 'slot-booked',
                        payload: {
                            data,
                            // `source` marca a origem: o handler registra alerta NOTIFICATION_MISSED
                            // no dashboard para dar visibilidade ao caminho de notificações quebrado.
                            raw: { name: 'slot-booked', source: 'safety-sweep', data },
                        },
                        priority: 1,
                        // Mesma dedupKey do polling normal → se a notificação chegar depois, não duplica.
                        dedupKey: `${conn.clinicId}:slot-booked:${bid}`,
                    });
                }
            } catch (err: any) {
                this.logger.warn(
                    `[SAFETY-SWEEP] Falha ao buscar bookings (facility=${pair.facilityId}, doctor=${pair.doctorId}, address=${pair.addressId}): ${err?.message}`,
                );
            }
        }

        if (jobs.length > 0) {
            await this.queueService.enqueueBatch(jobs);
        }
        return jobs.length;
    }

    private horizonWindow(): { startIso: string; endIso: string } {
        const toBrtIso = (d: Date) => {
            const local = new Date(d.getTime() - 3 * 60 * 60 * 1000);
            return local.toISOString().replace(/\.\d{3}Z$/, '-03:00');
        };
        const now = new Date();
        const end = new Date(now.getTime() + this.horizonDays * 24 * 60 * 60 * 1000);
        return { startIso: toBrtIso(now), endIso: toBrtIso(end) };
    }

    private isCancelled(b: any): boolean {
        if (!b) return false;
        if (b.cancelled_at || b.canceled_at) return true;
        const s = String(b.status || '').toUpperCase();
        return s === 'CANCELED' || s === 'CANCELLED' || s === 'DELETED';
    }

    /**
     * Descobre os pares (facilityId, doctorId, addressId) dos médicos Doctoralia
     * vinculados (Mapping DOCTOR LINKED), combinando três fontes:
     * 1. conflictData do Mapping (facilityId + address.id enriquecidos no sync)
     * 2. DoctoraliaAddressService (endereços sincronizados do médico)
     * 3. endereços já vistos em BookingSync
     */
    private async collectDoctorAddressPairs(
        clinicId: string,
    ): Promise<Array<{ facilityId: string; doctorId: string; addressId: string }>> {
        const mappings = await this.prisma.mapping.findMany({
            where: { clinicId, entityType: 'DOCTOR', status: 'LINKED', externalId: { not: null } },
        });
        if (mappings.length === 0) return [];

        const doctorIds = [...new Set(mappings.map(m => m.externalId!))];
        const pairKeys = new Set<string>();
        const pairs: Array<{ facilityId: string; doctorId: string; addressId: string }> = [];
        const add = (facilityId: any, doctorId: any, addressId: any) => {
            if (!facilityId || !doctorId || !addressId) return;
            const key = `${facilityId}|${doctorId}|${addressId}`;
            if (pairKeys.has(key)) return;
            pairKeys.add(key);
            pairs.push({ facilityId: String(facilityId), doctorId: String(doctorId), addressId: String(addressId) });
        };

        // Fonte 1: conflictData do mapping
        for (const m of mappings) {
            const cd = (m.conflictData as any) || {};
            add(cd.facilityId, m.externalId, cd.address?.id);
        }

        // Fonte 2: DoctoraliaAddressService (via DoctoraliaDoctor)
        const docDoctors = await this.prisma.doctoraliaDoctor.findMany({
            where: { doctoraliaDoctorId: { in: doctorIds } },
            include: { addressServices: { select: { doctoraliaAddressId: true } } },
        });
        for (const d of docDoctors) {
            const addressIds = new Set(d.addressServices.map(s => s.doctoraliaAddressId).filter(Boolean));
            for (const addrId of addressIds) {
                add(d.doctoraliaFacilityId, d.doctoraliaDoctorId, addrId);
            }
        }

        // Fonte 3: endereços já vistos em BookingSync
        const bsAddresses = await this.prisma.bookingSync.findMany({
            where: {
                clinicId,
                doctoraliaDoctorId: { in: doctorIds },
                doctoraliaAddressId: { not: null },
                doctoraliaFacilityId: { not: null },
            },
            select: { doctoraliaDoctorId: true, doctoraliaAddressId: true, doctoraliaFacilityId: true },
            distinct: ['doctoraliaDoctorId', 'doctoraliaAddressId'],
        });
        for (const b of bsAddresses) {
            add(b.doctoraliaFacilityId, b.doctoraliaDoctorId, b.doctoraliaAddressId);
        }

        return pairs;
    }
}
