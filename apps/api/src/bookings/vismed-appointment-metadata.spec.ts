import { vismedAppointmentMetadata } from './vismed-appointment-metadata';
import { BookingSyncService } from './booking-sync.service';

describe('VissMed appointment metadata', () => {
    it.each(['Consulta', 'Exame', 'Procedimento'])('classifies %s', type => {
        expect(vismedAppointmentMetadata({ tipo_servico: ` ${type.toUpperCase()} ` }).appointmentType).toBe(type);
    });
    it.each([null, undefined, {}, { tipo_servico: 'unknown' }, { tipo_servico: 'constructor' }, { tipo_servico: 1 }])('does not invent a type: %p', raw => {
        expect(vismedAppointmentMetadata(raw).appointmentType).toBeNull();
    });
    it.each([0, '0', false])('recognizes explicit disabled flag %p', flag => {
        expect(vismedAppointmentMetadata({ mostrarnadoctoralia: flag }).professionalDoctoraliaEnabled).toBe(false);
    });
    it.each([1, '1', true])('recognizes enabled flag %p', flag => {
        expect(vismedAppointmentMetadata({ mostrarnadoctoralia: flag }).professionalDoctoraliaEnabled).toBe(true);
    });
    it.each([null, undefined, '', 'false', 2])('unknown flag remains unknown: %p', flag => {
        expect(vismedAppointmentMetadata({ mostrarnadoctoralia: flag }).professionalDoctoraliaEnabled).toBeNull();
    });
    it('returns persisted metadata without remote calls or writes and keeps clinic scoping', async () => {
        const service: any = Object.create(BookingSyncService.prototype);
        service.prisma = { bookingSync: { findMany: jest.fn().mockResolvedValue([
            { id: 'consultation-1', rawPayload: { tipo_servico: 'Consulta', mostrarnadoctoralia: '0' } },
            { id: 'legacy-1', rawPayload: null },
        ]) } };
        const result = await service.getBookingSyncRecords('clinic-a');
        expect(service.prisma.bookingSync.findMany).toHaveBeenCalledWith({ where: { clinicId: 'clinic-a' }, orderBy: { startAt: 'asc' } });
        expect(result[0]).toMatchObject({ appointmentType: 'Consulta', professionalDoctoraliaEnabled: false });
        expect(result).toHaveLength(1);
    });
    it.each(['BOOKED', 'CONFIRMED', 'CANCELLED'])('does not mutate Doctoralia for disabled professional (%s)', async status => {
        const service: any = Object.create(BookingSyncService.prototype);
        const record = { origin: 'VISMED', vismedDoctorId: 'doctor-1', status, doctoraliaBreakId: 'shared-break', rawPayload: { mostrarnadoctoralia: '0' } };
        service.prisma = { bookingSync: { findUnique: jest.fn().mockResolvedValue(record) }, mapping: { findFirst: jest.fn() } };
        await service.syncDoctoraliaBreak('booking-1');
        expect(service.prisma.mapping.findFirst).not.toHaveBeenCalled();
        expect(record.doctoraliaBreakId).toBe('shared-break');
        expect(record.status).toBe(status);
    });
});
