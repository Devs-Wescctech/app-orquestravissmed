import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerService } from '../integrations/docplanner.service';
import { VismedService } from '../integrations/vismed/vismed.service';
import { QueueService } from './queue.service';
import { RateLimiterService } from './rate-limiter.service';

const POLL_BASE_INTERVAL_MS = 30 * 1000;
const STAGGER_PER_CLINIC_MS = 2000;
const STARTUP_DELAY_MS = 5_000;

@Injectable()
export class BookingSyncService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(BookingSyncService.name);
    private clinicTimers: NodeJS.Timeout[] = [];
    private startupTimeout: NodeJS.Timeout | null = null;
    private isShuttingDown = false;

    constructor(
        private prisma: PrismaService,
        private docplannerService: DocplannerService,
        private vismedService: VismedService,
        private queueService: QueueService,
        private rateLimiter: RateLimiterService,
    ) {}

    // Normaliza qualquer status vindo da Doctoralia para detectar cancelamento de forma robusta
    // (lida com 'canceled', 'cancelled', 'CANCELLED', 'deleted' e flags cancelled_at/canceled_at).
    private isDoctoraliaCancelled(b: any): boolean {
        if (!b) return false;
        if (b.cancelled_at || b.canceled_at) return true;
        const s = String(b.status || '').toUpperCase();
        return s === 'CANCELED' || s === 'CANCELLED' || s === 'DELETED';
    }

    // Extrai data (YYYY-MM-DD) e hora (HH:mm) no fuso de Brasília independente do TZ do servidor.
    // Brasil não observa horário de verão desde 2019, mas usar IANA garante robustez futura.
    private extractBrtDateTime(date: Date): { dateStr: string; timeStr: string } {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Sao_Paulo',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(date).reduce<Record<string, string>>((acc, p) => {
            if (p.type !== 'literal') acc[p.type] = p.value;
            return acc;
        }, {});
        const hour = parts.hour === '24' ? '00' : parts.hour;
        return {
            dateStr: `${parts.year}-${parts.month}-${parts.day}`,
            timeStr: `${hour}:${parts.minute}`,
        };
    }

    onModuleInit() {
        this.registerJobHandlers();
        this.startStaggeredPolling();
    }

    onModuleDestroy() {
        this.isShuttingDown = true;
        this.clinicTimers.forEach(t => clearInterval(t));
        this.clinicTimers = [];
        if (this.startupTimeout) {
            clearTimeout(this.startupTimeout);
            this.startupTimeout = null;
        }
        this.logger.log('All polling intervals cleared on module destroy');
    }

    private registerJobHandlers() {
        this.queueService.registerHandler('slot-booked', async (payload, clinicId) => {
            await this.handleSlotBooked(clinicId, payload.data, payload.raw);
        });

        this.queueService.registerHandler('booking-canceled', async (payload, clinicId) => {
            await this.handleBookingCanceled(clinicId, payload.data, payload.raw);
        });

        this.queueService.registerHandler('booking-moved', async (payload, clinicId) => {
            await this.handleBookingMoved(clinicId, payload.data, payload.raw);
        });
    }

    private async startStaggeredPolling() {
        this.startupTimeout = setTimeout(async () => {
            await this.refreshPollingSchedule();

            const refreshTimer = setInterval(() => {
                if (!this.isShuttingDown) this.refreshPollingSchedule();
            }, 5 * 60 * 1000);
            this.clinicTimers.push(refreshTimer);
        }, STARTUP_DELAY_MS);
    }

    private polledClinicIds = new Set<string>();

    private async refreshPollingSchedule() {
        try {
            const connections = await this.prisma.integrationConnection.findMany({
                where: { provider: 'doctoralia', status: 'connected' },
            });

            const currentIds = new Set(connections.map(c => c.clinicId));

            for (const conn of connections) {
                if (this.polledClinicIds.has(conn.clinicId)) continue;

                const index = this.polledClinicIds.size;
                const stagger = index * STAGGER_PER_CLINIC_MS;
                const interval = POLL_BASE_INTERVAL_MS + (index * 2000);

                setTimeout(() => {
                    if (this.isShuttingDown) return;
                    this.pollClinic(conn);

                    const timer = setInterval(() => {
                        if (!this.isShuttingDown) this.pollClinic(conn);
                    }, interval);
                    this.clinicTimers.push(timer);
                }, stagger);

                this.polledClinicIds.add(conn.clinicId);
                this.logger.log(`[POLL] Added staggered polling for clinic ${conn.clinicId} (stagger=${stagger}ms, interval=${interval}ms)`);
            }

            if (connections.length === 0 && this.polledClinicIds.size === 0) {
                this.logger.debug('No active Doctoralia connections found');
            }

            // VisMed appointments polling (independent from Doctoralia)
            const vismedConns = await this.prisma.integrationConnection.findMany({
                where: { provider: 'vismed', status: 'connected' },
            });

            for (const vConn of vismedConns) {
                if (this.polledVismedClinicIds.has(vConn.clinicId)) continue;

                const index = this.polledVismedClinicIds.size;
                const stagger = 3000 + index * STAGGER_PER_CLINIC_MS;
                const interval = POLL_BASE_INTERVAL_MS + (index * 2000);

                setTimeout(() => {
                    if (this.isShuttingDown) return;
                    this.pollVismedClinic(vConn).catch(err =>
                        this.logger.warn(`[VISMED-POLL] First run error: ${err?.message || err}`),
                    );

                    const timer = setInterval(() => {
                        if (this.isShuttingDown) return;
                        this.pollVismedClinic(vConn).catch(err =>
                            this.logger.warn(`[VISMED-POLL] Periodic error: ${err?.message || err}`),
                        );
                    }, interval);
                    this.clinicTimers.push(timer);
                }, stagger);

                this.polledVismedClinicIds.add(vConn.clinicId);
                this.logger.log(`[VISMED-POLL] Added polling for clinic ${vConn.clinicId} (stagger=${stagger}ms, interval=${interval}ms)`);
            }
        } catch (err: any) {
            this.logger.error(`Failed to refresh polling schedule: ${err.message}`);
        }
    }

    private polledVismedClinicIds = new Set<string>();

    async pollVismedClinic(conn: any) {
        if (!conn.clientId) return;

        try {
            const idEmpresaGestora = Number(conn.clientId);
            if (!idEmpresaGestora) {
                this.logger.warn(`[VISMED-POLL] Invalid idEmpresaGestora for clinic ${conn.clinicId}`);
                return;
            }

            const baseUrl = conn.domain || undefined;
            const units = await this.prisma.vismedUnit.findMany({ where: { isActive: true } });
            if (units.length === 0) {
                this.logger.debug(`[VISMED-POLL] No active VismedUnit for clinic ${conn.clinicId}`);
                return;
            }

            // Janela: hoje -7d até hoje +60d (formato DD/MM/YYYY exigido pela VisMed)
            const today = new Date();
            const start = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
            const end = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);
            const fmt = (d: Date) => {
                const dd = String(d.getDate()).padStart(2, '0');
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                return `${dd}/${mm}/${d.getFullYear()}`;
            };
            const dataini = fmt(start);
            const datafim = fmt(end);

            let totalUpserts = 0;
            const seenVismedIds = new Set<string>();
            let fetchSuccess = true;

            for (const u of units) {
                try {
                    const agendamentos = await this.vismedService.getAgendamentos(
                        u.vismedId,
                        baseUrl,
                        { dataini, datafim },
                    );

                    if (!Array.isArray(agendamentos)) {
                        this.logger.warn(`[VISMED-POLL] Unit ${u.vismedId} returned non-array response, treating as fetch failure`);
                        fetchSuccess = false;
                        continue;
                    }

                    for (const a of agendamentos) {
                        const vid = a?.idpacienteagendamento ? String(a.idpacienteagendamento) : null;
                        if (vid) seenVismedIds.add(vid);
                        try {
                            const upserted = await this.upsertVismedAppointment(conn.clinicId, a);
                            if (upserted) totalUpserts++;
                        } catch (innerErr: any) {
                            this.logger.debug(`[VISMED-POLL] Skipping appointment: ${innerErr.message}`);
                        }
                    }
                } catch (uErr: any) {
                    this.logger.warn(`[VISMED-POLL] Unit ${u.vismedId} fetch failed: ${uErr.message}`);
                    fetchSuccess = false;
                }
            }

            this.logger.log(`[VISMED-POLL] Clinic ${conn.clinicId}: processed ${totalUpserts} VisMed appointments`);

            // Antes exigíamos seenVismedIds.size > 0, mas isso QUEBRAVA o caso legítimo de
            // "excluí o último agendamento da janela": a unidade volta vazia ([] com HTTP 200) e
            // o cancelamento nunca era propagado — o registro ficava BOOKED para sempre. Agora
            // basta que TODOS os fetches tenham tido sucesso (fetchSuccess). A re-confirmação
            // dentro do reconcile protege contra glitch de API que retorne lista vazia/parcial.
            if (fetchSuccess) {
                await this.reconcileDisappearedFromVismed(conn.clinicId, seenVismedIds, start, end, units, baseUrl, dataini, datafim).catch(err =>
                    this.logger.warn(`[RECONCILE-DISAPPEARED] Error: ${err.message}`),
                );
            }

            await this.reconcileUnlinkedWithDoctoralia(conn.clinicId).catch(err =>
                this.logger.warn(`[RECONCILE] Error: ${err.message}`),
            );

            await this.reconcileCancelledOnDoctoralia(conn.clinicId).catch(err =>
                this.logger.warn(`[RECONCILE-CANCEL] Error: ${err.message}`),
            );
        } catch (err: any) {
            this.logger.warn(`[VISMED-POLL] Error polling clinic ${conn.clinicId}: ${err.message}`);
        }
    }

    private async reconcileDisappearedFromVismed(
        clinicId: string,
        seenVismedIds: Set<string>,
        windowStart: Date,
        windowEnd: Date,
        units: any[],
        baseUrl: string | undefined,
        dataini: string,
        datafim: string,
    ) {
        const brtOffset = -3 * 60 * 60 * 1000;
        const dayStart = new Date(windowStart.getTime());
        dayStart.setUTCHours(0, 0, 0, 0);
        dayStart.setTime(dayStart.getTime() - brtOffset);
        const dayEnd = new Date(windowEnd.getTime());
        dayEnd.setUTCHours(23, 59, 59, 999);
        dayEnd.setTime(dayEnd.getTime() - brtOffset);

        const activeInWindow = await this.prisma.bookingSync.findMany({
            where: {
                clinicId,
                vismedAppointmentId: { not: null },
                status: { in: ['BOOKED', 'CONFIRMED'] },
                startAt: { gte: dayStart, lte: dayEnd },
            },
        });

        const disappeared = activeInWindow.filter(
            r => r.vismedAppointmentId && !seenVismedIds.has(r.vismedAppointmentId),
        );

        if (disappeared.length === 0) return;

        // Re-confirmação anti-glitch: a VisMed pode responder HTTP 200 com lista vazia/parcial
        // durante instabilidade. Cancelar é destrutivo (propaga p/ Doctoralia), então refazemos
        // UMA leitura de todas as unidades e só cancelamos quem CONTINUA ausente. Se qualquer
        // unidade falhar/não-array na reconfirmação, abortamos para não cancelar por engano.
        const confirmSeen = new Set<string>();
        for (const u of units) {
            try {
                const ags = await this.vismedService.getAgendamentos(u.vismedId, baseUrl, { dataini, datafim });
                if (!Array.isArray(ags)) {
                    this.logger.warn(`[RECONCILE-DISAPPEARED] reconfirmação unidade ${u.vismedId} não-array — abortando para evitar falso cancelamento`);
                    return;
                }
                for (const a of ags) {
                    const vid = a?.idpacienteagendamento ? String(a.idpacienteagendamento) : null;
                    if (vid) confirmSeen.add(vid);
                }
            } catch (err: any) {
                this.logger.warn(`[RECONCILE-DISAPPEARED] reconfirmação unidade ${u.vismedId} falhou (${err.message}) — abortando para evitar falso cancelamento`);
                return;
            }
        }

        const confirmedGone = disappeared.filter(
            r => r.vismedAppointmentId && !confirmSeen.has(r.vismedAppointmentId),
        );
        if (confirmedGone.length === 0) {
            this.logger.log(`[RECONCILE-DISAPPEARED] reconfirmação trouxe todos de volta — nenhum cancelamento (provável glitch transitório)`);
            return;
        }

        this.logger.log(
            `[RECONCILE-DISAPPEARED] ${confirmedGone.length} appointment(s) confirmados ausentes na VisMed para clínica ${clinicId}`,
        );

        const RECENT_MOVE_GRACE_MS = 5 * 60 * 1000;
        const now = Date.now();
        for (const rec of confirmedGone) {
            try {
                // Anti-race: se acabamos de mover este appt na VisMed (lastMoveBy=VISMED),
                // a VisMed às vezes faz cancel+create internamente — o vismedAppointmentId
                // antigo some e um novo aparece no horário-alvo. Tentamos primeiro adotar
                // o replacement; se não houver, aplicamos grace de 5 min para evitar
                // cancelar na Doctoralia um agendamento que o usuário acabou de remarcar.
                if (rec.lastMoveBy === 'VISMED' && rec.lastMoveAt && rec.lastMoveTargetStartAt) {
                    const adopted = await this.tryAdoptVismedReplacement(rec).catch(err => {
                        this.logger.warn(
                            `[RECONCILE-DISAPPEARED] adopt-replacement falhou para ${rec.vismedAppointmentId}: ${err.message}`,
                        );
                        return false;
                    });
                    if (adopted) continue;
                    if (now - rec.lastMoveAt.getTime() < RECENT_MOVE_GRACE_MS) {
                        this.logger.log(
                            `[RECONCILE-DISAPPEARED] SKIP vismedApptId=${rec.vismedAppointmentId} — VISMED move há ${Math.round((now - rec.lastMoveAt.getTime()) / 1000)}s, sem replacement (grace ${RECENT_MOVE_GRACE_MS / 1000}s)`,
                        );
                        continue;
                    }
                }
                this.logger.log(
                    `[RECONCILE-DISAPPEARED] vismedApptId=${rec.vismedAppointmentId} (BookingSync ${rec.id}) not in VisMed response — marking CANCELLED`,
                );
                const updated = await this.prisma.bookingSync.updateMany({
                    where: {
                        id: rec.id,
                        // Guard otimista: só cancela se o vismedAppointmentId ainda
                        // for o mesmo (não foi adotado por outro poll concorrente).
                        vismedAppointmentId: rec.vismedAppointmentId,
                        status: { in: ['BOOKED', 'CONFIRMED'] },
                    },
                    data: {
                        status: 'CANCELLED',
                        cancelledBy: 'VISMED',
                        cancelledAt: new Date(),
                        syncedToVismed: true,
                        syncedToDoctoralia: false,
                    },
                });
                if (updated.count === 0) {
                    this.logger.debug(
                        `[RECONCILE-DISAPPEARED] vismedApptId=${rec.vismedAppointmentId} already changed status, skipping propagation`,
                    );
                    continue;
                }
                await this.propagateVismedCancellationToDoctoralia(rec.id).catch(err =>
                    this.logger.warn(
                        `[RECONCILE-DISAPPEARED] propagate cancel failed for ${rec.vismedAppointmentId}: ${err.message}`,
                    ),
                );
                // Agendamentos origin=VISMED criam um BREAK (bloqueio) na Doctoralia em vez de
                // booking. O propagate acima só cancela bookings (precisa de doctoraliaBookingId).
                // Sem esta chamada, o break permanecia na agenda da Doctoralia mesmo após o
                // agendamento sumir da VisMed. syncDoctoraliaBreak apaga o break quando status=CANCELLED.
                await this.syncDoctoraliaBreak(rec.id).catch(err =>
                    this.logger.warn(
                        `[RECONCILE-DISAPPEARED] break delete failed for ${rec.vismedAppointmentId}: ${err.message}`,
                    ),
                );
            } catch (err: any) {
                this.logger.warn(
                    `[RECONCILE-DISAPPEARED] Error processing ${rec.vismedAppointmentId}: ${err.message}`,
                );
            }
        }
    }

    /**
     * Quando a VisMed faz cancel+create internamente em uma remarcação iniciada
     * pelo próprio VisMed, o vismedAppointmentId antigo some e um novo aparece
     * no horário-alvo (lastMoveTargetStartAt). Tentamos localizar esse
     * "replacement" e rebindar o BookingSync existente — preservando o
     * doctoraliaBookingId e evitando cancelar na Doctoralia.
     * Retorna true se adotou um replacement (pular cancelamento).
     */
    private async tryAdoptVismedReplacement(rec: {
        id: string;
        clinicId: string;
        vismedDoctorId: string | null;
        vismedAppointmentId: string | null;
        lastMoveAt: Date | null;
        lastMoveTargetStartAt: Date | null;
        startAt: Date;
    }): Promise<boolean> {
        if (!rec.vismedDoctorId || !rec.lastMoveTargetStartAt || !rec.lastMoveAt) return false;
        const tolMs = 2 * 60 * 1000;
        const target = rec.lastMoveTargetStartAt;
        // Freshness: candidato precisa ter sido criado em torno do moveAt (±10 min)
        // para evitar adotar um booking antigo não relacionado.
        const freshnessMs = 10 * 60 * 1000;
        const createdAfter = new Date(rec.lastMoveAt.getTime() - freshnessMs);

        const candidate = await this.prisma.bookingSync.findFirst({
            where: {
                clinicId: rec.clinicId,
                vismedDoctorId: rec.vismedDoctorId,
                vismedAppointmentId: { not: null },
                doctoraliaBookingId: null,
                status: { in: ['BOOKED', 'CONFIRMED'] },
                id: { not: rec.id },
                createdAt: { gte: createdAfter },
                startAt: {
                    gte: new Date(target.getTime() - tolMs),
                    lte: new Date(target.getTime() + tolMs),
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        if (!candidate || !candidate.vismedAppointmentId) return false;

        const newVid = candidate.vismedAppointmentId;
        const newStart = candidate.startAt;
        const newEnd = candidate.endAt;
        const oldVid = rec.vismedAppointmentId;

        // Interactive tx: re-lê o rec dentro da tx, valida invariantes
        // (vismedAppointmentId não mudou + ainda ativo) antes de mutar.
        // Garante que polls concorrentes não causem dupla adoção/cancel.
        try {
            await this.prisma.$transaction(async tx => {
                const fresh = await tx.bookingSync.findUnique({ where: { id: rec.id } });
                if (!fresh) throw new Error('rec desapareceu');
                if (fresh.vismedAppointmentId !== oldVid) {
                    throw new Error(`vismedAppointmentId mudou (${oldVid} → ${fresh.vismedAppointmentId})`);
                }
                if (fresh.status !== 'BOOKED' && fresh.status !== 'CONFIRMED') {
                    throw new Error(`status mudou (${fresh.status})`);
                }
                const cand = await tx.bookingSync.findUnique({ where: { id: candidate.id } });
                if (!cand || cand.vismedAppointmentId !== newVid) {
                    throw new Error('candidate mudou');
                }
                await tx.bookingSync.delete({ where: { id: candidate.id } });
                await tx.bookingSync.update({
                    where: { id: rec.id },
                    data: {
                        vismedAppointmentId: newVid,
                        startAt: newStart,
                        endAt: newEnd,
                        syncedToVismed: true,
                        syncError: null,
                        processedAt: new Date(),
                        lastMoveBy: null,
                        lastMoveAt: null,
                        lastMoveTargetStartAt: null,
                    },
                });
            });
        } catch (err: any) {
            this.logger.debug(
                `[RECONCILE-DISAPPEARED] adopt-replacement abortado para ${oldVid}: ${err.message}`,
            );
            return false;
        }

        this.logger.log(
            `[RECONCILE-DISAPPEARED] ADOPTED replacement: BookingSync ${rec.id} ` +
                `vismedApptId ${oldVid} → ${newVid} @ ${newStart.toISOString()}`,
        );
        return true;
    }

    /**
     * Espelho de tryAdoptVismedReplacement no lado Doctoralia. Quando a Doctoralia
     * faz cancel+create internamente em um moveBooking, o doctoraliaBookingId antigo
     * fica CANCELLED e um novo aparece ATIVO no horário-alvo. Tentamos adotar esse
     * novo id (rebind no rec existente) em vez de propagar o "cancel" para a VisMed.
     * Retorna true se adotou (pular cancelamento).
     */
    private async tryAdoptDoctoraliaReplacement(
        rec: {
            id: string;
            clinicId: string;
            doctoraliaDoctorId: string | null;
            doctoraliaAddressId: string | null;
            doctoraliaBookingId: string | null;
            patientName: string | null;
            patientPhone: string | null;
            lastMoveAt: Date | null;
            lastMoveTargetStartAt: Date | null;
        },
        liveActive: any[],
    ): Promise<boolean> {
        if (!rec.doctoraliaBookingId || !rec.lastMoveTargetStartAt || !rec.lastMoveAt) return false;
        const tolMs = 2 * 60 * 1000;
        const targetMs = rec.lastMoveTargetStartAt.getTime();
        const oldDocId = rec.doctoraliaBookingId;

        // Helper para fingerprint de paciente.
        const normPhone = (p: any): string => {
            const digits = String(p || '').replace(/\D/g, '');
            // Telefone forte: exige pelo menos 9 dígitos (DDD+8 ou número móvel BR completo).
            if (digits.length < 9) return '';
            return digits.slice(-9);
        };
        const normName = (n: any): string => {
            const s = String(n || '').trim().toLowerCase();
            if (!s || s.length < 4) return '';
            // Rejeita qualquer placeholder iniciado por "paciente" (paciente, paciente teste,
            // paciente123, pacientex, etc.).
            if (/^paciente/.test(s)) return '';
            return s;
        };
        const recPhone = normPhone(rec.patientPhone);
        const recName = normName(rec.patientName);

        // Adoção EXIGE fingerprint forte (telefone últimos 9 dígitos ou nome
        // não-genérico). Sem isso, abortamos e deixamos o grace + fluxo normal
        // de cancel decidirem — evita rebind a booking de outro paciente que
        // coincidentemente caiu no mesmo slot.
        if (!recPhone && !recName) {
            this.logger.debug(
                `[RECONCILE-CANCEL] adopt-skip ${oldDocId}: rec sem fingerprint forte de paciente`,
            );
            return false;
        }

        const candidate = liveActive.find((b: any) => {
            const bid = b?.id ? String(b.id) : null;
            if (!bid || bid === oldDocId) return false;
            const startStr = b?.start_at || b?.startAt;
            if (!startStr) return false;
            const t = new Date(startStr).getTime();
            if (Math.abs(t - targetMs) > tolMs) return false;
            const candPhone = normPhone(b?.patient?.phone);
            const candName = normName(b?.patient?.name);
            const phoneMatch = !!recPhone && !!candPhone && recPhone === candPhone;
            const nameMatch =
                !!recName &&
                !!candName &&
                (candName.includes(recName) || recName.includes(candName));
            return phoneMatch || nameMatch;
        });
        if (!candidate) return false;

        const newDocId = String(candidate.id);

        try {
            await this.prisma.$transaction(async tx => {
                const fresh = await tx.bookingSync.findUnique({ where: { id: rec.id } });
                if (!fresh) throw new Error('rec desapareceu');
                if (fresh.doctoraliaBookingId !== oldDocId) {
                    throw new Error(`doctoraliaBookingId mudou (${oldDocId} → ${fresh.doctoraliaBookingId})`);
                }
                if (fresh.status !== 'BOOKED' && fresh.status !== 'CONFIRMED' && fresh.status !== 'PROCESSING') {
                    throw new Error(`status mudou (${fresh.status})`);
                }
                // Re-verifica colisão DENTRO da tx e só remove se o registro
                // colisor parecer mesmo um órfão recém-criado pelo webhook
                // booking-moved (sem vismedAppointmentId, status ativo, criado
                // depois de lastMoveAt).
                const collision = await tx.bookingSync.findFirst({
                    where: {
                        clinicId: rec.clinicId,
                        doctoraliaBookingId: newDocId,
                        id: { not: rec.id },
                    },
                });
                if (collision) {
                    const isOrphanFromMove =
                        !collision.vismedAppointmentId &&
                        (collision.status === 'BOOKED' || collision.status === 'CONFIRMED' || collision.status === 'PROCESSING') &&
                        rec.lastMoveAt !== null &&
                        collision.createdAt.getTime() >= rec.lastMoveAt.getTime() - 60 * 1000;
                    if (!isOrphanFromMove) {
                        throw new Error(
                            `colisão com BookingSync ${collision.id} não-órfão (vismedApptId=${collision.vismedAppointmentId}, status=${collision.status})`,
                        );
                    }
                    await tx.bookingSync.delete({ where: { id: collision.id } });
                }
                await tx.bookingSync.update({
                    where: { id: rec.id },
                    data: {
                        doctoraliaBookingId: newDocId,
                        syncedToDoctoralia: true,
                        syncError: null,
                        processedAt: new Date(),
                        lastMoveBy: null,
                        lastMoveAt: null,
                        lastMoveTargetStartAt: null,
                    },
                });
            });
        } catch (err: any) {
            this.logger.debug(
                `[RECONCILE-CANCEL] adopt-replacement abortado para ${oldDocId}: ${err.message}`,
            );
            return false;
        }

        this.logger.log(
            `[RECONCILE-CANCEL] ADOPTED replacement: BookingSync ${rec.id} ` +
                `doctoraliaBookingId ${oldDocId} → ${newDocId}`,
        );
        return true;
    }

    private async reconcileUnlinkedWithDoctoralia(clinicId: string) {
        const unlinked = await this.prisma.bookingSync.findMany({
            where: {
                clinicId,
                doctoraliaBookingId: null,
                status: { in: ['BOOKED', 'CONFIRMED'] },
                doctoraliaDoctorId: { not: null },
                startAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
            },
        });

        if (unlinked.length === 0) return;

        const docConn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia', status: 'connected' },
        });
        if (!docConn?.clientId) return;

        const client = this.docplannerService.createClient(
            docConn.domain || 'doctoralia.com.br',
            docConn.clientId,
            docConn.clientSecret || '',
        );

        const doctorIds = [...new Set(unlinked.map(r => r.doctoraliaDoctorId!))];

        for (const doctorId of doctorIds) {
            const doctorUnlinked = unlinked.filter(r => r.doctoraliaDoctorId === doctorId);
            if (doctorUnlinked.length === 0) continue;

            const minStartDate = new Date(Math.min(...doctorUnlinked.map(r => r.startAt.getTime())) - 24 * 60 * 60 * 1000);
            const maxEndDate = new Date(Math.max(...doctorUnlinked.map(r => r.startAt.getTime())) + 24 * 60 * 60 * 1000);
            const toBrtIso = (d: Date) => {
                const offset = -3;
                const local = new Date(d.getTime() + offset * 60 * 60 * 1000);
                return local.toISOString().replace(/\.\d{3}Z$/, '-03:00');
            };
            const minStart = toBrtIso(minStartDate);
            const maxEnd = toBrtIso(maxEndDate);

            const addresses = await this.prisma.bookingSync.findMany({
                where: { clinicId, doctoraliaDoctorId: doctorId, doctoraliaAddressId: { not: null } },
                select: { doctoraliaAddressId: true, doctoraliaFacilityId: true },
                distinct: ['doctoraliaAddressId'],
            });

            for (const addr of addresses) {
                if (!addr.doctoraliaAddressId || !addr.doctoraliaFacilityId) continue;

                try {
                    await this.rateLimiter.acquire('doctoralia');
                    const res = await client.getBookings(
                        addr.doctoraliaFacilityId,
                        doctorId,
                        addr.doctoraliaAddressId,
                        minStart,
                        maxEnd,
                    );

                    const bookings = res?._items || (Array.isArray(res) ? res : []);
                    if (!Array.isArray(bookings) || bookings.length === 0) continue;

                    const alreadyLinked = new Set(
                        (await this.prisma.bookingSync.findMany({
                            where: { clinicId, doctoraliaBookingId: { not: null } },
                            select: { doctoraliaBookingId: true },
                        })).map(r => r.doctoraliaBookingId!),
                    );

                    for (const booking of bookings) {
                        const bid = String(booking.id || '');
                        if (!bid || alreadyLinked.has(bid)) continue;
                        if (this.isDoctoraliaCancelled(booking)) continue;

                        const bookingStart = new Date(booking.start_at);
                        const toleranceMs = 120 * 1000;

                        const match = doctorUnlinked.find(r =>
                            Math.abs(r.startAt.getTime() - bookingStart.getTime()) <= toleranceMs
                            && !r.doctoraliaBookingId,
                        );

                        if (match) {
                            await this.prisma.bookingSync.update({
                                where: { id: match.id },
                                data: {
                                    doctoraliaBookingId: bid,
                                    doctoraliaAddressId: addr.doctoraliaAddressId,
                                    doctoraliaFacilityId: addr.doctoraliaFacilityId,
                                    syncedToDoctoralia: true,
                                },
                            });
                            match.doctoraliaBookingId = bid;
                            alreadyLinked.add(bid);
                            this.logger.log(
                                `[RECONCILE] Linked BookingSync ${match.id} (vismedAppt=${match.vismedAppointmentId}) ↔ Doctoralia booking ${bid}`,
                            );
                        }
                    }
                } catch (err: any) {
                    this.logger.warn(`[RECONCILE] Failed fetching bookings for doctor ${doctorId}: ${err.message}`);
                }
            }
        }
    }

    private async reconcileCancelledOnDoctoralia(clinicId: string) {
        const linked = await this.prisma.bookingSync.findMany({
            where: {
                clinicId,
                doctoraliaBookingId: { not: null },
                status: { in: ['BOOKED', 'CONFIRMED', 'PROCESSING'] },
                startAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
            },
        });

        if (linked.length === 0) return;

        const docConn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia', status: 'connected' },
        });
        if (!docConn?.clientId) return;

        const client = this.docplannerService.createClient(
            docConn.domain || 'doctoralia.com.br',
            docConn.clientId,
            docConn.clientSecret || '',
        );

        const doctorIds = [...new Set(linked.map(r => r.doctoraliaDoctorId!).filter(Boolean))];

        for (const doctorId of doctorIds) {
            const doctorLinked = linked.filter(r => r.doctoraliaDoctorId === doctorId);
            if (doctorLinked.length === 0) continue;

            const minStartDate = new Date(Math.min(...doctorLinked.map(r => r.startAt.getTime())) - 24 * 60 * 60 * 1000);
            const maxEndDate = new Date(Math.max(...doctorLinked.map(r => r.startAt.getTime())) + 24 * 60 * 60 * 1000);
            const toBrtIso = (d: Date) => {
                const offset = -3;
                const local = new Date(d.getTime() + offset * 60 * 60 * 1000);
                return local.toISOString().replace(/\.\d{3}Z$/, '-03:00');
            };

            const addresses = await this.prisma.bookingSync.findMany({
                where: { clinicId, doctoraliaDoctorId: doctorId, doctoraliaAddressId: { not: null } },
                select: { doctoraliaAddressId: true, doctoraliaFacilityId: true },
                distinct: ['doctoraliaAddressId'],
            });

            for (const addr of addresses) {
                if (!addr.doctoraliaAddressId || !addr.doctoraliaFacilityId) continue;

                try {
                    await this.rateLimiter.acquire('doctoralia');
                    const res = await client.getBookings(
                        addr.doctoraliaFacilityId,
                        doctorId,
                        addr.doctoraliaAddressId,
                        toBrtIso(minStartDate),
                        toBrtIso(maxEndDate),
                    );

                    const liveBookings = (res?._items || (Array.isArray(res) ? res : [])) as any[];
                    const liveActive = (Array.isArray(liveBookings) ? liveBookings : [])
                        .filter((b: any) => !this.isDoctoraliaCancelled(b));
                    const liveIds = new Set(liveActive.map((b: any) => String(b.id)));

                    const cancelledIds = new Set(
                        (Array.isArray(liveBookings) ? liveBookings : [])
                            .filter((b: any) => this.isDoctoraliaCancelled(b))
                            .map((b: any) => String(b.id)),
                    );

                    for (const rec of doctorLinked) {
                        if (!rec.doctoraliaBookingId) continue;
                        if (rec.doctoraliaAddressId !== addr.doctoraliaAddressId) continue;
                        if (liveIds.has(rec.doctoraliaBookingId)) continue;

                        // Anti-race: depois de um moveBooking nosso (VisMed→Doctoralia), a Doctoralia
                        // faz cancel+create internamente — o ID antigo fica CANCELLED e um novo ID
                        // ativo aparece no horário-alvo. Sem proteção, propagamos esse "cancel" para
                        // a VisMed e excluímos o agendamento que o usuário acabou de remarcar.
                        if (rec.lastMoveBy === 'VISMED' && rec.lastMoveAt) {
                            // Tenta adoção apenas se temos target — sem target não dá pra
                            // identificar o replacement com segurança.
                            if (rec.lastMoveTargetStartAt) {
                                const adopted = await this.tryAdoptDoctoraliaReplacement(
                                    rec,
                                    liveActive,
                                ).catch(err => {
                                    this.logger.warn(
                                        `[RECONCILE-CANCEL] adopt-replacement falhou para ${rec.doctoraliaBookingId}: ${err.message}`,
                                    );
                                    return false;
                                });
                                if (adopted) continue;
                            }

                            // Grace de 10 min sempre vale enquanto lastMoveAt for recente —
                            // webhook booking-moved da Doctoralia pode atrasar bastante.
                            const RECONCILE_MOVE_GRACE_MS = 10 * 60 * 1000;
                            if (Date.now() - rec.lastMoveAt.getTime() < RECONCILE_MOVE_GRACE_MS) {
                                this.logger.debug(
                                    `[RECONCILE-CANCEL] SKIP ${rec.doctoraliaBookingId} — VISMED move há ${Math.round((Date.now() - rec.lastMoveAt.getTime()) / 1000)}s, sem replacement (grace ${RECONCILE_MOVE_GRACE_MS / 1000}s)`,
                                );
                                continue;
                            }
                        }

                        if (!cancelledIds.has(rec.doctoraliaBookingId)) {
                            this.logger.debug(
                                `[RECONCILE-CANCEL] Booking ${rec.doctoraliaBookingId} absent from API response (may be outside window or paginated), skipping`,
                            );
                            continue;
                        }

                        this.logger.log(
                            `[RECONCILE-CANCEL] Booking ${rec.doctoraliaBookingId} (BookingSync ${rec.id}) confirmed cancelled on Doctoralia, propagating to VisMed`,
                        );

                        try {
                            const updated = await this.prisma.bookingSync.updateMany({
                                where: {
                                    id: rec.id,
                                    // Guard otimista: só cancela se doctoraliaBookingId não foi
                                    // adotado/rebind por outro poll concorrente.
                                    doctoraliaBookingId: rec.doctoraliaBookingId,
                                    status: { in: ['BOOKED', 'CONFIRMED', 'PROCESSING'] },
                                },
                                data: {
                                    status: 'CANCELLED',
                                    cancelledBy: 'DOCTORALIA',
                                    cancelledAt: new Date(),
                                    syncedToVismed: false,
                                    processedAt: new Date(),
                                },
                            });
                            if (updated.count === 0) {
                                this.logger.debug(
                                    `[RECONCILE-CANCEL] ${rec.doctoraliaBookingId} já mudou (adopt/cancel concorrente), pulando propagação`,
                                );
                                continue;
                            }
                            await this.propagateDoctoraliaCancellationToVismed(rec.id);
                        } catch (err: any) {
                            this.logger.warn(`[RECONCILE-CANCEL] propagate failed for ${rec.doctoraliaBookingId}, will retry next cycle: ${err.message}`);
                        }
                    }
                } catch (err: any) {
                    this.logger.warn(`[RECONCILE-CANCEL] Failed checking bookings for doctor ${doctorId}: ${err.message}`);
                }
            }
        }
    }

    private async upsertVismedAppointment(clinicId: string, a: any): Promise<boolean> {
        const vismedAppointmentId = a?.idpacienteagendamento ? String(a.idpacienteagendamento) : null;
        const dataAg = a?.dataagendamento;
        const horaIni = a?.horarioagendamento;
        const horaFim = a?.horarioagendamentofinal;
        const idProf = a?.idprofissional;

        if (!vismedAppointmentId || !dataAg || !horaIni || !idProf) return false;

        const doctor = await this.prisma.vismedDoctor.findUnique({
            where: { vismedId: Number(idProf) },
        });

        // Resolve linked Doctoralia doctor so the appointment shows up when
        // the dashboard filters by doctoraliaDoctorId.
        let doctoraliaDoctorId: string | null = null;
        let doctoraliaFacilityId: string | null = null;
        if (doctor?.id) {
            const link = await this.prisma.professionalUnifiedMapping.findFirst({
                where: { vismedDoctorId: doctor.id, isActive: true },
                include: { doctoraliaDoctor: true },
            });
            if (link?.doctoraliaDoctor) {
                doctoraliaDoctorId = link.doctoraliaDoctor.doctoraliaDoctorId;
                doctoraliaFacilityId = link.doctoraliaDoctor.doctoraliaFacilityId;
            }
        }

        const startAt = new Date(`${dataAg}T${horaIni}:00-03:00`);
        if (isNaN(startAt.getTime())) {
            this.logger.warn(
                `[VISMED-POLL] Ignorando agendamento ${vismedAppointmentId}: data/hora inicial inválida (data=${dataAg}, hora=${horaIni})`,
            );
            return false;
        }
        let endAt = horaFim
            ? new Date(`${dataAg}T${horaFim}:00-03:00`)
            : new Date(startAt.getTime() + 30 * 60 * 1000);
        if (isNaN(endAt.getTime())) {
            this.logger.warn(
                `[VISMED-POLL] Agendamento ${vismedAppointmentId}: horário final inválido (horaFim=${horaFim}); usando fallback de +30min`,
            );
            endAt = new Date(startAt.getTime() + 30 * 60 * 1000);
        }

        const cancelado = a?.cancelado === '1' || a?.cancelado === 1 || a?.cancelado === true;
        const noShow = a?.naocompareceu === '1' || a?.naocompareceu === 1 || a?.naocompareceu === true;
        const confirmado = a?.confirmado === '1' || a?.confirmado === 1 || a?.confirmado === true;

        let status: 'BOOKED' | 'CANCELLED' | 'CONFIRMED' | 'NO_SHOW' = 'BOOKED';
        if (cancelado) status = 'CANCELLED';
        else if (noShow) status = 'NO_SHOW';
        else if (confirmado) status = 'CONFIRMED';

        const isDoctoraliaOnline = String(a?.agendamentoonline) === '1' && Number(a?.idpacienteagendamentocanal) === 2;
        const realOrigin: 'VISMED' | 'DOCTORALIA' = isDoctoraliaOnline ? 'DOCTORALIA' : 'VISMED';

        const patientName = a?.nomepaciente || a?.nome || `Paciente VisMed #${a?.idpaciente ?? ''}`.trim();
        const patientPhone = a?.telefonepaciente || a?.celularpaciente || a?.telefone1 || null;

        const durationMin = Math.max(
            5,
            Math.round((endAt.getTime() - startAt.getTime()) / 60000),
        );

        const existingByVismedId = await this.prisma.bookingSync.findUnique({
            where: { clinicId_vismedAppointmentId: { clinicId, vismedAppointmentId } },
        });

        const previousStatus = existingByVismedId?.status ?? null;
        const previousCancelledBy = existingByVismedId?.cancelledBy ?? null;
        const previousStartAt = existingByVismedId?.startAt ?? null;

        if (!existingByVismedId && doctor?.id) {
            const windowMs = 2 * 60 * 1000;
            const orphan = await this.prisma.bookingSync.findFirst({
                where: {
                    clinicId,
                    vismedAppointmentId: null,
                    OR: [
                        { vismedDoctorId: doctor.id },
                        ...(doctoraliaDoctorId ? [{ doctoraliaDoctorId }] : []),
                    ],
                    startAt: {
                        gte: new Date(startAt.getTime() - windowMs),
                        lte: new Date(startAt.getTime() + windowMs),
                    },
                },
                orderBy: { createdAt: 'desc' },
            });

            if (orphan) {
                const isDoctoralia = orphan.origin === 'DOCTORALIA';
                const updated = await this.prisma.bookingSync.update({
                    where: { id: orphan.id },
                    data: {
                        vismedAppointmentId,
                        status,
                        startAt,
                        endAt,
                        duration: durationMin,
                        rawPayload: a,
                        syncedToVismed: true,
                        processedAt: new Date(),
                    },
                });
                if (!isDoctoralia) {
                    await this.syncDoctoraliaBreak(updated.id).catch((err) =>
                        this.logger.warn(`[VISMED-POLL] break sync failed (orphan): ${err.message}`),
                    );
                } else {
                    this.logger.log(`[VISMED-POLL] Linked VisMed appt ${vismedAppointmentId} to DOCTORALIA record ${orphan.id} (no break needed)`);
                }
                if (status === 'CANCELLED') {
                    await this.propagateVismedCancellationToDoctoralia(updated.id).catch((err) =>
                        this.logger.warn(`[CANCEL-SYNC] propagate vismed→doctoralia failed (orphan): ${err.message}`),
                    );
                }
                return true;
            }

            // Reconcile reschedule órfão (Doctoralia→VisMed): caso o crash ocorra entre
            // createVismedAppointment e o update do vismedAppointmentId, este novo agendamento
            // chega no poll sem casar com nenhum BookingSync. Procuramos por um registro
            // recém-marcado como "in-progress" (lastMoveBy='DOCTORALIA' + lastMoveTargetStartAt
            // próximo) e ainda sem vismedAppointmentId atualizado.
            // Janelas conservadoras (15min/±30s) para reduzir risco de match cruzado entre
            // reschedules concorrentes do mesmo doutor.
            const reschedOrphanWhere = {
                clinicId,
                vismedDoctorId: doctor.id,
                lastMoveBy: 'DOCTORALIA',
                lastMoveAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
                lastMoveTargetStartAt: {
                    gte: new Date(startAt.getTime() - 30 * 1000),
                    lte: new Date(startAt.getTime() + 30 * 1000),
                },
                NOT: { vismedAppointmentId },
            };
            const reschedCandidates = await this.prisma.bookingSync.findMany({
                where: reschedOrphanWhere,
                orderBy: { lastMoveAt: 'desc' },
                take: 2,
            });
            if (reschedCandidates.length > 1) {
                this.logger.warn(
                    `[VISMED-POLL] reschedule-orphan AMBIGUO: ${reschedCandidates.length} candidatos para vismedAppointmentId=${vismedAppointmentId} doctor=${doctor.id} startAt=${startAt.toISOString()} — pegando o mais recente (id=${reschedCandidates[0].id})`,
                );
            }
            const reschedOrphan = reschedCandidates[0] ?? null;
            if (reschedOrphan) {
                this.logger.log(
                    `[VISMED-POLL] reschedule-orphan reconcile: BookingSync ${reschedOrphan.id} (apptIdAntigo=${reschedOrphan.vismedAppointmentId}) ↔ novo vismedAppointmentId=${vismedAppointmentId}`,
                );
                const updated = await this.prisma.bookingSync.update({
                    where: { id: reschedOrphan.id },
                    data: {
                        vismedAppointmentId,
                        status,
                        startAt,
                        endAt,
                        duration: durationMin,
                        rawPayload: a,
                        syncedToVismed: true,
                        syncError: null,
                        processedAt: new Date(),
                    },
                });
                await this.syncDoctoraliaBreak(updated.id).catch((err) =>
                    this.logger.warn(`[VISMED-POLL] break sync failed (reschedule-orphan): ${err.message}`),
                );
                return true;
            }
        }

        // Só procuramos um registro DOCTORALIA "solto" para vincular se este vismedAppointmentId
        // ainda não tem dono. Caso contrário, o upsert abaixo (key clinicId_vismedAppointmentId)
        // já vai atualizar a row correta — tentar gravar o mesmo vismedAppointmentId em outra
        // row violaria a unique constraint (clinicId, vismedAppointmentId).
        const existingDoctoralia = !existingByVismedId
            ? await this.prisma.bookingSync.findFirst({
                where: {
                    clinicId,
                    origin: 'DOCTORALIA',
                    vismedAppointmentId: null,
                    ...(doctoraliaDoctorId ? { doctoraliaDoctorId } : { vismedDoctorId: doctor?.id || undefined }),
                    startAt: {
                        gte: new Date(startAt.getTime() - 2 * 60 * 1000),
                        lte: new Date(startAt.getTime() + 2 * 60 * 1000),
                    },
                    status: { not: 'CANCELLED' },
                },
            })
            : null;

        if (existingDoctoralia) {
            const updated = await this.prisma.bookingSync.update({
                where: { id: existingDoctoralia.id },
                data: {
                    vismedAppointmentId,
                    vismedDoctorId: doctor?.id || null,
                    status,
                    startAt,
                    endAt,
                    duration: durationMin,
                    rawPayload: a,
                    syncedToVismed: true,
                    processedAt: new Date(),
                },
            });
            this.logger.log(`[VISMED-POLL] Linked VisMed appt ${vismedAppointmentId} to existing DOCTORALIA record ${existingDoctoralia.id} (docBookingId=${existingDoctoralia.doctoraliaBookingId})`);
            if (status === 'CANCELLED') {
                await this.propagateVismedCancellationToDoctoralia(updated.id).catch((err) =>
                    this.logger.warn(`[CANCEL-SYNC] propagate vismed→doctoralia failed: ${err.message}`),
                );
            }
            return true;
        }

        const pendingCancelFromDoctoralia = existingByVismedId
            && existingByVismedId.status === 'CANCELLED'
            && existingByVismedId.cancelledBy === 'DOCTORALIA'
            && !existingByVismedId.syncedToVismed;

        if (pendingCancelFromDoctoralia) {
            this.logger.log(
                `[VISMED-POLL] Pending cancellation for ${vismedAppointmentId} — propagating to VisMed now`,
            );
            await this.propagateDoctoraliaCancellationToVismed(existingByVismedId!.id).catch((err) =>
                this.logger.warn(`[VISMED-POLL] cancel propagation failed for ${vismedAppointmentId}: ${err.message}`),
            );
            return true;
        }

        const effectiveStatus = existingByVismedId?.status === 'CANCELLED' && existingByVismedId?.cancelledBy
            ? 'CANCELLED'
            : status;

        const upserted = await this.prisma.bookingSync.upsert({
            where: { clinicId_vismedAppointmentId: { clinicId, vismedAppointmentId } },
            create: {
                clinicId,
                vismedAppointmentId,
                vismedDoctorId: doctor?.id || null,
                doctoraliaDoctorId,
                doctoraliaFacilityId,
                origin: realOrigin,
                status,
                patientName: String(patientName).slice(0, 200),
                patientPhone: patientPhone ? String(patientPhone) : null,
                startAt,
                endAt,
                duration: durationMin,
                rawPayload: a,
                syncedToVismed: true,
                syncedToDoctoralia: realOrigin === 'DOCTORALIA',
                processedAt: new Date(),
            },
            update: {
                status: effectiveStatus,
                vismedDoctorId: doctor?.id || null,
                doctoraliaDoctorId,
                doctoraliaFacilityId,
                startAt,
                endAt,
                duration: durationMin,
                rawPayload: a,
                syncedToVismed: true,
                processedAt: new Date(),
                ...(realOrigin === 'DOCTORALIA'
                    ? { origin: 'DOCTORALIA', syncedToDoctoralia: true }
                    : (existingByVismedId && (
                        existingByVismedId.startAt.getTime() !== startAt.getTime() ||
                        existingByVismedId.endAt.getTime() !== endAt.getTime()
                    ) ? { syncedToDoctoralia: false } : {})),
            },
        });

        if (realOrigin === 'VISMED' && upserted.origin === 'VISMED') {
            await this.syncDoctoraliaBreak(upserted.id).catch((err) =>
                this.logger.warn(`[VISMED-POLL] break sync failed: ${err.message}`),
            );
        } else if (realOrigin === 'DOCTORALIA') {
            this.logger.debug(`[VISMED-POLL] DOCTORALIA-origin appointment ${vismedAppointmentId} — no break needed`);
        }

        // Sempre que o status for CANCELLED, tentar propagar para a Doctoralia.
        // O helper é idempotente: faz no-op se já foi cancelado por nós/Doctoralia ou
        // se já está marcado como sincronizado. Em caso de falha anterior (syncedToDoctoralia=false),
        // a próxima rodada de poll re-tentará automaticamente.
        void previousStatus; void previousCancelledBy;
        if (status === 'CANCELLED') {
            await this.propagateVismedCancellationToDoctoralia(upserted.id).catch((err) =>
                this.logger.warn(`[CANCEL-SYNC] propagate vismed→doctoralia failed: ${err.message}`),
            );
        }

        // Detecta reagendamento: mesmo agendamento mudou de horário (sem ter sido cancelado).
        // Propaga para a Doctoralia via moveBooking. Anti-eco fica dentro do helper.
        const startChanged = previousStartAt && previousStartAt.getTime() !== startAt.getTime();
        const isLiveStatus = status === 'BOOKED' || status === 'CONFIRMED';
        if (startChanged && isLiveStatus) {
            this.logger.log(
                `[RESCHEDULE-SYNC] VisMed apptId=${vismedAppointmentId} mudou de ${previousStartAt!.toISOString()} → ${startAt.toISOString()}`,
            );
            await this.propagateVismedRescheduleToDoctoralia(upserted.id, previousStartAt!).catch((err) =>
                this.logger.warn(`[RESCHEDULE-SYNC] propagate vismed→doctoralia failed: ${err.message}`),
            );
        }

        return true;
    }

    /**
     * Cancela na Doctoralia um booking que foi cancelado na VisMed.
     * Idempotente: trata 404 como sucesso (já cancelado).
     */
    private async propagateVismedCancellationToDoctoralia(syncId: string): Promise<void> {
        const rec = await this.prisma.bookingSync.findUnique({ where: { id: syncId } });
        if (!rec) return;
        if (rec.status !== 'CANCELLED') return;
        // Anti-loop: se o cancelamento original veio da Doctoralia ou de nós cancelando lá,
        // não devemos chamar cancelBooking de novo na Doctoralia.
        if (rec.cancelledBy === 'DOCTORALIA' || rec.cancelledBy === 'INTEGRATION') {
            this.logger.debug(`[CANCEL-SYNC] booking ${syncId} já cancelado por ${rec.cancelledBy}, skip eco vismed→doctoralia`);
            return;
        }
        // Já sincronizado com sucesso no passado: nada a fazer.
        if (rec.syncedToDoctoralia && rec.cancelledBy === 'VISMED') {
            this.logger.debug(`[CANCEL-SYNC] booking ${syncId} já propagado para Doctoralia, skip`);
            return;
        }
        if (!rec.doctoraliaBookingId || !rec.doctoraliaFacilityId || !rec.doctoraliaDoctorId || !rec.doctoraliaAddressId) {
            this.logger.debug(`[CANCEL-SYNC] booking ${syncId} sem vínculo Doctoralia, nada a cancelar lá`);
            await this.prisma.bookingSync.update({
                where: { id: syncId },
                data: { cancelledBy: 'VISMED', cancelledAt: rec.cancelledAt ?? new Date() },
            });
            return;
        }

        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId: rec.clinicId, provider: 'doctoralia', status: 'connected' },
        });
        if (!conn || !conn.clientId) {
            this.logger.warn(`[CANCEL-SYNC] sem conexão Doctoralia para clínica ${rec.clinicId}`);
            return;
        }

        const client = this.docplannerService.createClient(
            conn.domain || 'doctoralia.com.br',
            conn.clientId,
            conn.clientSecret || '',
        );

        try {
            this.logger.log(
                `[CANCEL-SYNC] VisMed→Doctoralia: cancelando booking ${rec.doctoraliaBookingId} (clinic=${rec.clinicId}, vismedApptId=${rec.vismedAppointmentId})`,
            );
            await client.cancelBooking(
                rec.doctoraliaFacilityId,
                rec.doctoraliaDoctorId,
                rec.doctoraliaAddressId,
                rec.doctoraliaBookingId,
                'Cancelado via integração VisMed↔Doctoralia',
            );
            await this.prisma.bookingSync.update({
                where: { id: syncId },
                data: {
                    cancelledBy: 'VISMED',
                    cancelledAt: rec.cancelledAt ?? new Date(),
                    syncedToDoctoralia: true,
                    syncError: null,
                    processedAt: new Date(),
                },
            });
            this.logger.log(`[CANCEL-SYNC] OK booking ${rec.doctoraliaBookingId} cancelado na Doctoralia`);
        } catch (err: any) {
            const msg = err?.message || String(err);
            const status = err?.status || err?.response?.status;
            const is404 = status === 404 || /\b404\b/.test(msg) || /not.*found/i.test(msg);
            if (is404) {
                this.logger.log(`[CANCEL-SYNC] booking ${rec.doctoraliaBookingId} já não existe na Doctoralia (404), marcando como sincronizado`);
                await this.prisma.bookingSync.update({
                    where: { id: syncId },
                    data: {
                        cancelledBy: 'VISMED',
                        cancelledAt: rec.cancelledAt ?? new Date(),
                        syncedToDoctoralia: true,
                        syncError: null,
                        processedAt: new Date(),
                    },
                });
                return;
            }
            this.logger.error(`[CANCEL-SYNC] FALHA ao cancelar ${rec.doctoraliaBookingId} na Doctoralia: ${msg}`);
            await this.prisma.bookingSync.update({
                where: { id: syncId },
                data: { syncError: `cancel→doctoralia: ${msg}`.slice(0, 500) },
            });
        }
    }

    /**
     * Cancela na VisMed um booking que foi cancelado na Doctoralia.
     * Idempotente: trata 404/inexistente como sucesso.
     */
    private async propagateDoctoraliaCancellationToVismed(syncId: string): Promise<void> {
        const rec = await this.prisma.bookingSync.findUnique({ where: { id: syncId } });
        if (!rec) return;
        if (rec.status !== 'CANCELLED') return;
        // Anti-loop: se o cancelamento original veio da VisMed ou de nós cancelando lá,
        // não devemos chamar delete-agendamento de novo na VisMed.
        if (rec.cancelledBy === 'VISMED' || rec.cancelledBy === 'INTEGRATION') {
            this.logger.debug(`[CANCEL-SYNC] booking ${syncId} já cancelado por ${rec.cancelledBy}, skip eco doctoralia→vismed`);
            return;
        }
        if (rec.syncedToVismed && rec.cancelledBy === 'DOCTORALIA') {
            this.logger.debug(`[CANCEL-SYNC] booking ${syncId} já propagado para VisMed, skip`);
            return;
        }
        if (!rec.vismedAppointmentId) {
            this.logger.debug(`[CANCEL-SYNC] booking ${syncId} sem vismedAppointmentId, nada a cancelar lá`);
            await this.prisma.bookingSync.update({
                where: { id: syncId },
                data: { cancelledBy: 'DOCTORALIA', cancelledAt: rec.cancelledAt ?? new Date() },
            });
            return;
        }

        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId: rec.clinicId, provider: 'vismed', status: 'connected' },
        });
        const baseUrl = conn?.domain || undefined;

        try {
            this.logger.log(
                `[CANCEL-SYNC] Doctoralia→VisMed: cancelando agendamento ${rec.vismedAppointmentId} (clinic=${rec.clinicId}, doctoraliaBookingId=${rec.doctoraliaBookingId})`,
            );
            await this.vismedService.cancelarAgendamento(rec.vismedAppointmentId, baseUrl);
            await this.prisma.bookingSync.update({
                where: { id: syncId },
                data: {
                    cancelledBy: 'DOCTORALIA',
                    cancelledAt: rec.cancelledAt ?? new Date(),
                    syncedToVismed: true,
                    syncError: null,
                    processedAt: new Date(),
                },
            });
            this.logger.log(`[CANCEL-SYNC] OK agendamento ${rec.vismedAppointmentId} cancelado na VisMed`);
        } catch (err: any) {
            const msg = err?.message || String(err);
            const status = err?.status || err?.response?.status;
            const is404 = status === 404 || /\b404\b/.test(msg) || /not.*found|inexist/i.test(msg);
            if (is404) {
                this.logger.log(`[CANCEL-SYNC] agendamento ${rec.vismedAppointmentId} já não existe na VisMed, marcando como sincronizado`);
                await this.prisma.bookingSync.update({
                    where: { id: syncId },
                    data: {
                        cancelledBy: 'DOCTORALIA',
                        cancelledAt: rec.cancelledAt ?? new Date(),
                        syncedToVismed: true,
                        syncError: null,
                        processedAt: new Date(),
                    },
                });
                return;
            }
            this.logger.error(`[CANCEL-SYNC] FALHA ao cancelar ${rec.vismedAppointmentId} na VisMed: ${msg}`);
            await this.prisma.bookingSync.update({
                where: { id: syncId },
                data: { syncError: `cancel→vismed: ${msg}`.slice(0, 500) },
            });
        }
    }

    private static readonly RESCHEDULE_ECO_WINDOW_MS = 5 * 60 * 1000;

    /**
     * Detecta eco de reagendamento: se nós acabamos de mover este booking para esse
     * mesmo horário-alvo há menos de 5 minutos, a "mudança" detectada agora é apenas
     * a outra ponta do espelho repetindo o estado.
     */
    private isRescheduleEco(rec: { lastMoveAt: Date | null; lastMoveTargetStartAt: Date | null }, novoStartAt: Date): boolean {
        if (!rec.lastMoveAt || !rec.lastMoveTargetStartAt) return false;
        const fresh = Date.now() - rec.lastMoveAt.getTime() < BookingSyncService.RESCHEDULE_ECO_WINDOW_MS;
        const sameTarget = rec.lastMoveTargetStartAt.getTime() === novoStartAt.getTime();
        return fresh && sameTarget;
    }

    /**
     * Propaga reagendamento VisMed → Doctoralia via DocplannerClient.moveBooking.
     * Premissas:
     *  - médico NÃO muda (assumido pelo produto).
     *  - se booking não existe mais na Doctoralia (404), marcamos sincronizado e seguimos.
     *  - antes da chamada, verifica anti-eco (mudança causada por nós próprios).
     */
    private async propagateVismedRescheduleToDoctoralia(syncId: string, previousStartAt: Date): Promise<void> {
        const rec = await this.prisma.bookingSync.findUnique({ where: { id: syncId } });
        if (!rec) return;
        if (rec.status === 'CANCELLED') return;
        if (!rec.doctoraliaBookingId || !rec.doctoraliaFacilityId || !rec.doctoraliaDoctorId || !rec.doctoraliaAddressId) {
            this.logger.debug(`[RESCHEDULE-SYNC] booking ${syncId} sem vínculo Doctoralia, nada a propagar`);
            return;
        }
        if (this.isRescheduleEco(rec, rec.startAt)) {
            this.logger.debug(`[RESCHEDULE-SYNC] eco detectado vismed→doctoralia (booking ${syncId}), skip`);
            return;
        }
        if (rec.startAt.getTime() < Date.now() - 60_000) {
            this.logger.warn(`[RESCHEDULE-SYNC] novo horário ${rec.startAt.toISOString()} é no passado, abortando propagação`);
            await this.prisma.bookingSync.update({
                where: { id: syncId },
                data: { syncError: `reschedule→doctoralia: novo horário no passado`.slice(0, 500) },
            });
            return;
        }
        if (!rec.addressServiceId) {
            this.logger.warn(`[RESCHEDULE-SYNC] booking ${syncId} sem addressServiceId, não dá para mover na Doctoralia`);
            await this.prisma.bookingSync.update({
                where: { id: syncId },
                data: { syncError: `reschedule→doctoralia: missing addressServiceId`.slice(0, 500) },
            });
            return;
        }

        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId: rec.clinicId, provider: 'doctoralia', status: 'connected' },
        });
        if (!conn || !conn.clientId) {
            this.logger.warn(`[RESCHEDULE-SYNC] sem conexão Doctoralia para clínica ${rec.clinicId}`);
            return;
        }

        const client = this.docplannerService.createClient(
            conn.domain || 'doctoralia.com.br',
            conn.clientId,
            conn.clientSecret || '',
        );

        const { dateStr, timeStr } = this.extractBrtDateTime(rec.startAt);
        const startStr = `${dateStr}T${timeStr}:00-03:00`;
        const duration = rec.duration ?? Math.max(5, Math.round((rec.endAt.getTime() - rec.startAt.getTime()) / 60000));
        const addressServiceId = parseInt(rec.addressServiceId, 10);
        if (!addressServiceId) {
            this.logger.warn(`[RESCHEDULE-SYNC] addressServiceId inválido (${rec.addressServiceId})`);
            return;
        }

        // Anti-eco PREVENTIVO: marca a intenção antes da chamada externa, assim o webhook
        // booking-moved que volta como confirmação já encontra o flag.
        await this.prisma.bookingSync.update({
            where: { id: syncId },
            data: {
                lastMoveBy: 'VISMED',
                lastMoveAt: new Date(),
                lastMoveTargetStartAt: rec.startAt,
            },
        });

        try {
            this.logger.log(
                `[RESCHEDULE-SYNC] VisMed→Doctoralia: moveBooking ${rec.doctoraliaBookingId} de ${previousStartAt.toISOString()} → ${rec.startAt.toISOString()}`,
            );
            await client.moveBooking(rec.doctoraliaFacilityId, rec.doctoraliaDoctorId, rec.doctoraliaAddressId, rec.doctoraliaBookingId, {
                address_service_id: addressServiceId,
                duration,
                start: startStr,
            });
            await this.prisma.bookingSync.update({
                where: { id: syncId },
                data: {
                    status: 'BOOKED',
                    syncedToDoctoralia: true,
                    syncError: null,
                    processedAt: new Date(),
                },
            });
            this.logger.log(`[RESCHEDULE-SYNC] OK booking ${rec.doctoraliaBookingId} movido na Doctoralia`);
        } catch (err: any) {
            const msg = err?.message || String(err);
            const status = err?.status || err?.response?.status;
            const is404 = status === 404 || /\b404\b/.test(msg) || /not.*found/i.test(msg);
            if (is404) {
                this.logger.log(`[RESCHEDULE-SYNC] booking ${rec.doctoraliaBookingId} não existe mais na Doctoralia (404), marcando como sincronizado`);
                await this.prisma.bookingSync.update({
                    where: { id: syncId },
                    data: {
                        status: 'BOOKED',
                        syncedToDoctoralia: true,
                        syncError: null,
                        processedAt: new Date(),
                    },
                });
                return;
            }
            this.logger.error(`[RESCHEDULE-SYNC] FALHA ao mover ${rec.doctoraliaBookingId} na Doctoralia: ${msg}`);
            await this.prisma.bookingSync.update({
                where: { id: syncId },
                data: {
                    syncedToDoctoralia: false,
                    syncError: `reschedule→doctoralia: ${msg}`.slice(0, 500),
                },
            });
        }
    }

    /**
     * Propaga reagendamento Doctoralia → VisMed. Como a VisMed NÃO tem endpoint de
     * mover, fazemos: (1) cria novo agendamento no horário novo, (2) cancela o velho.
     * Ordem: criar primeiro evita perder o booking se a criação falhar (no pior caso
     * temos duplicação temporária com o mesmo médico — anti-eco do cancel pega o velho).
     */
    private async propagateDoctoraliaRescheduleToVismed(syncId: string, previousVismedAppointmentId: string | null): Promise<void> {
        const rec = await this.prisma.bookingSync.findUnique({ where: { id: syncId } });
        if (!rec) return;
        if (rec.status === 'CANCELLED') return;
        if (!rec.vismedDoctorId) {
            this.logger.debug(`[RESCHEDULE-SYNC] booking ${syncId} sem vismedDoctorId, nada a propagar`);
            return;
        }
        if (this.isRescheduleEco(rec, rec.startAt)) {
            this.logger.debug(`[RESCHEDULE-SYNC] eco detectado doctoralia→vismed (booking ${syncId}), skip`);
            return;
        }
        if (rec.startAt.getTime() < Date.now() - 60_000) {
            this.logger.warn(`[RESCHEDULE-SYNC] novo horário ${rec.startAt.toISOString()} é no passado, abortando propagação`);
            await this.prisma.bookingSync.update({
                where: { id: syncId },
                data: { syncError: `reschedule→vismed: novo horário no passado`.slice(0, 500) },
            });
            return;
        }

        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId: rec.clinicId, provider: 'vismed', status: 'connected' },
        });
        if (!conn || !conn.clientId) {
            this.logger.warn(`[RESCHEDULE-SYNC] sem conexão VisMed para clínica ${rec.clinicId}`);
            return;
        }

        // Reusa o construtor de payload do createVismedAppointment, simulando o objeto booking.
        const fakeBooking: any = {
            id: rec.doctoraliaBookingId || `local-${rec.id}`,
            start_at: rec.startAt.toISOString(),
            patient: {
                name: rec.patientName,
                surname: rec.patientSurname,
                phone: rec.patientPhone,
                nin: rec.patientCpf,
                birth_date: rec.patientBirthDate,
                gender: rec.patientGender,
            },
        };
        const fakeMapping: any = { vismedId: rec.vismedDoctorId };

        // Anti-eco PREVENTIVO + sinaliza intenção de move (em caso de crash, próximo poll
        // pode reconciliar). Marca syncError como 'in-progress' para diagnóstico.
        await this.prisma.bookingSync.update({
            where: { id: syncId },
            data: {
                lastMoveBy: 'DOCTORALIA',
                lastMoveAt: new Date(),
                lastMoveTargetStartAt: rec.startAt,
                syncError: `reschedule→vismed: in-progress (apptIdAntigo=${previousVismedAppointmentId ?? 'null'})`.slice(0, 500),
            },
        });

        let novoIdpacienteagendamento: string | null = null;
        try {
            this.logger.log(
                `[RESCHEDULE-SYNC] Doctoralia→VisMed: criando novo agendamento em ${rec.startAt.toISOString()} (substitui apptId=${previousVismedAppointmentId})`,
            );
            const created = await this.createVismedAppointment(rec.clinicId, fakeMapping, fakeBooking, null);
            const novoId = (created as any)?.idpacienteagendamento || (created as any)?.id || (created as any)?.idPacienteAgendamento;
            if (novoId) novoIdpacienteagendamento = String(novoId);
            this.logger.log(`[RESCHEDULE-SYNC] Novo agendamento VisMed criado: id=${novoIdpacienteagendamento ?? '(não retornado)'}`);
        } catch (err: any) {
            const msg = err?.message || String(err);
            this.logger.error(`[RESCHEDULE-SYNC] FALHA ao criar novo agendamento VisMed: ${msg}`);
            await this.prisma.bookingSync.update({
                where: { id: syncId },
                data: {
                    syncedToVismed: false,
                    syncError: `reschedule→vismed (create): ${msg}`.slice(0, 500),
                },
            });
            return; // não cancela o velho se a criação falhou
        }

        // PASSO 1: persiste o novo vismedAppointmentId IMEDIATAMENTE após o create,
        // antes de cancelar o velho. Se cair entre create e este update, ainda perdemos
        // a referência — mitigado pelo orphan reconcile (vide upsertVismedAppointment).
        if (novoIdpacienteagendamento) {
            await this.prisma.bookingSync.update({
                where: { id: syncId },
                data: { vismedAppointmentId: novoIdpacienteagendamento },
            });
        }

        // PASSO 2: cancela o agendamento antigo. Falha aqui é menos grave — o novo
        // agendamento já existe — mas mantemos o erro persistido em syncError para
        // intervenção manual / monitoramento (não há retry automático do cancel ainda).
        let pendingCancelError: string | null = null;
        if (previousVismedAppointmentId) {
            try {
                await this.vismedService.cancelarAgendamento(previousVismedAppointmentId, conn.domain || undefined);
                this.logger.log(`[RESCHEDULE-SYNC] Agendamento VisMed antigo ${previousVismedAppointmentId} cancelado`);
            } catch (err: any) {
                const msg = err?.message || String(err);
                const status = err?.status || err?.response?.status;
                const is404 = status === 404 || /\b404\b/.test(msg) || /not.*found|inexist/i.test(msg);
                if (!is404) {
                    this.logger.error(
                        `[RESCHEDULE-SYNC] *** AGENDAMENTO ANTIGO NÃO CANCELADO *** apptId=${previousVismedAppointmentId} clinicId=${rec.clinicId}: ${msg} — INTERVENÇÃO MANUAL pode ser necessária (novo agendamento já criado em ${rec.startAt.toISOString()})`,
                    );
                    pendingCancelError = `reschedule→vismed: novo agendamento OK mas cancel do antigo (id=${previousVismedAppointmentId}) falhou: ${msg}`;
                }
            }
        }

        // PASSO 3: marca como sincronizado. Mantém syncError se houver problema pendente.
        const finalErrorBits: string[] = [];
        if (!novoIdpacienteagendamento) finalErrorBits.push('novo agendamento criado mas API não retornou id');
        if (pendingCancelError) finalErrorBits.push(pendingCancelError);
        await this.prisma.bookingSync.update({
            where: { id: syncId },
            data: {
                status: 'BOOKED',
                syncedToVismed: !!novoIdpacienteagendamento,
                syncError: finalErrorBits.length ? finalErrorBits.join(' | ').slice(0, 500) : null,
                processedAt: new Date(),
            },
        });
        this.logger.log(`[RESCHEDULE-SYNC] OK reagendamento Doctoralia→VisMed concluído para booking ${syncId}`);
    }

    /**
     * Reflects a VisMed appointment as a Doctoralia calendar_break so the slot
     * disappears from Doctoralia. Active appointment -> POST/PATCH break.
     * Cancelled / no-show -> DELETE break.
     */
    private async syncDoctoraliaBreak(bookingSyncId: string): Promise<void> {
        const rec = await this.prisma.bookingSync.findUnique({ where: { id: bookingSyncId } });
        if (!rec || rec.origin !== 'VISMED' || !rec.vismedDoctorId) return;

        if (rec.syncedToDoctoralia && rec.doctoraliaBreakId && rec.status !== 'CANCELLED') return;

        const mapping = await this.prisma.mapping.findFirst({
            where: {
                clinicId: rec.clinicId,
                entityType: 'DOCTOR',
                vismedId: rec.vismedDoctorId,
                status: 'LINKED',
            },
        });
        if (!mapping || !mapping.externalId) return;

        const cd: any = mapping.conflictData || {};
        const facilityId = cd.facilityId;
        const addressId = cd.address?.id ? String(cd.address.id) : null;
        if (!facilityId || !addressId) return;

        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId: rec.clinicId, provider: 'doctoralia' },
        });
        if (!conn || !conn.clientId) return;

        const client = this.docplannerService.createClient(
            conn.domain || 'doctoralia.com.br',
            conn.clientId,
            conn.clientSecret || '',
        );

        const isActive = rec.status === 'BOOKED' || rec.status === 'CONFIRMED';
        // Doctoralia rejects ISO with `Z` and milliseconds. Format as YYYY-MM-DDTHH:mm:ss-03:00 (Brasília).
        const formatBrt = (d: Date): string => {
            const { dateStr, timeStr } = this.extractBrtDateTime(d);
            return `${dateStr}T${timeStr}:00-03:00`;
        };
        const since = formatBrt(rec.startAt);
        const till = formatBrt(rec.endAt);

        const isNotFound = (err: any) => /\b404\b/.test(String(err?.message || err));
        const isConflict = (err: any) => /\b409\b/.test(String(err?.message || err));

        // Look up the remote break that matches our since/till and persist its id.
        // Used to recover from 409 (duplicate) or 404 (stale local id).
        const findRemoteBreakId = async (): Promise<string | null> => {
            try {
                await this.rateLimiter.acquire('doctoralia');
                const list = await client.getCalendarBreaks(facilityId, mapping.externalId!, addressId, since, till);
                const items: any[] = Array.isArray(list) ? list : list?._items || [list].filter(Boolean);
                const target = new Date(since).getTime();
                const match = items.find((b) => b?.since && Math.abs(new Date(b.since).getTime() - target) < 60_000);
                return match?.id ? String(match.id) : null;
            } catch {
                return null;
            }
        };

        if (!isActive) {
            if (!rec.doctoraliaBreakId) return;
            try {
                await this.rateLimiter.acquire('doctoralia');
                await client.deleteCalendarBreak(facilityId, mapping.externalId, addressId, rec.doctoraliaBreakId);
                this.logger.log(`[VISMED-POLL] Deleted Doctoralia break ${rec.doctoraliaBreakId} (status=${rec.status})`);
            } catch (err: any) {
                if (!isNotFound(err)) throw err;
                this.logger.debug(`[VISMED-POLL] Break ${rec.doctoraliaBreakId} already gone (404), clearing local id`);
            }
            await this.prisma.bookingSync.update({
                where: { id: rec.id },
                data: { doctoraliaBreakId: null, doctoraliaFacilityId: facilityId, doctoraliaAddressId: addressId },
            });
            return;
        }

        // Active appointment: ensure break exists and matches start/end
        if (rec.doctoraliaBreakId) {
            try {
                await this.rateLimiter.acquire('doctoralia');
                await client.moveCalendarBreak(facilityId, mapping.externalId, addressId, rec.doctoraliaBreakId, { since, till });
                await this.prisma.bookingSync.update({
                    where: { id: rec.id },
                    data: { syncedToDoctoralia: true },
                });
                this.logger.log(`[VISMED-POLL] Moved Doctoralia break ${rec.doctoraliaBreakId}`);
                return;
            } catch (err: any) {
                const isSameRange = /422/.test(String(err?.message)) && /Same Date Range/i.test(String(err?.message));
                if (isSameRange) {
                    await this.prisma.bookingSync.update({
                        where: { id: rec.id },
                        data: { syncedToDoctoralia: true },
                    });
                    return;
                }
                if (!isNotFound(err)) throw err;
                this.logger.warn(`[VISMED-POLL] Break ${rec.doctoraliaBreakId} not found on move, will recreate`);
                await this.prisma.bookingSync.update({
                    where: { id: rec.id },
                    data: { doctoraliaBreakId: null },
                });
            }
        }

        try {
            await this.rateLimiter.acquire('doctoralia');
            const created = await client.addCalendarBreak(facilityId, mapping.externalId, addressId, { since, till });
            const breakId = created?.id ? String(created.id) : null;
            if (breakId) {
                await this.prisma.bookingSync.update({
                    where: { id: rec.id },
                    data: {
                        doctoraliaBreakId: breakId,
                        doctoraliaFacilityId: facilityId,
                        doctoraliaAddressId: addressId,
                        syncedToDoctoralia: true,
                    },
                });
                this.logger.log(`[VISMED-POLL] Created Doctoralia break ${breakId} for booking ${rec.id}`);
            }
        } catch (err: any) {
            if (!isConflict(err)) throw err;
            const existingId = await findRemoteBreakId();
            if (existingId) {
                await this.prisma.bookingSync.update({
                    where: { id: rec.id },
                    data: {
                        doctoraliaBreakId: existingId,
                        doctoraliaFacilityId: facilityId,
                        doctoraliaAddressId: addressId,
                        syncedToDoctoralia: true,
                    },
                });
                this.logger.log(`[VISMED-POLL] Adopted existing Doctoralia break ${existingId} for booking ${rec.id} (409)`);
            } else {
                this.logger.warn(`[VISMED-POLL] Got 409 creating break for booking ${rec.id} but could not locate existing one`);
            }
        }
    }

    async pollAllVismedClinics() {
        const conns = await this.prisma.integrationConnection.findMany({
            where: { provider: 'vismed', status: 'connected' },
        });
        for (const c of conns) {
            await this.pollVismedClinic(c);
        }
    }

    private async pollClinic(conn: any) {
        if (!conn.clientId || !conn.clientSecret) return;

        try {
            await this.rateLimiter.acquire('doctoralia');

            const client = this.docplannerService.createClient(
                conn.domain || 'doctoralia.com.br',
                conn.clientId,
                conn.clientSecret,
            );

            const res = await client.getNotifications(100);
            const notifications = res?._items || (Array.isArray(res) ? res : []);

            if (notifications.length === 0) {
                this.logger.debug(`[POLL] No notifications for clinic ${conn.clinicId}`);
                return;
            }

            this.logger.log(`[POLL] Enqueuing ${notifications.length} notification(s) for clinic ${conn.clinicId}`);

            const jobs = notifications
                .filter((n: any) => ['slot-booked', 'booking-canceled', 'booking-moved'].includes(n?.name))
                .map((n: any) => {
                    const bookingId = n?.data?.visit_booking?.id;
                    return {
                        clinicId: conn.clinicId,
                        type: n.name,
                        payload: { data: n.data, raw: n },
                        priority: n.name === 'booking-canceled' ? 2 : 1,
                        dedupKey: bookingId ? `${conn.clinicId}:${n.name}:${bookingId}` : undefined,
                    };
                });

            if (jobs.length > 0) {
                await this.queueService.enqueueBatch(jobs);
            }
        } catch (err: any) {
            this.logger.warn(`[POLL] Error polling clinic ${conn.clinicId}: ${err.message}`);
        }
    }

    private async pollAllClinics() {
        try {
            const connections = await this.prisma.integrationConnection.findMany({
                where: { provider: 'doctoralia', status: 'connected' },
            });
            for (const conn of connections) {
                await this.pollClinic(conn);
            }
        } catch (err: any) {
            this.logger.error(`[POLL] Global polling error: ${err.message}`);
        }
    }

    async pollNotifications() {
        return this.pollAllClinics();
    }

    async processWebhookNotification(body: any) {
        const notifName = body?.name;
        this.logger.log(`[WEBHOOK] Received notification: ${notifName}`);

        const facilityData = body?.data?.facility;

        if (!facilityData?.id) {
            this.logger.warn('[WEBHOOK] No facility ID in notification, cannot resolve clinic');
            return { processed: false, reason: 'no_facility_id' };
        }

        const facilityIdStr = String(facilityData.id);

        const conn = await this.prisma.integrationConnection.findFirst({
            where: { provider: 'doctoralia', status: 'connected', facilityId: facilityIdStr },
        });

        if (!conn) {
            this.logger.warn(`[WEBHOOK] No Doctoralia connection found for facilityId=${facilityIdStr}`);
            return { processed: false, reason: 'no_matching_connection' };
        }

        this.logger.log(`[WEBHOOK] Matched facilityId=${facilityIdStr} to clinic ${conn.clinicId}`);

        if (['slot-booked', 'booking-canceled', 'booking-moved'].includes(notifName)) {
            try {
                let result: any;
                if (notifName === 'slot-booked') {
                    result = await this.handleSlotBooked(conn.clinicId, body.data, body);
                } else if (notifName === 'booking-canceled') {
                    result = await this.handleBookingCanceled(conn.clinicId, body.data, body);
                } else if (notifName === 'booking-moved') {
                    result = await this.handleBookingMoved(conn.clinicId, body.data, body);
                }

                this.logger.log(`[WEBHOOK] Processed ${notifName} synchronously: ${JSON.stringify(result)}`);

                if (notifName === 'slot-booked' && result && !result.vismedCreated && result.action !== 'skipped_integration_booking') {
                    return { ok: false, processed: true, vismedCreated: false, reason: 'vismed_booking_failed' };
                }

                return { ok: true, processed: true, ...result };
            } catch (err: any) {
                this.logger.error(`[WEBHOOK] Error processing ${notifName} synchronously: ${err.message}`);
                return { ok: false, processed: false, reason: err.message };
            }
        }

        return { processed: false, reason: `unsupported_type:${notifName}` };
    }

    private async handleSlotBooked(clinicId: string, data: any, rawNotification: any) {
        const booking = data?.visit_booking;
        if (!booking?.id) {
            throw new Error('No booking ID in slot-booked notification');
        }

        const bookingIdStr = String(booking.id);
        const doctoraliaDoctorId = String(data.doctor?.id || '');
        const baseSyncData = {
            clinicId,
            doctoraliaDoctorId,
            doctoraliaFacilityId: String(data.facility?.id || ''),
            doctoraliaAddressId: String(data.address?.id || ''),
            patientName: booking.patient?.name || '',
            patientSurname: booking.patient?.surname || '',
            patientPhone: booking.patient?.phone ? String(booking.patient.phone) : '',
            patientEmail: booking.patient?.email || '',
            patientCpf: booking.patient?.nin || '',
            startAt: new Date(booking.start_at),
            endAt: new Date(booking.end_at),
            duration: parseInt(booking.duration) || 30,
            serviceName: booking.address_service?.name || '',
            addressServiceId: String(booking.address_service?.id || ''),
            notificationName: rawNotification?.name,
            rawPayload: rawNotification,
            processedAt: new Date(),
        };

        if (booking.booked_by === 'integration') {
            this.logger.debug(`[SLOT-BOOKED] Booking ${bookingIdStr} created by integration (us), skipping reverse sync`);
            try {
                await this.prisma.bookingSync.upsert({
                    where: { doctoraliaBookingId: bookingIdStr },
                    create: { ...baseSyncData, doctoraliaBookingId: bookingIdStr, origin: 'VISMED', status: 'BOOKED' },
                    update: { processedAt: new Date() },
                });
            } catch (err: any) {
                this.logger.debug(`[SLOT-BOOKED] Upsert conflict for integration booking ${bookingIdStr} (idempotent)`);
            }
            return { processed: true, action: 'skipped_integration_booking' };
        }

        let reserved: any;
        try {
            reserved = await this.prisma.bookingSync.upsert({
                where: { doctoraliaBookingId: bookingIdStr },
                create: { ...baseSyncData, doctoraliaBookingId: bookingIdStr, origin: 'DOCTORALIA', status: 'PROCESSING' },
                update: {},
            });
        } catch (err: any) {
            this.logger.debug(`[SLOT-BOOKED] Booking ${bookingIdStr} already being processed (race avoided)`);
            return { processed: false, reason: 'already_synced' };
        }

        if (reserved.status !== 'PROCESSING') {
            this.logger.debug(`[SLOT-BOOKED] Booking ${bookingIdStr} already synced (status=${reserved.status}), skipping`);
            return { processed: false, reason: 'already_synced' };
        }

        const mapping = await this.prisma.mapping.findFirst({
            where: { clinicId, entityType: 'DOCTOR', externalId: doctoraliaDoctorId, status: 'LINKED' },
        });

        let vismedDoctorId: string | null = null;
        let vismedCreateResult: any = null;

        if (mapping) {
            vismedDoctorId = mapping.vismedId;
            try {
                await this.rateLimiter.acquire('vismed');
                vismedCreateResult = await this.createVismedAppointment(clinicId, mapping, booking, data);
                this.logger.log(`[SLOT-BOOKED] Created VisMed appointment for booking ${bookingIdStr}`);
            } catch (err: any) {
                this.logger.error(`[SLOT-BOOKED] Failed to create VisMed appointment for booking ${bookingIdStr}: ${err.message}`);
                throw err;
            }
        } else {
            this.logger.warn(`[SLOT-BOOKED] No LINKED doctor mapping for doctoraliaDoctorId=${doctoraliaDoctorId}`);
        }

        let vismedAppointmentId: string | null = null;
        if (vismedCreateResult) {
            const rawId = vismedCreateResult?.idpacienteagendamento
                || vismedCreateResult?.id
                || vismedCreateResult?.idPacienteAgendamento;
            if (rawId) vismedAppointmentId = String(rawId);
            this.logger.log(`[SLOT-BOOKED] VisMed appointment ID: ${vismedAppointmentId ?? '(não retornado)'}`);
        }

        await this.prisma.bookingSync.update({
            where: { id: reserved.id },
            data: {
                vismedDoctorId: vismedDoctorId || undefined,
                vismedAppointmentId: vismedAppointmentId || undefined,
                status: vismedCreateResult ? 'BOOKED' : 'FAILED',
                syncError: vismedCreateResult ? undefined : 'Failed to create in VisMed',
                syncedToDoctoralia: true,
                syncedToVismed: !!vismedCreateResult,
            },
        });

        return { processed: true, action: 'slot_booked', vismedCreated: !!vismedCreateResult };
    }

    private async handleBookingCanceled(clinicId: string, data: any, rawNotification: any) {
        const booking = data?.visit_booking || data?.booking || data;
        if (!booking?.id) return { processed: false, reason: 'no_booking_id' };

        const existing = await this.prisma.bookingSync.findUnique({
            where: { doctoraliaBookingId: String(booking.id) },
        });

        let syncId: string;
        const previousStatus = existing?.status ?? null;
        const previousCancelledBy = existing?.cancelledBy ?? null;

        if (existing) {
            const updated = await this.prisma.bookingSync.update({
                where: { id: existing.id },
                data: {
                    status: 'CANCELLED',
                    rawPayload: rawNotification,
                    processedAt: new Date(),
                },
            });
            syncId = updated.id;
            this.logger.log(`[BOOKING-CANCELED] Marked booking ${booking.id} as CANCELLED`);
        } else {
            const created = await this.prisma.bookingSync.create({
                data: {
                    clinicId,
                    doctoraliaDoctorId: String(data.doctor?.id || ''),
                    doctoraliaBookingId: String(booking.id),
                    doctoraliaFacilityId: String(data.facility?.id || ''),
                    doctoraliaAddressId: String(data.address?.id || ''),
                    origin: 'DOCTORALIA',
                    status: 'CANCELLED',
                    patientName: booking.patient?.name || '',
                    patientSurname: booking.patient?.surname || '',
                    startAt: new Date(booking.start_at || new Date()),
                    endAt: new Date(booking.end_at || new Date()),
                    duration: parseInt(booking.duration) || 30,
                    notificationName: rawNotification?.name,
                    rawPayload: rawNotification,
                    processedAt: new Date(),
                },
            });
            syncId = created.id;
        }

        // Propaga para VisMed. O helper é idempotente:
        //  - faz no-op se já foi cancelado por nós/VisMed (anti-loop)
        //  - retenta se uma tentativa anterior falhou (syncedToVismed=false)
        void previousStatus; void previousCancelledBy;
        await this.propagateDoctoraliaCancellationToVismed(syncId).catch((err) =>
            this.logger.warn(`[CANCEL-SYNC] propagate doctoralia→vismed failed: ${err.message}`),
        );

        return { processed: true, action: 'booking_canceled' };
    }

    private async handleBookingMoved(clinicId: string, data: any, rawNotification: any) {
        // Doctoralia booking-moved payload uses new_visit_booking (after) + old_visit_booking (before)
        const booking = data?.new_visit_booking || data?.visit_booking || data?.booking || data;
        const oldBooking = data?.old_visit_booking;
        this.logger.log(
            `[BOOKING-MOVED] data keys: ${JSON.stringify(Object.keys(data || {}))}` +
            `, booking.id=${booking?.id}, old.id=${oldBooking?.id}, new_visit_booking=${!!data?.new_visit_booking}`,
        );
        if (!booking?.id) return { processed: false, reason: 'no_booking_id' };

        // Quando a Doctoralia muda o ID no reschedule (cria new_visit_booking diferente do old),
        // precisamos achar o registro pelo ID antigo para atualizar com o novo ID.
        if (oldBooking?.id && String(oldBooking.id) !== String(booking.id)) {
            const byOldId = await this.prisma.bookingSync.findUnique({
                where: { doctoraliaBookingId: String(oldBooking.id) },
            });
            if (byOldId && !await this.prisma.bookingSync.findUnique({ where: { doctoraliaBookingId: String(booking.id) } })) {
                await this.prisma.bookingSync.update({
                    where: { id: byOldId.id },
                    data: { doctoraliaBookingId: String(booking.id) },
                });
                this.logger.log(`[BOOKING-MOVED] migrou doctoraliaBookingId ${oldBooking.id} → ${booking.id}`);
            }
        }

        let existing = await this.prisma.bookingSync.findUnique({
            where: { doctoraliaBookingId: String(booking.id) },
        });

        // Reconciliação adicional: busca registro órfão pelo startAt antigo + clinic + doctor.
        // Cobre o caso de IDs intermediários da Doctoralia que nunca foram salvos por nós.
        if (!existing && oldBooking?.start_at) {
            const oldStartAt = new Date(oldBooking.start_at);
            const oldDoctorId = String(oldBooking.doctor?.id || data.doctor?.id || '');
            const candidate = await this.prisma.bookingSync.findFirst({
                where: {
                    clinicId,
                    doctoraliaDoctorId: oldDoctorId,
                    startAt: oldStartAt,
                    status: { in: ['BOOKED', 'PROCESSING'] },
                },
                orderBy: { processedAt: 'desc' },
            });
            if (candidate) {
                this.logger.log(
                    `[BOOKING-MOVED] reconciliou registro órfão ${candidate.id} (doctoraliaBookingId=${candidate.doctoraliaBookingId}) → adotando novo id ${booking.id}`,
                );
                existing = await this.prisma.bookingSync.update({
                    where: { id: candidate.id },
                    data: { doctoraliaBookingId: String(booking.id) },
                });
            }
        }

        if (!existing) {
            this.logger.warn(
                `[BOOKING-MOVED] booking ${booking.id} (old=${oldBooking?.id}) não encontrado no BookingSync — caindo no fluxo slot-booked para criar na VisMed`,
            );
            // Fallback: tabela está dessincronizada e não há órfão BOOKED equivalente.
            // Trata o new_visit_booking como uma criação nova para garantir contraparte VisMed.
            const slotData = {
                ...data,
                visit_booking: booking,
            };
            try {
                return await this.handleSlotBooked(clinicId, slotData, rawNotification);
            } catch (err: any) {
                this.logger.error(`[BOOKING-MOVED] fallback slot-booked falhou: ${err.message}`);
                return { processed: false, reason: 'fallback_failed', error: err.message };
            }
        }

        const previousVismedAppointmentId = existing.vismedAppointmentId;
        const newStartAt = new Date(booking.start_at);
        const newEndAt = new Date(booking.end_at);

        // Idempotência: notificação repetida com mesmo horário → no-op (apenas refresh do payload).
        if (existing.startAt.getTime() === newStartAt.getTime()) {
            await this.prisma.bookingSync.update({
                where: { id: existing.id },
                data: { rawPayload: rawNotification, processedAt: new Date() },
            });
            this.logger.debug(`[BOOKING-MOVED] booking ${booking.id} sem mudança de horário (${booking.start_at}), no-op`);
            return { processed: true, action: 'booking_moved', noop: true };
        }

        const updated = await this.prisma.bookingSync.update({
            where: { id: existing.id },
            data: {
                status: 'BOOKED', // estado vivo após o move; helper marcará novamente após propagação
                startAt: newStartAt,
                endAt: newEndAt,
                doctoraliaDoctorId: String(data.doctor?.id || existing.doctoraliaDoctorId),
                doctoraliaAddressId: String(data.address?.id || existing.doctoraliaAddressId),
                rawPayload: rawNotification,
                processedAt: new Date(),
            },
        });
        this.logger.log(
            `[BOOKING-MOVED] booking ${booking.id} movido para ${booking.start_at} (vismedApptIdAntigo=${previousVismedAppointmentId})`,
        );

        // Anti-eco: se nós acabamos de mover esse booking para esse mesmo horário (VisMed→Doctoralia),
        // a Doctoralia vai emitir booking-moved como confirmação — não devemos repetir do nosso lado.
        if (this.isRescheduleEco(updated, newStartAt)) {
            this.logger.debug(`[RESCHEDULE-SYNC] eco da Doctoralia para booking ${updated.id}, skip propagação para VisMed`);
            return { processed: true, action: 'booking_moved', echoed: true };
        }

        await this.propagateDoctoraliaRescheduleToVismed(updated.id, previousVismedAppointmentId).catch((err) =>
            this.logger.warn(`[RESCHEDULE-SYNC] propagate doctoralia→vismed failed: ${err.message}`),
        );

        return { processed: true, action: 'booking_moved' };
    }

    private async createVismedAppointment(clinicId: string, mapping: any, booking: any, notifData: any) {
        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'vismed' },
        });

        if (!conn || !conn.clientId) {
            throw new Error('VisMed integration not configured');
        }

        const idEmpresaGestora = parseInt(conn.clientId);
        const vismedDoctorId = mapping.vismedId;

        const vismedDoctor = await this.prisma.vismedDoctor.findUnique({
            where: { id: vismedDoctorId },
            include: { specialties: { include: { specialty: true } } },
        });

        if (!vismedDoctor) {
            throw new Error(`VisMed doctor ${vismedDoctorId} not found`);
        }

        let idCategoriaServico = 0;
        if (vismedDoctor.specialties && vismedDoctor.specialties.length > 0) {
            idCategoriaServico = vismedDoctor.specialties[0].specialty.vismedId || 0;
        }

        if (!idCategoriaServico) {
            const anySpec = await this.prisma.vismedSpecialty.findFirst();
            if (anySpec) idCategoriaServico = anySpec.vismedId;
        }

        const startDate = new Date(booking.start_at);
        const { dateStr, timeStr } = this.extractBrtDateTime(startDate);
        const vismedProfId = vismedDoctor.vismedId;
        const horariosProfissional = `${vismedProfId}-${timeStr}`;

        this.logger.log(
            `[VISMED-CREATE] booking ${booking.id}: raw start_at=${booking.start_at} → BRT date=${dateStr} time=${timeStr} (horarios_profissional=${horariosProfissional})`
        );

        const patient = booking.patient || {};
        const fullName = `${patient.name || ''} ${patient.surname || ''}`.trim() || 'PACIENTE DOCTORALIA';
        const phone = patient.phone ? String(patient.phone) : '';

        const payload = {
            tipo: 'particular',
            idcategoriaservico: idCategoriaServico,
            horarios_profissional: horariosProfissional,
            idempresagestora: idEmpresaGestora,
            data_agendamento: dateStr,
            nome: fullName,
            telefone: phone,
            cpf: patient.nin || undefined,
            data_nascimento: patient.birth_date || undefined,
            sexo: patient.gender === 'f' ? 1 : patient.gender === 'm' ? 2 : undefined,
        };

        return await this.vismedService.createAppointment(payload, conn.domain || undefined);
    }

    async bookOnDoctoraliaFromVismed(
        clinicId: string,
        vismedDoctorId: string,
        slotStart: string,
        patient: {
            name: string;
            surname?: string;
            phone?: string;
            email?: string;
            cpf?: string;
            birthDate?: string;
            gender?: string;
        },
        addressServiceId?: string,
        duration?: number,
    ) {
        const mapping = await this.prisma.mapping.findFirst({
            where: { clinicId, entityType: 'DOCTOR', vismedId: vismedDoctorId, status: 'LINKED' },
        });

        if (!mapping || !mapping.externalId) {
            throw new Error('Médico não possui mapeamento com Doctoralia');
        }

        const cd = (mapping.conflictData as any) || {};
        if (!cd.facilityId || !cd.address?.id) {
            throw new Error('Dados de endereço do médico incompletos na Doctoralia');
        }

        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia' },
        });

        if (!conn || !conn.clientId) {
            throw new Error('Integração Doctoralia não configurada');
        }

        const client = this.docplannerService.createClient(
            conn.domain || 'doctoralia.com.br',
            conn.clientId,
            conn.clientSecret || '',
        );

        await this.rateLimiter.acquire('doctoralia');

        let finalAddressServiceId = addressServiceId;
        if (!finalAddressServiceId) {
            const servicesRes = await client.getServices(cd.facilityId, mapping.externalId, String(cd.address.id));
            const services = servicesRes?._items || [];
            if (services.length > 0) {
                finalAddressServiceId = String(services[0].id);
            }
        }

        if (!finalAddressServiceId) {
            throw new Error('Nenhum serviço disponível para este médico na Doctoralia');
        }

        const bookPayload = {
            address_service_id: parseInt(finalAddressServiceId),
            duration: duration || 30,
            is_returning: false,
            patient: {
                name: patient.name,
                surname: patient.surname || patient.name.split(' ').slice(-1)[0],
                email: patient.email || 'vismed@integration.local',
                phone: patient.phone ? parseInt(patient.phone.replace(/\D/g, '')) : 0,
                birth_date: patient.birthDate || undefined,
                nin: patient.cpf || undefined,
                gender: patient.gender === '1' ? 'f' : patient.gender === '2' ? 'm' : undefined,
            },
        };

        const startFormatted = slotStart.includes('T') ? slotStart : `${slotStart}:00-03:00`;

        await this.rateLimiter.acquire('doctoralia');

        const bookResult = await client.bookSlot(
            cd.facilityId,
            mapping.externalId,
            String(cd.address.id),
            startFormatted,
            bookPayload,
        );

        const doctoraliaBookingId = bookResult?.id ? String(bookResult.id) : null;

        await this.prisma.bookingSync.create({
            data: {
                clinicId,
                vismedDoctorId,
                doctoraliaDoctorId: mapping.externalId,
                doctoraliaBookingId,
                doctoraliaFacilityId: cd.facilityId,
                doctoraliaAddressId: String(cd.address.id),
                origin: 'VISMED',
                status: 'BOOKED',
                patientName: patient.name,
                patientSurname: patient.surname || '',
                patientPhone: patient.phone || '',
                patientEmail: patient.email || '',
                patientCpf: patient.cpf || '',
                patientBirthDate: patient.birthDate || '',
                startAt: new Date(startFormatted),
                endAt: new Date(new Date(startFormatted).getTime() + (duration || 30) * 60000),
                duration: duration || 30,
                addressServiceId: finalAddressServiceId,
                syncedToDoctoralia: true,
                processedAt: new Date(),
            },
        });

        this.logger.log(`[VISMED→DOCTORALIA] Booked slot ${slotStart} for ${patient.name}, doctoraliaBookingId=${doctoraliaBookingId}`);

        let vismedCreated = false;
        try {
            const vismedConn = await this.prisma.integrationConnection.findFirst({
                where: { clinicId, provider: 'vismed' },
            });
            if (vismedConn && vismedConn.clientId) {
                await this.rateLimiter.acquire('vismed');

                const idEmpresaGestora = parseInt(vismedConn.clientId);
                const vismedDoctor = await this.prisma.vismedDoctor.findUnique({
                    where: { id: vismedDoctorId },
                    include: { specialties: { include: { specialty: true } } },
                });

                if (vismedDoctor) {
                    let idCategoriaServico = 0;
                    if (vismedDoctor.specialties && vismedDoctor.specialties.length > 0) {
                        idCategoriaServico = vismedDoctor.specialties[0].specialty.vismedId || 0;
                    }
                    if (!idCategoriaServico) {
                        const anySpec = await this.prisma.vismedSpecialty.findFirst();
                        if (anySpec) idCategoriaServico = anySpec.vismedId;
                    }

                    const startDate = new Date(startFormatted);
                    const { dateStr, timeStr } = this.extractBrtDateTime(startDate);
                    const horariosProfissional = `${vismedDoctor.vismedId}-${timeStr}`;
                    this.logger.log(
                        `[VISMED→VISMED] booking ${doctoraliaBookingId}: raw start=${startFormatted} → BRT date=${dateStr} time=${timeStr}`
                    );

                    const vismedPayload = {
                        tipo: 'particular',
                        idcategoriaservico: idCategoriaServico,
                        horarios_profissional: horariosProfissional,
                        idempresagestora: idEmpresaGestora,
                        data_agendamento: dateStr,
                        nome: `${patient.name} ${patient.surname || ''}`.trim(),
                        telefone: patient.phone || '',
                        cpf: patient.cpf || undefined,
                        data_nascimento: patient.birthDate || undefined,
                        sexo: patient.gender === 'f' || patient.gender === '1' ? 1 : patient.gender === 'm' || patient.gender === '2' ? 2 : undefined,
                    };

                    await this.vismedService.createAppointment(vismedPayload, vismedConn.domain || undefined);
                    vismedCreated = true;
                    this.logger.log(`[VISMED→VISMED] Also created appointment in VisMed for ${patient.name}`);

                    await this.prisma.bookingSync.updateMany({
                        where: { clinicId, doctoraliaBookingId },
                        data: { syncedToVismed: true },
                    });
                }
            }
        } catch (vismedError: any) {
            this.logger.warn(`[VISMED→VISMED] Failed to create in VisMed (Doctoralia booking still OK): ${vismedError.message}`);
        }

        return { success: true, doctoraliaBookingId, bookResult, vismedCreated };
    }

    async cancelOnDoctoraliaFromVismed(clinicId: string, doctoraliaBookingId: string, reason?: string) {
        const syncRecord = await this.prisma.bookingSync.findUnique({
            where: { doctoraliaBookingId },
        });

        if (!syncRecord || syncRecord.clinicId !== clinicId) {
            throw new Error('Agendamento não encontrado no registro de sincronização');
        }

        return this.cancelSyncRecord(clinicId, syncRecord, reason);
    }

    async cancelBookingById(clinicId: string, bookingSyncId: string, reason?: string) {
        const syncRecord = await this.prisma.bookingSync.findUnique({
            where: { id: bookingSyncId },
        });

        if (!syncRecord || syncRecord.clinicId !== clinicId) {
            throw new Error('Agendamento não encontrado no registro de sincronização');
        }

        return this.cancelSyncRecord(clinicId, syncRecord, reason);
    }

    private async cancelSyncRecord(clinicId: string, syncRecord: any, reason?: string) {
        let cancelledDoctoralia = false;
        let cancelledVismed = false;

        if (syncRecord.doctoraliaBookingId) {
            const conn = await this.prisma.integrationConnection.findFirst({
                where: { clinicId, provider: 'doctoralia' },
            });

            if (conn?.clientId) {
                const client = this.docplannerService.createClient(
                    conn.domain || 'doctoralia.com.br',
                    conn.clientId,
                    conn.clientSecret || '',
                );

                await this.rateLimiter.acquire('doctoralia');

                try {
                    await client.cancelBooking(
                        syncRecord.doctoraliaFacilityId || '',
                        syncRecord.doctoraliaDoctorId || '',
                        syncRecord.doctoraliaAddressId || '',
                        syncRecord.doctoraliaBookingId,
                        reason,
                    );
                    cancelledDoctoralia = true;
                } catch (err: any) {
                    if (err.message?.includes('404') || err.message?.includes('409') || err.message?.includes('already')) {
                        this.logger.warn(`[CANCEL] Doctoralia booking ${syncRecord.doctoraliaBookingId} already cancelled or not found`);
                        cancelledDoctoralia = true;
                    } else {
                        this.logger.error(`[CANCEL] Failed to cancel Doctoralia booking ${syncRecord.doctoraliaBookingId}: ${err.message}`);
                        throw err;
                    }
                }
            }
        }

        if (syncRecord.vismedAppointmentId) {
            const vismedConn = await this.prisma.integrationConnection.findFirst({
                where: { clinicId, provider: 'vismed', status: 'connected' },
            });

            if (vismedConn) {
                try {
                    await this.vismedService.cancelarAgendamento(
                        syncRecord.vismedAppointmentId,
                        vismedConn.domain || undefined,
                    );
                    cancelledVismed = true;
                    this.logger.log(`[CANCEL] Cancelled VisMed appointment ${syncRecord.vismedAppointmentId}`);
                } catch (err: any) {
                    this.logger.warn(`[CANCEL] Failed to cancel VisMed appointment ${syncRecord.vismedAppointmentId}: ${err.message}`);
                }
            }
        }

        if (syncRecord.doctoraliaBreakId) {
            try {
                const conn = await this.prisma.integrationConnection.findFirst({
                    where: { clinicId, provider: 'doctoralia' },
                });
                if (conn?.clientId) {
                    const client = this.docplannerService.createClient(
                        conn.domain || 'doctoralia.com.br',
                        conn.clientId,
                        conn.clientSecret || '',
                    );
                    await this.rateLimiter.acquire('doctoralia');
                    await client.deleteCalendarBreak(
                        syncRecord.doctoraliaFacilityId || '',
                        syncRecord.doctoraliaDoctorId || '',
                        syncRecord.doctoraliaAddressId || '',
                        syncRecord.doctoraliaBreakId,
                    );
                    this.logger.log(`[CANCEL] Deleted Doctoralia break ${syncRecord.doctoraliaBreakId}`);
                }
            } catch (err: any) {
                this.logger.warn(`[CANCEL] Failed to delete Doctoralia break ${syncRecord.doctoraliaBreakId}: ${err.message}`);
            }
        }

        await this.prisma.bookingSync.update({
            where: { id: syncRecord.id },
            data: { status: 'CANCELLED', cancelledBy: 'DASHBOARD', processedAt: new Date() },
        });

        return { success: true, cancelledDoctoralia, cancelledVismed };
    }

    async getBookingSyncRecords(clinicId: string, filters: any = {}) {
        const where: any = { clinicId };

        if (filters.doctoraliaDoctorId) where.doctoraliaDoctorId = filters.doctoraliaDoctorId;
        if (filters.vismedDoctorId) where.vismedDoctorId = filters.vismedDoctorId;
        if (filters.origin) where.origin = filters.origin;
        if (filters.status) where.status = filters.status;
        if (filters.startDate || filters.endDate) {
            where.startAt = {};
            if (filters.startDate) where.startAt.gte = new Date(filters.startDate);
            if (filters.endDate) where.startAt.lte = new Date(filters.endDate + 'T23:59:59Z');
        }

        return this.prisma.bookingSync.findMany({
            where,
            orderBy: { startAt: 'asc' },
        });
    }

    async getSyncStats(clinicId: string) {
        const [total, booked, failed, cancelled] = await Promise.all([
            this.prisma.bookingSync.count({ where: { clinicId } }),
            this.prisma.bookingSync.count({ where: { clinicId, status: 'BOOKED' } }),
            this.prisma.bookingSync.count({ where: { clinicId, status: 'FAILED' } }),
            this.prisma.bookingSync.count({ where: { clinicId, status: 'CANCELLED' } }),
        ]);
        return { total, booked, failed, cancelled };
    }
}
