import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerService } from '../integrations/docplanner.service';
import { RateLimiterService } from './rate-limiter.service';
import { consultationRecords } from './consultation-policy';

const fields = {
    id: true, clinicId: true, patientName: true, patientSurname: true, status: true,
    startAt: true, endAt: true, vismedAppointmentId: true, doctoraliaBookingId: true,
    doctoraliaBreakId: true, doctoraliaDoctorId: true, doctoraliaAddressId: true,
    doctoraliaFacilityId: true, syncedToDoctoralia: true, syncError: true,
    rawPayload: true, addressServiceId: true,
} as const;
const displayRecord = (r: any) => ({
    id: r.id, patientName: [r.patientName, r.patientSurname].filter(Boolean).join(' '),
    startAt: r.startAt, endAt: r.endAt, status: r.status,
    synchronized: r.syncedToDoctoralia === true && !r.syncError && !!(r.doctoraliaBreakId || r.doctoraliaBookingId),
});

@Injectable()
export class BookingConflictsService {
    constructor(private readonly prisma: PrismaService, private readonly docplanner: DocplannerService,
        private readonly limiter: RateLimiterService) {}

    async inspect(clinicId: string, id: string) {
        const record = await this.prisma.bookingSync.findFirst({ where: { id, clinicId }, select: fields });
        if (!record) throw new NotFoundException('Agendamento não encontrado nesta clínica');
        const base = { checkedAt: new Date().toISOString(), overlaps: [] as any[], sameNameBookings: [] as any[] };
        if (!record.doctoraliaDoctorId) return { ...base, availability: 'unavailable', reason: 'Não há profissional Doctoralia identificado para esta consulta.' };

        // Identical names/times are evidence of similar records, not proof of duplicate patients.
        if (record.patientName && record.vismedAppointmentId) {
            const similar = await this.prisma.bookingSync.findMany({ where: {
                clinicId, id: { not: id }, doctoraliaDoctorId: record.doctoraliaDoctorId,
                startAt: record.startAt, endAt: record.endAt, patientName: record.patientName,
                patientSurname: record.patientSurname,
                vismedAppointmentId: { not: record.vismedAppointmentId },
            }, select: fields });
            base.sameNameBookings = (await consultationRecords(this.prisma, similar)).filter(r => r.vismedAppointmentId).map(displayRecord);
        }

        let facilityId = record.doctoraliaFacilityId;
        let addressId = record.doctoraliaAddressId;
        if (!facilityId || !addressId) {
            const mappings = await this.prisma.mapping.findMany({ where: {
                clinicId, entityType: 'DOCTOR', status: 'LINKED', externalId: record.doctoraliaDoctorId,
            }, select: { conflictData: true } });
            const scopes = mappings.map(m => m.conflictData as any)
                .filter(d => d?.facilityId && d?.address?.id)
                .map(d => ({ facility: String(d.facilityId), address: String(d.address.id) }))
                .filter(s => (!facilityId || s.facility === facilityId) && (!addressId || s.address === addressId));
            const unique = [...new Map(scopes.map(s => [`${s.facility}:${s.address}`, s])).values()];
            if (unique.length !== 1) return { ...base, availability: 'unavailable', reason: 'O endereço da Doctoralia não pôde ser identificado sem ambiguidade.' };
            facilityId = unique[0].facility; addressId = unique[0].address;
        }
        const conn = await this.prisma.integrationConnection.findFirst({ where: {
            clinicId, provider: 'doctoralia', status: { not: 'disconnected' },
        } });
        if (!conn?.clientId || !conn.clientSecret) return { ...base, availability: 'unavailable', reason: 'Integração Doctoralia indisponível para consulta.' };

        let response: any;
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(record.startAt);
        const windowStart = new Date(`${day}T00:00:00-03:00`);
        const windowEnd = new Date(Math.max(windowStart.getTime() + 86400000, record.endAt.getTime()));
        const brasiliaTimestamp = (date: Date) => new Date(date.getTime() - 3 * 3600000).toISOString().slice(0, 19) + '-03:00';
        try {
            await this.limiter.acquire('doctoralia');
            const client = this.docplanner.createClient(conn.domain || 'doctoralia.com.br', conn.clientId, conn.clientSecret);
            // Doctoralia requires a date window. Read the day, not only the appointment start.
            // Absence in this window never establishes that the pending operation was resolved.
            response = await client.getCalendarBreaks(facilityId!, record.doctoraliaDoctorId, addressId!,
                brasiliaTimestamp(windowStart), brasiliaTimestamp(windowEnd));
        } catch {
            return { ...base, availability: 'unavailable', reason: 'Não foi possível consultar os bloqueios na Doctoralia. A pendência continua sem resolução confirmada.' };
        }
        const items = Array.isArray(response) ? response : response?._items;
        if (!Array.isArray(items) || items.some(b => !b?.id || !Number.isFinite(Date.parse(b.since)) || !Number.isFinite(Date.parse(b.till)) || Date.parse(b.till) <= Date.parse(b.since))) {
            return { ...base, availability: 'unavailable', reason: 'A resposta da Doctoralia não permitiu conferir os intervalos dos bloqueios.' };
        }
        const overlaps = [...new Map(items.filter(b => Date.parse(b.since) < record.endAt.getTime()
            && Date.parse(b.till) > record.startAt.getTime()).map(b => [String(b.id), b])).values()];
        const associations = overlaps.length ? await this.prisma.bookingSync.findMany({ where: {
            clinicId, id: { not: id }, doctoraliaDoctorId: record.doctoraliaDoctorId,
            doctoraliaFacilityId: facilityId, doctoraliaAddressId: addressId,
            doctoraliaBreakId: { in: overlaps.map(b => String(b.id)) },
        }, select: fields }) : [];
        return {
            ...base,
            availability: response?._links?.next || response?._total > items.length ? 'partial' : 'complete',
            overlaps: overlaps.map(b => ({ startAt: b.since, endAt: b.till,
                relatedBookings: associations.filter(r => r.doctoraliaBreakId === String(b.id)).map(displayRecord),
            })),
        };
    }
}
