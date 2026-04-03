import { Injectable, Logger, HttpException, BadRequestException, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerService } from '../integrations/docplanner.service';

@Injectable()
export class AppointmentsService {
    private readonly logger = new Logger(AppointmentsService.name);

    constructor(
        private prisma: PrismaService,
        private docplanner: DocplannerService,
    ) { }

    // ────────────────────── Audit Logging ──────────────────────

    private async logRequest(data: { clinicId: string; action: string; doctorId?: string; start?: string; end?: string; durationMs: number; status: string; error?: string; extraDetails?: any }) {
        try {
            await this.prisma.auditLog.create({
                data: {
                    action: data.action,
                    entity: 'DOCTORALIA_API',
                    entityId: data.doctorId || 'GLOBAL',
                    details: {
                        status: data.status,
                        error: data.error,
                        details: data.extraDetails,
                        clinicId: data.clinicId,
                        doctorId: data.doctorId,
                        dateRange: data.start && data.end ? { start: data.start, end: data.end } : null,
                        durationMs: data.durationMs,
                        requestId: Math.random().toString(36).substring(7),
                    }
                }
            });
        } catch (e: any) {
            this.logger.warn(`Failed to log audit: ${e.message}`);
        }
    }

    // ────────────────────── Calendar Status ──────────────────────

    async getCalendarStatus(clinicId: string) {
        const startTime = Date.now();

        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia' },
        });
        if (!conn || !conn.clientId) {
            await this.logRequest({ clinicId, action: 'FETCH_CALENDAR_STATUS', durationMs: Date.now() - startTime, status: 'blocked', error: 'Integração não configurada' });
            return { integrated: false, message: 'Integração Doctoralia não configurada' };
        }

        try {
            const mappings = await this.prisma.mapping.findMany({
                where: { clinicId, entityType: 'DOCTOR', status: 'LINKED' },
            });

            const client = this.docplanner.createClient(conn.domain || 'doctoralia.com.br', conn.clientId, conn.clientSecret || '');

            let facilityId: string | null = null;
            const needsEnrich = mappings.some(m => {
                const c = m.conflictData as any || {};
                return (!c.facilityId || !c.address?.id) && m.externalId;
            });
            if (needsEnrich) {
                facilityId = await this.resolveFacilityId(client);
            }

            const doctors: any[] = [];
            for (const m of mappings) {
                let cd = m.conflictData as any || {};

                if ((!cd.facilityId || !cd.address?.id) && m.externalId && facilityId) {
                    cd = await this.enrichDoctorData(m, cd, client, facilityId, m.externalId);
                }

                if ((!cd.calendarStatus || cd.calendarStatus === 'unknown') && cd.facilityId && cd.address?.id) {
                    cd = await this.refreshCalendarStatus(m, cd, client, m.externalId);
                }

                doctors.push({
                    externalId: m.externalId,
                    name: `${cd.name || ''} ${cd.surname || ''}`.trim(),
                    calendarStatus: cd.calendarStatus || 'unknown',
                    addressId: cd.address?.id || null,
                    facilityId: cd.facilityId || null,
                });
            }

            const hasAnyEnabled = doctors.some(d => d.calendarStatus === 'enabled');

            await this.logRequest({ clinicId, action: 'FETCH_CALENDAR_STATUS', durationMs: Date.now() - startTime, status: 'success' });

            return {
                integrated: true,
                calendarEnabled: hasAnyEnabled,
                doctors,
                message: hasAnyEnabled
                    ? 'Calendar da Doctoralia está ativo'
                    : 'Calendar da Doctoralia está desabilitado para todos os médicos',
            };
        } catch (e: any) {
            const isTimeout = e.status === 504 || e.message?.includes('timeout');
            await this.logRequest({ clinicId, action: 'FETCH_CALENDAR_STATUS', durationMs: Date.now() - startTime, status: isTimeout ? 'timeout' : 'error', error: e.message });
            return {
                integrated: true,
                calendarEnabled: false,
                doctors: [],
                error: isTimeout ? 'API não respondeu no tempo esperado' : e.message,
                timedOut: isTimeout,
            };
        }
    }

    // ────────────────────── Resolve Facility ID ──────────────────────

    private async resolveFacilityId(client: any): Promise<string | null> {
        try {
            const facRes = await client.getFacilities();
            const facs = facRes._items || [];
            return facs.length > 0 ? String(facs[0].id) : null;
        } catch (e: any) {
            this.logger.warn(`Failed to resolve facilityId: ${e.message}`);
            return null;
        }
    }

    // ────────────────────── Enrich Doctor Data from Doctoralia ──────────────────────

    private async enrichDoctorData(mapping: any, cd: any, client: any, facilityId: string, doctorExternalId: string): Promise<any> {
        try {
            const addrRes = await client.getAddresses(facilityId, doctorExternalId);
            const addresses = addrRes._items || [];
            if (addresses.length === 0) return cd;

            const addr = addresses[0];
            const updatedCd = {
                ...cd,
                facilityId,
                address: {
                    id: addr.id,
                    name: addr.name,
                    city: addr.city_name,
                    street: addr.street,
                    postCode: addr.post_code,
                },
            };

            await this.prisma.mapping.update({
                where: { id: mapping.id },
                data: { conflictData: updatedCd as any, updatedAt: new Date() },
            });

            this.logger.log(`Enriched doctor ${doctorExternalId} with facilityId=${facilityId}, addressId=${addr.id}`);
            return updatedCd;
        } catch (e: any) {
            this.logger.warn(`Failed to enrich doctor ${doctorExternalId}: ${e.message}`);
            return cd;
        }
    }

    // ────────────────────── Refresh Calendar Status from Doctoralia ──────────────────────

    private async refreshCalendarStatus(mapping: any, cd: any, client: any, doctorExternalId: string): Promise<any> {
        if (!cd.facilityId || !cd.address?.id) return cd;

        try {
            const calRes = await client.getCalendar(cd.facilityId, doctorExternalId, String(cd.address.id));
            const status = calRes?.status || 'unknown';
            this.logger.log(`Refreshed calendarStatus for doctor ${doctorExternalId}: ${status}`);

            const updatedCd = { ...cd, calendarStatus: status };
            await this.prisma.mapping.update({
                where: { id: mapping.id },
                data: { conflictData: updatedCd as any, updatedAt: new Date() },
            });
            return updatedCd;
        } catch (e: any) {
            this.logger.warn(`Failed to refresh calendar status for doctor ${doctorExternalId}: ${e.message}`);
            return cd;
        }
    }

    // ────────────────────── Bookings ──────────────────────

    async getBookings(clinicId: string, doctorExternalId: string, start: string, end: string) {
        const startTime = Date.now();

        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia' },
        });
        if (!conn || !conn.clientId) {
            await this.logRequest({ clinicId, action: 'FETCH_BOOKINGS', doctorId: doctorExternalId, start, end, durationMs: Date.now() - startTime, status: 'blocked', error: 'Integração não configurada' });
            return { bookings: [], error: 'Integração não configurada' };
        }

        const mapping = await this.prisma.mapping.findUnique({
            where: { clinicId_entityType_externalId: { clinicId, entityType: 'DOCTOR', externalId: doctorExternalId } },
        });

        if (!mapping) {
            return { bookings: [], error: 'Médico não encontrado' };
        }

        let cd = mapping.conflictData as any || {};
        const client = this.docplanner.createClient(conn.domain || 'doctoralia.com.br', conn.clientId, conn.clientSecret || '');

        if (!cd.facilityId || !cd.address?.id) {
            const facilityId = await this.resolveFacilityId(client);
            if (facilityId) {
                cd = await this.enrichDoctorData(mapping, cd, client, facilityId, doctorExternalId);
            }
            if (!cd.facilityId || !cd.address?.id) {
                return { bookings: [], error: 'Dados de endereço incompletos. Execute uma sincronização com enriquecimento.' };
            }
        }

        if (!cd.calendarStatus || cd.calendarStatus === 'unknown') {
            cd = await this.refreshCalendarStatus(mapping, cd, client, doctorExternalId);
        }

        if (cd.calendarStatus === 'disabled') {
            await this.logRequest({ clinicId, action: 'FETCH_BOOKINGS', doctorId: doctorExternalId, start, end, durationMs: Date.now() - startTime, status: 'blocked', error: 'Calendar desabilitado' });
            return { bookings: [], calendarStatus: cd.calendarStatus, blocked: true, error: 'Calendar desabilitado para este médico' };
        }

        try {
            const bookingsRes = await client.getBookings(cd.facilityId, doctorExternalId, cd.address.id, start, end);

            await this.logRequest({ clinicId, action: 'FETCH_BOOKINGS', doctorId: doctorExternalId, start, end, durationMs: Date.now() - startTime, status: 'success' });
            const list = Array.isArray(bookingsRes) ? bookingsRes : (bookingsRes?._items || []);
            return { bookings: list, calendarStatus: cd.calendarStatus };
        } catch (e: any) {
            const isHttp = e instanceof HttpException;
            const details = isHttp ? (e.getResponse() as any).details : null;
            const isTimeout = e.status === 504 || e.message?.includes('timeout') || e.message?.includes('não respondeu');
            await this.logRequest({ 
                clinicId, 
                action: 'FETCH_BOOKINGS', 
                doctorId: doctorExternalId, 
                start, 
                end, 
                durationMs: Date.now() - startTime, 
                status: isTimeout ? 'timeout' : 'error', 
                error: e.message,
                extraDetails: details
            });
            return { bookings: [], error: isTimeout ? 'API não respondeu no tempo esperado' : e.message, details, calendarStatus: cd.calendarStatus, timedOut: isTimeout };
        }
    }

    // ────────────────────── Slots ──────────────────────

    async getSlots(clinicId: string, doctorExternalId: string, start: string, end: string) {
        const startTime = Date.now();

        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia' },
        });
        if (!conn || !conn.clientId) {
            await this.logRequest({ clinicId, action: 'FETCH_SLOTS', doctorId: doctorExternalId, start, end, durationMs: Date.now() - startTime, status: 'blocked', error: 'Integração não configurada' });
            return { slots: [], error: 'Integração não configurada' };
        }

        const mapping = await this.prisma.mapping.findUnique({
            where: { clinicId_entityType_externalId: { clinicId, entityType: 'DOCTOR', externalId: doctorExternalId } },
        });

        if (!mapping) {
            return { slots: [], error: 'Médico não encontrado' };
        }

        let cd = mapping.conflictData as any || {};
        const client = this.docplanner.createClient(conn.domain || 'doctoralia.com.br', conn.clientId, conn.clientSecret || '');

        if (!cd.facilityId || !cd.address?.id) {
            const facilityId = await this.resolveFacilityId(client);
            if (facilityId) {
                cd = await this.enrichDoctorData(mapping, cd, client, facilityId, doctorExternalId);
            }
            if (!cd.facilityId || !cd.address?.id) {
                return { slots: [], error: 'Dados de endereço incompletos.' };
            }
        }

        if (!cd.calendarStatus || cd.calendarStatus === 'unknown') {
            cd = await this.refreshCalendarStatus(mapping, cd, client, doctorExternalId);
        }

        if (cd.calendarStatus === 'disabled') {
            await this.logRequest({ clinicId, action: 'FETCH_SLOTS', doctorId: doctorExternalId, start, end, durationMs: Date.now() - startTime, status: 'blocked', error: 'Calendar desabilitado' });
            return { slots: [], calendarStatus: cd.calendarStatus, blocked: true, error: 'Calendar desabilitado para este médico' };
        }

        try {
            const slotsRes = await client.getSlots(cd.facilityId, doctorExternalId, cd.address.id, start, end);

            await this.logRequest({ clinicId, action: 'FETCH_SLOTS', doctorId: doctorExternalId, start, end, durationMs: Date.now() - startTime, status: 'success' });
            const list = Array.isArray(slotsRes) ? slotsRes : (slotsRes?._items || []);
            return { slots: list, calendarStatus: cd.calendarStatus };
        } catch (e: any) {
            const isTimeout = e.status === 504 || e.message?.includes('timeout') || e.message?.includes('não respondeu');
            const details = e instanceof HttpException ? e.getResponse() : null;
            await this.logRequest({ clinicId, action: 'FETCH_SLOTS', doctorId: doctorExternalId, start, end, durationMs: Date.now() - startTime, status: isTimeout ? 'timeout' : 'error', error: e.message, extraDetails: details });
            return { slots: [], error: isTimeout ? 'API não respondeu no tempo esperado' : e.message, calendarStatus: cd.calendarStatus, timedOut: isTimeout };
        }
    }

    async replaceSlots(clinicId: string, doctorExternalId: string, slots: any[]) {
        const startTime = Date.now();
        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia' },
        });
        if (!conn || !conn.clientId) {
            throw new Error('Integração Doctoralia não configurada');
        }

        const mapping = await this.prisma.mapping.findUnique({
            where: { clinicId_entityType_externalId: { clinicId, entityType: 'DOCTOR', externalId: doctorExternalId } },
        });
        if (!mapping) throw new Error('Médico não encontrado');

        const cd = mapping.conflictData as any || {};
        if (!cd.facilityId || !cd.address?.id) throw new Error('Dados de endereço incompletos.');

        try {
            const client = this.docplanner.createClient(conn.domain || 'doctoralia.com.br', conn.clientId, conn.clientSecret || '');
            
            // Defensive: ensure each slot has a valid address_service_id
            let defaultServiceId = 0;
            for (const slot of slots) {
                for (const srv of (slot.address_services || [])) {
                    if (srv.address_service_id === 0 || !srv.address_service_id) {
                        // Need a default. Try the first one mapped if we can find it
                        if (defaultServiceId === 0) {
                            const servicesRes = await client.getServices(cd.facilityId, doctorExternalId, cd.address.id);
                            defaultServiceId = servicesRes._items?.[0]?.id || 0;
                        }
                        srv.address_service_id = defaultServiceId;
                    }
                }
            }

            const res = await client.replaceSlots(cd.facilityId, doctorExternalId, cd.address.id, { slots });
            await this.logRequest({ clinicId, action: 'REPLACE_SLOTS', doctorId: doctorExternalId, durationMs: Date.now() - startTime, status: 'success' });
            return res;
        } catch (e: any) {
            this.logger.error(`Failed to replace slots for doctor ${doctorExternalId}: ${e.message}`, e.stack);
            await this.logRequest({ clinicId, action: 'REPLACE_SLOTS', doctorId: doctorExternalId, durationMs: Date.now() - startTime, status: 'error', error: e.message });
            throw e;
        }
    }

    async bookSlot(clinicId: string, doctorExternalId: string, payload: any) {
        const startTime = Date.now();
        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia' },
        });
        if (!conn || !conn.clientId) {
            throw new Error('Integração Doctoralia não configurada');
        }

        const mapping = await this.prisma.mapping.findUnique({
            where: { clinicId_entityType_externalId: { clinicId, entityType: 'DOCTOR', externalId: doctorExternalId } },
        });
        if (!mapping) throw new Error('Médico não encontrado');

        const cd = mapping.conflictData as any || {};
        if (!cd.facilityId || !cd.address?.id) throw new Error('Dados de endereço incompletos.');

        try {
            const client = this.docplanner.createClient(conn.domain || 'doctoralia.com.br', conn.clientId, conn.clientSecret || '');
            const slotStart = payload.start;
            const bookBody = { ...payload };
            delete bookBody.start;
            const res = await client.bookSlot(cd.facilityId, doctorExternalId, cd.address.id, slotStart, bookBody);
            await this.logRequest({ clinicId, action: 'BOOK_SLOT', doctorId: doctorExternalId, durationMs: Date.now() - startTime, status: 'success' });
            return res;
        } catch (e: any) {
            await this.logRequest({ clinicId, action: 'BOOK_SLOT', doctorId: doctorExternalId, durationMs: Date.now() - startTime, status: 'error', error: e.message });
            throw e;
        }
    }

    async deleteSlots(clinicId: string, doctorExternalId: string, start: string, end: string) {
        const startTime = Date.now();
        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia' },
        });
        if (!conn || !conn.clientId) {
            throw new Error('Integração Doctoralia não configurada');
        }

        const mapping = await this.prisma.mapping.findUnique({
            where: { clinicId_entityType_externalId: { clinicId, entityType: 'DOCTOR', externalId: doctorExternalId } },
        });
        if (!mapping) throw new Error('Médico não encontrado');

        const cd = mapping.conflictData as any || {};
        if (!cd.facilityId || !cd.address?.id) throw new Error('Dados de endereço incompletos.');

        try {
            const client = this.docplanner.createClient(conn.domain || 'doctoralia.com.br', conn.clientId, conn.clientSecret || '');
            const startDate = new Date(start.split('T')[0]);
            const endDate = new Date(end.split('T')[0]);
            let deletedDays = 0;
            for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                const dateStr = d.toISOString().split('T')[0];
                await client.deleteSlots(cd.facilityId, doctorExternalId, cd.address.id, dateStr);
                deletedDays++;
            }
            await this.logRequest({ clinicId, action: 'DELETE_SLOTS', doctorId: doctorExternalId, start, end, durationMs: Date.now() - startTime, status: 'success' });
            return { success: true, deletedDays };
        } catch (e: any) {
            const isHttp = e instanceof HttpException;
            const details = isHttp ? (e.getResponse() as any).details : null;
            await this.logRequest({ 
                clinicId, 
                action: 'DELETE_SLOTS', 
                doctorId: doctorExternalId, 
                start, 
                end, 
                durationMs: Date.now() - startTime, 
                status: 'error', 
                error: e.message,
                extraDetails: details 
            });
            throw e;
        }
    }

    // ────────────────────── All Bookings ──────────────────────

    async getAllBookings(clinicId: string, start: string, end: string) {
        const startTime = Date.now();

        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia' },
        });
        if (!conn || !conn.clientId) {
            return { bookings: [], calendarEnabled: false, error: 'Integração não configurada' };
        }

        const mappings = await this.prisma.mapping.findMany({
            where: { clinicId, entityType: 'DOCTOR' },
        });

        const allBookings: any[] = [];
        let calendarEnabled = false;
        const errors: string[] = [];

        const client = this.docplanner.createClient(conn.domain || 'doctoralia.com.br', conn.clientId, conn.clientSecret || '');

        for (const m of mappings) {
            let cd = m.conflictData as any || {};

            if ((!cd.calendarStatus || cd.calendarStatus === 'unknown') && cd.facilityId && cd.address?.id) {
                cd = await this.refreshCalendarStatus(m, cd, client, m.externalId);
            }

            if (cd.calendarStatus === 'enabled' && cd.facilityId && cd.address?.id) {
                calendarEnabled = true;
                try {
                    const res = await client.getBookings(cd.facilityId, m.externalId || '', cd.address.id, start, end);
                    const items = (res._items || []).map((b: any) => ({
                        ...b,
                        doctorName: `${cd.name || ''} ${cd.surname || ''}`.trim(),
                        doctorExternalId: m.externalId,
                    }));
                    allBookings.push(...items);
                } catch (e: any) {
                    this.logger.warn(`Bookings for doctor ${m.externalId}: ${e.message}`);
                    errors.push(`${cd.name}: ${e.message}`);
                }
            }
        }

        await this.logRequest({ clinicId, action: 'FETCH_ALL_BOOKINGS', start, end, durationMs: Date.now() - startTime, status: errors.length ? 'error' : 'success', error: errors.length ? errors.join('; ') : undefined });

        return { bookings: allBookings, calendarEnabled, errors: errors.length ? errors : undefined };
    }

    // ────────────────────── Dashboard Stats ──────────────────────

    async dashboardStats(clinicId: string) {
        const status = await this.getCalendarStatus(clinicId);
        return {
            calendarEnabled: status.calendarEnabled || false,
            totalDoctors: status.doctors?.length || 0,
            doctorsWithCalendar: (status.doctors || []).filter((d: any) => d.calendarStatus === 'enabled').length,
            message: status.message,
        };
    }

    // ────────────────────── Update Calendar Status (SPRINT 8) ──────────────────────
    async updateCalendarStatus(clinicId: string, doctorExternalId: string, status: 'enabled' | 'disabled', userId?: string) {
        const startTime = Date.now();

        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia' },
        });
        if (!conn || !conn.clientId) {
            throw new Error('Integração Doctoralia não configurada');
        }

        const mapping = await this.prisma.mapping.findUnique({
            where: { clinicId_entityType_externalId: { clinicId, entityType: 'DOCTOR', externalId: doctorExternalId } }
        });
        if (!mapping) {
            throw new NotFoundException('Mapeamento do médico não encontrado');
        }

        const cd = mapping.conflictData as any || {};
        if (!cd.facilityId || !cd.address?.id) {
            throw new BadRequestException('Dados de endereço ausentes para este médico. Realize uma sincronização primeiro.');
        }

        try {
            const client = this.docplanner.createClient(conn.domain || 'doctoralia.com.br', conn.clientId, conn.clientSecret || '');
            
            this.logger.log(`Performing ${status} action for calendar of doctor ${doctorExternalId} (Address: ${cd.address.id})`);
            
            if (status === 'enabled') {
                try {
                await client.enableCalendar(cd.facilityId, doctorExternalId, cd.address.id);
                } catch (e: any) {
                    if (e.status !== 409) throw e;
                    this.logger.warn(`Calendar already enabled in Doctoralia for ${doctorExternalId}`);
                }
            } else {
                try {
                await client.disableCalendar(cd.facilityId, doctorExternalId, cd.address.id);
                } catch (e: any) {
                    if (e.status !== 409) throw e;
                    this.logger.warn(`Calendar already disabled in Doctoralia for ${doctorExternalId}`);
                }
            }

            // Verify final status
            const current = await client.getCalendar(cd.facilityId, doctorExternalId, cd.address.id);
            this.logger.log(`Verified calendar status from Doctoralia: ${JSON.stringify(current)}`);
            const verifiedStatus = (current?.enabled === true || current?.status === 'enabled') ? 'enabled' : 'disabled';

            // Update local cache in conflictData
            const newConflictData = {
                ...cd,
                calendarStatus: verifiedStatus
            };

            await this.prisma.mapping.update({
                where: { id: mapping.id },
                data: { 
                    conflictData: newConflictData as any,
                    updatedAt: new Date()
                }
            });

            // Audit
            await this.prisma.auditLog.create({
                data: {
                    userId,
                    action: 'UPDATE_CALENDAR_STATUS',
                    entity: 'Mapping',
                    entityId: mapping.id,
                    details: { doctorExternalId, requestedStatus: status, finalStatus: verifiedStatus }
                }
            });

            await this.logRequest({ clinicId, action: 'UPDATE_CALENDAR_STATUS', doctorId: doctorExternalId, durationMs: Date.now() - startTime, status: 'success' });

            return { success: true, status: verifiedStatus };
        } catch (e: any) {
            this.logger.error(`Failed to update calendar status: ${e.message}`, e.stack);
            await this.logRequest({ clinicId, action: 'UPDATE_CALENDAR_STATUS', doctorId: doctorExternalId, durationMs: Date.now() - startTime, status: 'error', error: e.message });
            
            if (e instanceof HttpException) throw e;
            throw new InternalServerErrorException(e.message || 'Falha ao atualizar status do calendário');
        }
    }
}
