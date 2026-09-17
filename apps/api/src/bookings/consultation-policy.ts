import { vismedAppointmentMetadata } from './vismed-appointment-metadata';

// Explicit Brazilian dictionary IDs verified with GET /api/v3/integration/services.
// Not address_service IDs. Mixed/ambiguous services are deliberately absent.
export const CONSULTATION_SERVICE_IDS = new Set([
    '291', '637', '639', '641', '648', '653', '656', '659', '663', '666',
    '667', '669', '670', '674', '675', '678', '680', '690', '691', '693',
    '694', '696', '697', '699', '700', '701', '705', '707', '709', '714',
    '715', '813', '818', '830', '845', '846', '1736', '4071', '4074',
    '4075', '4077', '4079', '4080', '4122', '4123', '4125', '4133',
    '4147', '4152', '4156', '4174', '5039', '5044', '5072', '5141', '5232', '9470',
]);

export function isVismedConsultation(raw: unknown): boolean {
    return vismedAppointmentMetadata(raw).appointmentType === 'Consulta';
}

/** Read-only classification. No remote calls, writes, or name-based inference. */
export async function isConsultationRecord(prisma: any, record: any, cache = new Map<string, Promise<any>>()): Promise<boolean> {
    if (!record) return false;
    const raw = record.rawPayload;
    // A VissMed response is authoritative, even if missing/unknown or contradicted
    // by an old Doctoralia service. Never resurrect an exam using its service ID.
    if (raw && typeof raw === 'object' && ('tipo_servico' in raw || 'idpacienteagendamento' in raw)) {
        return isVismedConsultation(raw);
    }
    const booking = raw?.data?.new_visit_booking || raw?.data?.visit_booking || raw?.data?.booking;
    const addressServiceId = booking?.address_service?.id || record.addressServiceId;
    if (!record.clinicId || !addressServiceId) return false;
    const connectionKey = `clinic:${record.clinicId}`;
    if (!cache.has(connectionKey)) cache.set(connectionKey, prisma.integrationConnection.findFirst({
        where: { clinicId: record.clinicId, provider: 'doctoralia' }, select: { domain: true },
    }));
    const connection = await cache.get(connectionKey);
    if (!connection || !['doctoralia.com.br', 'www.doctoralia.com.br'].includes(connection.domain || 'doctoralia.com.br')) return false;
    const serviceKey = `service:${addressServiceId}`;
    if (!cache.has(serviceKey)) cache.set(serviceKey, prisma.doctoraliaAddressService.findUnique({
        where: { doctoraliaAddressServiceId: String(addressServiceId) },
        include: { service: true },
    }));
    const service = await cache.get(serviceKey);
    return !!service && CONSULTATION_SERVICE_IDS.has(String(service.service?.doctoraliaServiceId));
}

export async function consultationRecords(prisma: any, records: any[]): Promise<any[]> {
    const result: any[] = [];
    const cache = new Map<string, Promise<any>>();
    for (const record of records) if (await isConsultationRecord(prisma, record, cache)) result.push(record);
    return result;
}

export async function canSynchronizeConsultation(prisma: any, record: any): Promise<boolean> {
    return vismedAppointmentMetadata(record?.rawPayload).professionalDoctoraliaEnabled !== false
        && await isConsultationRecord(prisma, record);
}

export function preserveAppointmentMetadata(notification: any, existing: any): any {
    const raw = existing?.rawPayload;
    if (!raw || typeof raw !== 'object' || !('tipo_servico' in raw)) return notification;
    return { ...notification, tipo_servico: raw.tipo_servico,
        ...(raw.mostrarnadoctoralia !== undefined ? { mostrarnadoctoralia: raw.mostrarnadoctoralia } : {}) };
}

export async function filterDoctoraliaBookings(prisma: any, clinicId: string, bookings: any[]): Promise<any[]> {
    if (!bookings.length) return [];
    const known = await prisma.bookingSync.findMany({
        where: { clinicId, doctoraliaBookingId: { in: bookings.map(b => String(b.id || b.visit_booking_id || '')) } },
        select: { doctoraliaBookingId: true, rawPayload: true },
    });
    const byId = new Map<string, any>(known.map((r: any) => [String(r.doctoraliaBookingId), r]));
    const cache = new Map<string, Promise<any>>();
    const result: any[] = [];
    for (const booking of bookings) {
        const raw = byId.get(String(booking.id || booking.visit_booking_id || ''))?.rawPayload;
        if (raw && typeof raw === 'object' && ('tipo_servico' in raw || 'idpacienteagendamento' in raw)
            && !isVismedConsultation(raw)) continue;
        if (await isConsultationRecord(prisma, { clinicId, rawPayload: { data: { visit_booking: booking } } }, cache)) {
            result.push({ ...booking, appointmentType: 'Consulta' });
        }
    }
    return result;
}

export function consultationSlotServices(services: any[], domain: string): any[] {
    if (!['doctoralia.com.br', 'www.doctoralia.com.br'].includes(domain)) return [];
    return services.filter(s => CONSULTATION_SERVICE_IDS.has(String(s.service_id)));
}
