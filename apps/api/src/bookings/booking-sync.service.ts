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
        } catch (err: any) {
            this.logger.error(`Failed to refresh polling schedule: ${err.message}`);
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

        const allConns = await this.prisma.integrationConnection.findMany({
            where: { provider: 'doctoralia', status: 'connected' },
        });

        const facilityIdStr = String(facilityData.id);
        const conn = allConns.find(c => c.clientId === facilityIdStr);

        if (!conn) {
            this.logger.warn(`[WEBHOOK] No Doctoralia connection found for facilityId=${facilityIdStr}`);
            return { processed: false, reason: 'no_matching_connection' };
        }

        if (['slot-booked', 'booking-canceled', 'booking-moved'].includes(notifName)) {
            const bookingId = body?.data?.visit_booking?.id;
            const dedupKey = bookingId ? `${conn.clinicId}:${notifName}:${bookingId}` : undefined;

            await this.queueService.enqueue(conn.clinicId, notifName, {
                data: body.data,
                raw: body,
            }, { priority: notifName === 'booking-canceled' ? 2 : 1, dedupKey });

            return { processed: true, action: 'enqueued', type: notifName };
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
        const timeStr = startDate.toTimeString().substring(0, 5);
        const dateStr = startDate.toISOString().split('T')[0];

        const vismedProfId = vismedDoctor.vismedId;
        const horariosProfissional = `${vismedProfId}-${timeStr}`;

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
                    const timeStr = startDate.toTimeString().substring(0, 5);
                    const dateStr = startDate.toISOString().split('T')[0];
                    const horariosProfissional = `${vismedDoctor.vismedId}-${timeStr}`;

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
