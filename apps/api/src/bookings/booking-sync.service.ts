import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerService } from '../integrations/docplanner.service';
import { VismedService } from '../integrations/vismed/vismed.service';

@Injectable()
export class BookingSyncService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(BookingSyncService.name);
    private pollingInterval: NodeJS.Timeout | null = null;
    private startupTimeout: NodeJS.Timeout | null = null;
    private isPolling = false;

    constructor(
        private prisma: PrismaService,
        private docplannerService: DocplannerService,
        private vismedService: VismedService,
    ) {}

    onModuleInit() {
        this.startPolling();
    }

    onModuleDestroy() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        if (this.startupTimeout) {
            clearTimeout(this.startupTimeout);
            this.startupTimeout = null;
        }
        this.logger.log('Polling intervals cleared on module destroy');
    }

    private startPolling() {
        const intervalMs = 5 * 60 * 1000;
        this.logger.log(`Starting Doctoralia notification polling every ${intervalMs / 1000}s`);
        this.pollingInterval = setInterval(() => this.pollNotifications(), intervalMs);
        this.startupTimeout = setTimeout(() => this.pollNotifications(), 30_000);
    }

    async pollNotifications() {
        if (this.isPolling) {
            this.logger.debug('Polling already in progress, skipping');
            return;
        }
        this.isPolling = true;

        try {
            const connections = await this.prisma.integrationConnection.findMany({
                where: { provider: 'doctoralia', status: 'connected' },
            });

            for (const conn of connections) {
                if (!conn.clientId || !conn.clientSecret) continue;

                try {
                    const client = this.docplannerService.createClient(
                        conn.domain || 'doctoralia.com.br',
                        conn.clientId,
                        conn.clientSecret,
                    );

                    await new Promise(r => setTimeout(r, 2000));

                    const res = await client.getNotifications(100);
                    const notifications = res?._items || (Array.isArray(res) ? res : []);

                    if (notifications.length === 0) {
                        this.logger.debug(`[POLL] No notifications for clinic ${conn.clinicId}`);
                        continue;
                    }

                    this.logger.log(`[POLL] Processing ${notifications.length} notification(s) for clinic ${conn.clinicId}`);

                    for (const notification of notifications) {
                        await this.processNotification(conn.clinicId, notification, client);
                    }
                } catch (err: any) {
                    this.logger.warn(`[POLL] Error polling clinic ${conn.clinicId}: ${err.message}`);
                }
            }
        } catch (err: any) {
            this.logger.error(`[POLL] Global polling error: ${err.message}`);
        } finally {
            this.isPolling = false;
        }
    }

    async processWebhookNotification(body: any) {
        const notifName = body?.name;
        this.logger.log(`[WEBHOOK] Received notification: ${notifName}`);

        const doctorData = body?.data?.doctor;
        const facilityData = body?.data?.facility;

        if (!facilityData?.id) {
            this.logger.warn('[WEBHOOK] No facility ID in notification, cannot resolve clinic');
            return { processed: false, reason: 'no_facility_id' };
        }

        const allConns = await this.prisma.integrationConnection.findMany({
            where: { provider: 'doctoralia', status: 'connected' },
        });

        const facilityIdStr = String(facilityData.id);
        let conn = allConns.find(c => c.clientId === facilityIdStr);

        if (!conn && allConns.length > 0) {
            conn = allConns[0];
        }

        if (!conn) {
            this.logger.warn('[WEBHOOK] No active Doctoralia connection found');
            return { processed: false, reason: 'no_connection' };
        }

        const client = this.docplannerService.createClient(
            conn.domain || 'doctoralia.com.br',
            conn.clientId!,
            conn.clientSecret || '',
        );

        return this.processNotification(conn.clinicId, body, client);
    }

    private async processNotification(clinicId: string, notification: any, client: any) {
        const name = notification?.name;
        const data = notification?.data;

        try {
            switch (name) {
                case 'slot-booked':
                    return await this.handleSlotBooked(clinicId, data, notification);
                case 'booking-canceled':
                    return await this.handleBookingCanceled(clinicId, data, notification);
                case 'booking-moved':
                    return await this.handleBookingMoved(clinicId, data, notification);
                default:
                    this.logger.debug(`[NOTIFICATION] Ignoring notification type: ${name}`);
                    return { processed: false, reason: `unsupported_type:${name}` };
            }
        } catch (err: any) {
            this.logger.error(`[NOTIFICATION] Error processing ${name}: ${err.message}`);
            return { processed: false, error: err.message };
        }
    }

    private async handleSlotBooked(clinicId: string, data: any, rawNotification: any) {
        const booking = data?.visit_booking;
        if (!booking?.id) {
            this.logger.warn('[SLOT-BOOKED] No booking ID in notification');
            return { processed: false, reason: 'no_booking_id' };
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
                vismedCreateResult = await this.createVismedAppointment(clinicId, mapping, booking, data);
                this.logger.log(`[SLOT-BOOKED] Created VisMed appointment for booking ${bookingIdStr}`);
            } catch (err: any) {
                this.logger.error(`[SLOT-BOOKED] Failed to create VisMed appointment for booking ${bookingIdStr}: ${err.message}`);
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

        await new Promise(r => setTimeout(r, 1000));

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
                }
            }
        } catch (vismedError) {
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

        await new Promise(r => setTimeout(r, 1000));

        await client.cancelBooking(
            syncRecord.doctoraliaFacilityId || '',
            syncRecord.doctoraliaDoctorId || '',
            syncRecord.doctoraliaAddressId || '',
            doctoraliaBookingId,
            reason,
        );

        await this.prisma.bookingSync.update({
            where: { id: syncRecord.id },
            data: { status: 'CANCELLED', processedAt: new Date() },
        });

        this.logger.log(`[CANCEL] Cancelled booking ${doctoraliaBookingId} on Doctoralia`);
        return { success: true };
    }

    async getBookingSyncRecords(clinicId: string, filters?: {
        doctoraliaDoctorId?: string;
        vismedDoctorId?: string;
        startDate?: string;
        endDate?: string;
        origin?: string;
        status?: string;
    }) {
        const where: any = { clinicId };

        if (filters?.doctoraliaDoctorId) where.doctoraliaDoctorId = filters.doctoraliaDoctorId;
        if (filters?.vismedDoctorId) where.vismedDoctorId = filters.vismedDoctorId;
        if (filters?.origin) where.origin = filters.origin;
        if (filters?.status) where.status = filters.status;

        if (filters?.startDate || filters?.endDate) {
            where.startAt = {};
            if (filters?.startDate) where.startAt.gte = new Date(filters.startDate);
            if (filters?.endDate) where.startAt.lte = new Date(filters.endDate + 'T23:59:59');
        }

        return this.prisma.bookingSync.findMany({
            where,
            orderBy: { startAt: 'asc' },
        });
    }

    async getSyncStats(clinicId: string) {
        const [total, byOrigin, byStatus, recent] = await Promise.all([
            this.prisma.bookingSync.count({ where: { clinicId } }),
            this.prisma.bookingSync.groupBy({
                by: ['origin'],
                where: { clinicId },
                _count: true,
            }),
            this.prisma.bookingSync.groupBy({
                by: ['status'],
                where: { clinicId },
                _count: true,
            }),
            this.prisma.bookingSync.findMany({
                where: { clinicId },
                orderBy: { createdAt: 'desc' },
                take: 10,
            }),
        ]);

        return {
            total,
            byOrigin: byOrigin.reduce((acc, r) => ({ ...acc, [r.origin]: r._count }), {}),
            byStatus: byStatus.reduce((acc, r) => ({ ...acc, [r.status]: r._count }), {}),
            recent,
        };
    }
}
