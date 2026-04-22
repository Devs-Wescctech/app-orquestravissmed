import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerService } from '../integrations/docplanner.service';
import { VismedService } from '../integrations/vismed/vismed.service';
import { QueueService } from './queue.service';
import { RateLimiterService } from './rate-limiter.service';

const POLL_BASE_INTERVAL_MS = 3 * 60 * 1000;
const STAGGER_PER_CLINIC_MS = 6000;
const STARTUP_DELAY_MS = 15_000;

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
            for (const u of units) {
                try {
                    const agendamentos = await this.vismedService.getAgendamentos(
                        u.vismedId,
                        baseUrl,
                        { dataini, datafim },
                    );

                    if (!Array.isArray(agendamentos)) continue;

                    for (const a of agendamentos) {
                        try {
                            const upserted = await this.upsertVismedAppointment(conn.clinicId, a);
                            if (upserted) totalUpserts++;
                        } catch (innerErr: any) {
                            this.logger.debug(`[VISMED-POLL] Skipping appointment: ${innerErr.message}`);
                        }
                    }
                } catch (uErr: any) {
                    this.logger.warn(`[VISMED-POLL] Unit ${u.vismedId} fetch failed: ${uErr.message}`);
                }
            }

            this.logger.log(`[VISMED-POLL] Clinic ${conn.clinicId}: processed ${totalUpserts} VisMed appointments`);
        } catch (err: any) {
            this.logger.warn(`[VISMED-POLL] Error polling clinic ${conn.clinicId}: ${err.message}`);
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
        const endAt = horaFim
            ? new Date(`${dataAg}T${horaFim}:00-03:00`)
            : new Date(startAt.getTime() + 30 * 60 * 1000);

        const cancelado = a?.cancelado === '1' || a?.cancelado === 1 || a?.cancelado === true;
        const noShow = a?.naocompareceu === '1' || a?.naocompareceu === 1 || a?.naocompareceu === true;
        const confirmado = a?.confirmado === '1' || a?.confirmado === 1 || a?.confirmado === true;

        let status: 'BOOKED' | 'CANCELLED' | 'CONFIRMED' | 'NO_SHOW' = 'BOOKED';
        if (cancelado) status = 'CANCELLED';
        else if (noShow) status = 'NO_SHOW';
        else if (confirmado) status = 'CONFIRMED';

        const patientName = a?.nomepaciente || a?.nome || `Paciente VisMed #${a?.idpaciente ?? ''}`.trim();
        const patientPhone = a?.telefonepaciente || a?.celularpaciente || a?.telefone1 || null;

        const durationMin = Math.max(
            5,
            Math.round((endAt.getTime() - startAt.getTime()) / 60000),
        );

        // Reconcile with records previously created by the integration flow
        // (bookOnDoctoraliaFromVismed creates origin=VISMED rows without vismedAppointmentId).
        // Match by clinic + doctor + startAt window to attach the VisMed id instead of duplicating.
        const existingByVismedId = await this.prisma.bookingSync.findUnique({
            where: { clinicId_vismedAppointmentId: { clinicId, vismedAppointmentId } },
        });

        if (!existingByVismedId && doctor?.id) {
            const windowMs = 60 * 1000;
            const orphan = await this.prisma.bookingSync.findFirst({
                where: {
                    clinicId,
                    vismedDoctorId: doctor.id,
                    origin: 'VISMED',
                    vismedAppointmentId: null,
                    startAt: {
                        gte: new Date(startAt.getTime() - windowMs),
                        lte: new Date(startAt.getTime() + windowMs),
                    },
                },
                orderBy: { createdAt: 'desc' },
            });

            if (orphan) {
                const updated = await this.prisma.bookingSync.update({
                    where: { id: orphan.id },
                    data: {
                        vismedAppointmentId,
                        status,
                        startAt,
                        endAt,
                        duration: durationMin,
                        rawPayload: a,
                        processedAt: new Date(),
                    },
                });
                await this.syncDoctoraliaBreak(updated.id).catch((err) =>
                    this.logger.warn(`[VISMED-POLL] break sync failed (orphan): ${err.message}`),
                );
                return true;
            }
        }

        const upserted = await this.prisma.bookingSync.upsert({
            where: { clinicId_vismedAppointmentId: { clinicId, vismedAppointmentId } },
            create: {
                clinicId,
                vismedAppointmentId,
                vismedDoctorId: doctor?.id || null,
                doctoraliaDoctorId,
                doctoraliaFacilityId,
                origin: 'VISMED',
                status,
                patientName: String(patientName).slice(0, 200),
                patientPhone: patientPhone ? String(patientPhone) : null,
                startAt,
                endAt,
                duration: durationMin,
                rawPayload: a,
                processedAt: new Date(),
            },
            update: {
                status,
                vismedDoctorId: doctor?.id || null,
                doctoraliaDoctorId,
                doctoraliaFacilityId,
                startAt,
                endAt,
                duration: durationMin,
                rawPayload: a,
                processedAt: new Date(),
            },
        });

        await this.syncDoctoraliaBreak(upserted.id).catch((err) =>
            this.logger.warn(`[VISMED-POLL] break sync failed: ${err.message}`),
        );

        return true;
    }

    /**
     * Reflects a VisMed appointment as a Doctoralia calendar_break so the slot
     * disappears from Doctoralia. Active appointment -> POST/PATCH break.
     * Cancelled / no-show -> DELETE break.
     */
    private async syncDoctoraliaBreak(bookingSyncId: string): Promise<void> {
        const rec = await this.prisma.bookingSync.findUnique({ where: { id: bookingSyncId } });
        if (!rec || rec.origin !== 'VISMED' || !rec.vismedDoctorId) return;

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
        const since = rec.startAt.toISOString();
        const till = rec.endAt.toISOString();

        const isNotFound = (err: any) => /\b404\b/.test(String(err?.message || err));
        const isConflict = (err: any) => /\b409\b/.test(String(err?.message || err));

        // Look up the remote break that matches our since/till and persist its id.
        // Used to recover from 409 (duplicate) or 404 (stale local id).
        const findRemoteBreakId = async (): Promise<string | null> => {
            try {
                await this.rateLimiter.acquire('doctoralia');
                const list = await client.getCalendarBreaks(facilityId, mapping.externalId!, addressId, since);
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
                this.logger.log(`[VISMED-POLL] Moved Doctoralia break ${rec.doctoraliaBreakId}`);
                return;
            } catch (err: any) {
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
                    },
                });
                this.logger.log(`[VISMED-POLL] Created Doctoralia break ${breakId} for booking ${rec.id}`);
            }
        } catch (err: any) {
            if (!isConflict(err)) throw err;
            // 409 = a break already covers this slot. Find it and adopt its id so
            // future polls can move/delete it.
            const existingId = await findRemoteBreakId();
            if (existingId) {
                await this.prisma.bookingSync.update({
                    where: { id: rec.id },
                    data: {
                        doctoraliaBreakId: existingId,
                        doctoraliaFacilityId: facilityId,
                        doctoraliaAddressId: addressId,
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

        await this.prisma.bookingSync.update({
            where: { id: reserved.id },
            data: {
                vismedDoctorId: vismedDoctorId || undefined,
                status: vismedCreateResult ? 'BOOKED' : 'FAILED',
                syncError: vismedCreateResult ? undefined : 'Failed to create in VisMed',
                syncedToDoctoralia: true,
                syncedToVismed: !!vismedCreateResult,
            },
        });

        return { processed: true, action: 'slot_booked', vismedCreated: !!vismedCreateResult };
    }

    private async handleBookingCanceled(clinicId: string, data: any, rawNotification: any) {
        const booking = data?.visit_booking;
        if (!booking?.id) return { processed: false, reason: 'no_booking_id' };

        const existing = await this.prisma.bookingSync.findUnique({
            where: { doctoraliaBookingId: String(booking.id) },
        });

        if (existing) {
            await this.prisma.bookingSync.update({
                where: { id: existing.id },
                data: {
                    status: 'CANCELLED',
                    rawPayload: rawNotification,
                    processedAt: new Date(),
                },
            });
            this.logger.log(`[BOOKING-CANCELED] Marked booking ${booking.id} as CANCELLED`);
        } else {
            await this.prisma.bookingSync.create({
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
        }

        return { processed: true, action: 'booking_canceled' };
    }

    private async handleBookingMoved(clinicId: string, data: any, rawNotification: any) {
        const booking = data?.visit_booking;
        if (!booking?.id) return { processed: false, reason: 'no_booking_id' };

        const existing = await this.prisma.bookingSync.findUnique({
            where: { doctoraliaBookingId: String(booking.id) },
        });

        if (existing) {
            await this.prisma.bookingSync.update({
                where: { id: existing.id },
                data: {
                    status: 'MOVED',
                    startAt: new Date(booking.start_at),
                    endAt: new Date(booking.end_at),
                    doctoraliaDoctorId: String(data.doctor?.id || existing.doctoraliaDoctorId),
                    doctoraliaAddressId: String(data.address?.id || existing.doctoraliaAddressId),
                    rawPayload: rawNotification,
                    processedAt: new Date(),
                },
            });
            this.logger.log(`[BOOKING-MOVED] Updated booking ${booking.id} to new time ${booking.start_at}`);
        }

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

        if (!syncRecord) {
            throw new Error('Agendamento não encontrado no registro de sincronização');
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

        await client.cancelBooking(
            syncRecord.doctoraliaFacilityId || '',
            syncRecord.doctoraliaDoctorId || '',
            syncRecord.doctoraliaAddressId || '',
            doctoraliaBookingId,
            reason,
        );

        await this.prisma.bookingSync.update({
            where: { doctoraliaBookingId },
            data: { status: 'CANCELLED', processedAt: new Date() },
        });

        return { success: true, cancelled: true };
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
