import { BookingSyncService } from './booking-sync.service';

describe('consultation-only flow', () => {
    const excluded = ['Exame', 'Procedimento', '', 'desconhecido', null, undefined];
    function harness() {
        const service: any = Object.create(BookingSyncService.prototype);
        const records: any[] = [];
        service.prisma = {
            bookingSync: {
                findMany: jest.fn().mockImplementation(async () => records),
                findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), upsert: jest.fn(),
            },
            vismedDoctor: { findUnique: jest.fn().mockResolvedValue(null) },
            doctoraliaAddressService: { findUnique: jest.fn().mockResolvedValue(null) },
        };
        service.logger = { warn: jest.fn(), debug: jest.fn(), log: jest.fn() };
        service.ensureVismedDoctorFromAppointment = jest.fn().mockResolvedValue(null);
        return { service, records };
    }
    it.each(excluded)('does not import %p or discover its doctor', async tipo_servico => {
        const { service } = harness();
        await service.upsertVismedAppointment('clinic', { idpacienteagendamento: 'appt', idprofissional: 1,
            dataagendamento: '2030-01-01', horarioagendamento: '09:00', tipo_servico });
        expect(service.prisma.vismedDoctor.findUnique).not.toHaveBeenCalled();
        expect(service.prisma.bookingSync.upsert).not.toHaveBeenCalled();
    });
    it('agenda and counters include only consultations', async () => {
        const { service, records } = harness();
        for (const tipo_servico of ['Consulta', ...excluded]) records.push({ id: String(records.length),
            origin: 'VISMED', status: 'BOOKED', rawPayload: { tipo_servico } });
        const result = await service.getBookingSyncRecords('clinic');
        expect(result.map((r: any) => r.id)).toEqual(['0']);
        expect(await service.getSyncStats('clinic')).toEqual({ total: 1, booked: 1, failed: 0, cancelled: 0 });
    });
    it.each(['syncDoctoraliaBreak', 'propagateVismedCancellationToDoctoralia',
        'propagateDoctoraliaCancellationToVismed', 'propagateVismedRescheduleToDoctoralia',
        'propagateDoctoraliaRescheduleToVismed'])('%s preserves excluded historic records', async method => {
        const { service } = harness();
        const record = { id: 'historic', origin: 'VISMED', vismedDoctorId: 'doc', status: 'CANCELLED',
            rawPayload: { tipo_servico: 'Exame' }, doctoraliaBreakId: 'shared' };
        service.prisma.bookingSync.findUnique.mockResolvedValue(record);
        await service[method]('historic', new Date());
        expect(service.prisma.bookingSync.update).not.toHaveBeenCalled();
        expect(record.doctoraliaBreakId).toBe('shared');
    });
});
