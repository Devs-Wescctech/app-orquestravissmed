import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerClient, DocplannerService } from '../integrations/docplanner.service';
import { QueueService } from './queue.service';
import { RateLimiterService } from './rate-limiter.service';
import { runWithDoctoraliaContext } from '../metrics/doctoralia-call-context';
import { getDoctoraliaMetricsService, concurrencyActorOf } from '../metrics/doctoralia-metrics.service';
import { ClinicConcurrencyGuard } from './clinic-concurrency-guard';
import { isDoctoraliaCircuitOpenError } from '../integrations/doctoralia-circuit-breaker';

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
    /** Estado das varreduras manuais por clínica (gatilho da UI, roda em background). */
    private readonly manualSweeps = new Map<
        string,
        { running: boolean; startedAt: string; finishedAt?: string; enqueued?: number; error?: string }
    >();
    private startupTimer: NodeJS.Timeout | null = null;
    private isRunning = false;
    private isShuttingDown = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly docplannerService: DocplannerService,
        private readonly queueService: QueueService,
        private readonly rateLimiter: RateLimiterService,
        private readonly concurrencyGuard: ClinicConcurrencyGuard,
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
                where: { provider: 'doctoralia', status: { not: 'disconnected' }, clientId: { not: null } },
            });

            for (let i = 0; i < connections.length; i++) {
                if (this.isShuttingDown) break;
                // Staggering entre clínicas para diluir a carga (30 clínicas × médicos vinculados).
                if (i > 0) await this.sleep(SWEEP_STAGGER_PER_CLINIC_MS);
                const clinicId = connections[i].clinicId;
                try {
                    // WP-02 P2c: Guard de concorrência — SKIP se Polling ativo para esta clínica
                    if (this.concurrencyGuard.isActive(clinicId, 'POLLING')) {
                        this.logger.warn(`[SAFETY-SWEEP] SWEEP_SKIPPED_POLL_ACTIVE clinicId=${clinicId} — Polling em andamento, varredura descartada`);
                        try { getDoctoraliaMetricsService()?.recordConcurrencySkip('SWEEP_SKIPPED_POLL_ACTIVE', clinicId); } catch (_e) {}
                        continue;
                    }
                    if (!this.concurrencyGuard.tryAcquire(clinicId, 'SAFETY_SWEEP')) {
                        // Task 133: reserva de prioridade do Global Sync tem motivo próprio
                        const blockReason = this.concurrencyGuard.getBlockReason(clinicId);
                        if (blockReason === 'GLOBAL_SYNC_PENDING') {
                            this.logger.warn(`[SAFETY-SWEEP] SWEEP_SKIPPED_GLOBAL_SYNC_PENDING clinicId=${clinicId} — Global Sync aguardando prioridade, varredura descartada`);
                            try { getDoctoraliaMetricsService()?.recordConcurrencySkip('SWEEP_SKIPPED_GLOBAL_SYNC_PENDING', clinicId); } catch (_e) {}
                            continue;
                        }
                        const blocker = concurrencyActorOf(blockReason ?? 'SAFETY_SWEEP');
                        this.logger.warn(`[SAFETY-SWEEP] SWEEP_SKIPPED_${blocker}_ACTIVE clinicId=${clinicId} — ${blocker} já em andamento, varredura descartada`);
                        try { getDoctoraliaMetricsService()?.recordConcurrencySkip(`SWEEP_SKIPPED_${blocker}_ACTIVE`, clinicId); } catch (_e) {}
                        continue;
                    }
                    try {
                        // Prioridade na fila de vazão: as ~dezenas de chamadas da varredura passam
                        // na frente das milhares do sync global (o teto de 400/5min é o mesmo).
                        const enqueued = await DocplannerClient.runWithPriority(() => this.sweepClinic(connections[i]));
                        totalEnqueued += enqueued;
                        clinicsSwept++;
                    } finally {
                        // WP-02 P2c: liberar guard em qualquer cenário
                        this.concurrencyGuard.release(clinicId, 'SAFETY_SWEEP');
                    }
                } catch (err: any) {
                    this.logger.warn(`[SAFETY-SWEEP] Falha na clínica ${clinicId}: ${err?.message}`);
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
     * Gatilho MANUAL (botão "Verificar Agora" da UI): responde imediatamente e roda a
     * varredura da clínica em background. A UI nunca espera a fila/vazão da Doctoralia.
     * Retorna false se já houver uma varredura manual em andamento para a clínica.
     */
    startManualSweep(conn: any): { started: boolean; reason?: string } {
        const clinicId = String(conn?.clinicId || '');
        if (!clinicId) return { started: false, reason: 'Conexão sem clínica associada' };
        const current = this.manualSweeps.get(clinicId);
        if (current?.running) {
            return { started: false, reason: 'Já existe uma verificação em andamento para esta clínica' };
        }
        this.manualSweeps.set(clinicId, { running: true, startedAt: new Date().toISOString() });
        this.logger.log(`[SAFETY-SWEEP] [MANUAL] Varredura em background iniciada para clínica ${clinicId}`);

        // Fire-and-forget com try/catch abrangente: NENHUMA falha aqui pode virar 500 na requisição.
        (async () => {
            // WP-02 P2c: Guard de concorrência — SKIP se Polling ativo para esta clínica
            if (this.concurrencyGuard.isActive(clinicId, 'POLLING')) {
                this.logger.warn(`[SAFETY-SWEEP] [MANUAL] SWEEP_SKIPPED_POLL_ACTIVE clinicId=${clinicId} — Polling em andamento, varredura manual descartada`);
                try { getDoctoraliaMetricsService()?.recordConcurrencySkip('SWEEP_SKIPPED_POLL_ACTIVE', clinicId); } catch (_e) {}
                this.manualSweeps.set(clinicId, {
                    running: false,
                    startedAt: this.manualSweeps.get(clinicId)?.startedAt || new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                    error: 'Polling em andamento para esta clínica — varredura manual descartada (tente novamente em instantes)',
                });
                return;
            }
            if (!this.concurrencyGuard.tryAcquire(clinicId, 'SAFETY_SWEEP')) {
                // Pode ocorrer quando o sweep automático adquiriu o guard entre o início do
                // fire-and-forget e esta linha. Resetar o estado para que a UI não fique travada.
                // Task 133: reserva de prioridade do Global Sync tem motivo próprio.
                const blockReason = this.concurrencyGuard.getBlockReason(clinicId);
                if (blockReason === 'GLOBAL_SYNC_PENDING') {
                    this.logger.warn(`[SAFETY-SWEEP] [MANUAL] SWEEP_SKIPPED_GLOBAL_SYNC_PENDING clinicId=${clinicId} — Global Sync aguardando prioridade, varredura manual descartada`);
                    try { getDoctoraliaMetricsService()?.recordConcurrencySkip('SWEEP_SKIPPED_GLOBAL_SYNC_PENDING', clinicId); } catch (_e) {}
                } else {
                    const blocker = concurrencyActorOf(blockReason ?? 'SAFETY_SWEEP');
                    this.logger.warn(`[SAFETY-SWEEP] [MANUAL] SWEEP_SKIPPED_${blocker}_ACTIVE clinicId=${clinicId} — ${blocker} em andamento, varredura manual descartada`);
                    try { getDoctoraliaMetricsService()?.recordConcurrencySkip(`SWEEP_SKIPPED_${blocker}_ACTIVE`, clinicId); } catch (_e) {}
                }
                this.manualSweeps.set(clinicId, {
                    running: false,
                    startedAt: this.manualSweeps.get(clinicId)?.startedAt || new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                    error: 'Outra execução em andamento para esta clínica — tente novamente em instantes',
                });
                return;
            }
            try {
                const enqueued = await DocplannerClient.runWithPriority(() => this.sweepClinic(conn));
                this.manualSweeps.set(clinicId, {
                    running: false,
                    startedAt: this.manualSweeps.get(clinicId)?.startedAt || new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                    enqueued,
                });
                this.logger.log(`[SAFETY-SWEEP] [MANUAL] Varredura da clínica ${clinicId} concluída: ${enqueued} booking(s) enfileirado(s).`);
            } catch (err: any) {
                this.logger.error(`[SAFETY-SWEEP] [MANUAL] Varredura da clínica ${clinicId} falhou: ${err?.message}`, err?.stack);
                this.manualSweeps.set(clinicId, {
                    running: false,
                    startedAt: this.manualSweeps.get(clinicId)?.startedAt || new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                    error: err?.message || 'Erro inesperado na verificação',
                });
            } finally {
                // WP-02 P2c: liberar guard em qualquer cenário
                this.concurrencyGuard.release(clinicId, 'SAFETY_SWEEP');
            }
        })();

        return { started: true };
    }

    /** Estado da última varredura manual da clínica (para a UI acompanhar via polling). */
    getManualSweepStatus(clinicId: string) {
        const s = this.manualSweeps.get(clinicId);
        if (!s) return { running: false };
        return s;
    }

    /**
     * Varre uma clínica: para cada médico Doctoralia vinculado (Mapping LINKED),
     * consulta os bookings em todos os endereços conhecidos e enfileira os desconhecidos.
     * Retorna o número de bookings enfileirados.
     */
    async sweepClinic(conn: any): Promise<number> {
        if (!conn?.clientId || !conn?.clientSecret) return 0;
        // WP-01: propagate SAFETY_SWEEP context for all Doctoralia calls within this sweep
        return runWithDoctoraliaContext({ origin: 'SAFETY_SWEEP', clinicId: conn.clinicId }, () => this._sweepClinicInner(conn));
    }

    private async _sweepClinicInner(conn: any): Promise<number> {
        const pairs = await this.collectDoctorAddressPairs(conn.clinicId);
        if (pairs.length === 0) {
            this.logger.debug(`[SAFETY-SWEEP] Clínica ${conn.clinicId}: nenhum médico vinculado com endereço conhecido.`);
            return 0;
        }

        // Bookings já conhecidos (idempotência primária, além da dedupKey da fila).
        // Guardamos também quais estão SEM nome de paciente (resgates antigos da varredura,
        // que enfileiravam sem os dados do paciente) para completar retroativamente.
        const knownRecords = await this.prisma.bookingSync.findMany({
            where: { clinicId: conn.clinicId, doctoraliaBookingId: { not: null } },
            select: { id: true, doctoraliaBookingId: true, origin: true, patientName: true },
        });
        const known = new Set(knownRecords.map(r => r.doctoraliaBookingId!));
        const nameless = new Map(
            knownRecords
                .filter(r => r.origin === 'DOCTORALIA' && !(r.patientName || '').trim())
                .map(r => [r.doctoraliaBookingId!, r.id]),
        );

        const client = this.docplannerService.createClient(
            conn.domain || 'doctoralia.com.br',
            conn.clientId,
            conn.clientSecret,
        );

        const { startIso, endIso } = this.horizonWindow();
        const jobs: Array<{ clinicId: string; type: string; payload: any; priority?: number; dedupKey?: string }> = [];
        const seenInSweep = new Set<string>();
        let backfillsThisCycle = 0;

        for (const pair of pairs) {
            if (this.isShuttingDown) break;
            try {
                await this.rateLimiter.acquire('doctoralia');
                const res = await client.getBookings(pair.facilityId, pair.doctorId, pair.addressId, startIso, endIso);
                const bookings = (res?._items || (Array.isArray(res) ? res : [])) as any[];
                if (!Array.isArray(bookings)) continue;

                for (const booking of bookings) {
                    const bid = booking?.id ? String(booking.id) : '';
                    if (!bid || seenInSweep.has(bid)) continue;

                    // Auto-correção retroativa: registro conhecido mas SEM nome do paciente
                    // (resgates antigos criados sem os dados do paciente).
                    if (known.has(bid)) {
                        // Limite por ciclo para não alongar a varredura; o restante fica para o próximo ciclo.
                        if (nameless.has(bid) && !this.isCancelled(booking) && backfillsThisCycle < 25) {
                            seenInSweep.add(bid);
                            backfillsThisCycle++;
                            await this.backfillPatientData(client, pair, bid, nameless.get(bid)!, booking);
                        }
                        continue;
                    }
                    if (this.isCancelled(booking)) continue;
                    seenInSweep.add(bid);

                    // A listagem de bookings pode vir sem os dados do paciente; buscar
                    // o detalhe do booking para que a criação na VisMed leve o nome.
                    if (!booking?.patient?.name) {
                        const detail = await this.fetchBookingDetail(client, pair, bid);
                        if (detail?.patient) booking.patient = detail.patient;
                    }

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
                // WP-08A: circuito Doctoralia aberto → skip controlado do RESTANTE do ciclo
                // (mesma semântica do SKIP do ClinicConcurrencyGuard). Não marca a
                // integração como error/disconnected; o alerta único vive na transição
                // para OPEN dentro do breaker — aqui apenas debug, não por par.
                if (isDoctoraliaCircuitOpenError(err)) {
                    this.logger.debug(`[SAFETY-SWEEP] Ciclo interrompido — circuito Doctoralia aberto (${err.message})`);
                    break;
                }
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

    /**
     * Busca o detalhe de um booking na Doctoralia (a listagem pode omitir os dados
     * do paciente). Falha de forma silenciosa: sem detalhe, o fluxo segue como antes.
     */
    private async fetchBookingDetail(client: any, pair: any, bookingId: string): Promise<any | null> {
        try {
            await this.rateLimiter.acquire('doctoralia');
            const res = await client.getBooking(pair.facilityId, pair.doctorId, pair.addressId, bookingId);
            return res?.visit_booking || res?._items?.[0] || res || null;
        } catch (err: any) {
            this.logger.warn(`[SAFETY-SWEEP] Falha ao buscar detalhe do booking ${bookingId}: ${err?.message}`);
            return null;
        }
    }

    /**
     * Completa retroativamente os dados do paciente em registros criados pela
     * varredura sem nome (resgates antigos). Atualiza só o BookingSync (painel);
     * o agendamento já criado na VisMed precisa ser completado manualmente lá.
     */
    private async backfillPatientData(client: any, pair: any, bookingId: string, bookingSyncId: string, listBooking: any) {
        let patient = listBooking?.patient;
        if (!patient?.name) {
            const detail = await this.fetchBookingDetail(client, pair, bookingId);
            patient = detail?.patient;
        }
        if (!patient?.name) return;

        try {
            await this.prisma.bookingSync.update({
                where: { id: bookingSyncId },
                data: {
                    patientName: patient.name || '',
                    patientSurname: patient.surname || '',
                    patientPhone: patient.phone ? String(patient.phone) : '',
                    patientEmail: patient.email || '',
                    patientCpf: patient.nin || '',
                },
            });
            this.logger.log(
                `[SAFETY-SWEEP] Nome do paciente completado retroativamente no booking ${bookingId}: "${`${patient.name} ${patient.surname || ''}`.trim()}"`,
            );
        } catch (err: any) {
            this.logger.warn(`[SAFETY-SWEEP] Falha ao completar paciente do booking ${bookingId}: ${err?.message}`);
        }
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
     * vinculados (Mapping DOCTOR LINKED), combinando duas fontes:
     * 1. conflictData do Mapping (facilityId + address.id enriquecidos no sync)
     * 2. DoctoraliaAddressService (endereços sincronizados do médico)
     *
     * BookingSync NÃO é usado como fonte: endereços históricos podem não
     * pertencer mais ao médico na Doctoralia e geravam 403 no getBookings.
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

        return pairs;
    }
}
