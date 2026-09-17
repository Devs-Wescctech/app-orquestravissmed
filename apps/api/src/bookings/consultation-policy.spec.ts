import { BookingSyncService } from './booking-sync.service';
import { canSynchronizeConsultation, consultationRecords, isConsultationRecord, preserveAppointmentMetadata, filterDoctoraliaBookings, consultationSlotServices } from './consultation-policy';

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
        expect(service.prisma.bookingSync.updateMany).toHaveBeenCalledWith({
            where: { clinicId: 'clinic', vismedAppointmentId: 'appt' },
            data: { rawPayload: expect.objectContaining({ tipo_servico }) },
        });
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
    it.each(['Exame', 'Procedimento', undefined])('does not confirm a created VissMed %p as a consultation', async tipo_servico => {
        const { service } = harness();
        service.vismedService = { getAgendamentoById: jest.fn().mockResolvedValue([{ idpacienteagendamento: 'appt', tipo_servico }]) };
        expect(await service.verifyVismedAppointmentByOfficialIdContract('clinic', 'appt')).toBe('unverified');
    });
    it.each(['Exame', 'Procedimento', undefined])('webhook/retry handlers ignore historic %p without writes', async tipo_servico => {
        const { service } = harness();
        service.prisma.bookingSync.findUnique.mockResolvedValue({ id: 'historic', rawPayload: { tipo_servico } });
        const data = { visit_booking: { id: 'remote' } };
        for (const method of ['handleSlotBooked', 'handleBookingCanceled', 'handleBookingMoved']) {
            expect(await service[method]('clinic', data, { data })).toMatchObject({ processed: false, reason: 'not_confirmed_consultation' });
        }
        expect(service.prisma.bookingSync.update).not.toHaveBeenCalled();
        expect(service.prisma.bookingSync.upsert).not.toHaveBeenCalled();
    });
    it.each(['Exame', 'Procedimento', undefined])('manual cancellation cannot remove historical %p break', async tipo_servico => {
        const { service } = harness();
        await expect(service.cancelSyncRecord('clinic', { rawPayload: { tipo_servico }, doctoraliaBreakId: 'shared' }))
            .rejects.toThrow('não confirmado como consulta');
        expect(service.prisma.bookingSync.update).not.toHaveBeenCalled();
    });
});

describe('verified Doctoralia catalog policy', () => {
    function catalog(id = '291', domain: string | null = 'www.doctoralia.com.br') {
        return {
            integrationConnection: { findFirst: jest.fn().mockResolvedValue({ domain }) },
            doctoraliaAddressService: { findUnique: jest.fn().mockResolvedValue({ service: { doctoraliaServiceId: id } }) },
        };
    }
    const record = { clinicId: 'clinic', addressServiceId: 'address-999' };
    it.each(['291', '5232', '5044', '813'])('accepts verified dictionary ID %s', async id => {
        const db = catalog(id);
        expect(await isConsultationRecord(db, record)).toBe(true);
        expect(db.doctoraliaAddressService.findUnique).toHaveBeenCalledWith({
            where: { doctoraliaAddressServiceId: 'address-999' }, include: { service: true },
        });
    });
    it.each(['7580', '11151', '5549', '5284', '4821', '9978', '5189', 'unknown'])('rejects exam, procedure, mixed or unclassified ID %s', async id => {
        expect(await isConsultationRecord(catalog(id), { ...record, serviceName: 'Consulta médica' })).toBe(false);
    });
    it('does not use an address-service ID as a dictionary ID', async () => {
        expect(await isConsultationRecord(catalog('7580'), { ...record, addressServiceId: '291' })).toBe(false);
    });
    it.each(['znanylekarz.pl', 'doctoralia.es'])('never applies Brazilian IDs to %s', async domain => {
        expect(await isConsultationRecord(catalog('291', domain), record)).toBe(false);
    });
    it.each([null, {}, { rawPayload: 'invalid' }, { rawPayload: [] }])('holds incomplete record %p', async rec => {
        expect(await isConsultationRecord({}, rec)).toBe(false);
    });
    it.each(['Exame', 'Procedimento', null])('VissMed %p vetoes an old consultation service', async tipo_servico => {
        const db = catalog();
        expect(await isConsultationRecord(db, { ...record, rawPayload: { tipo_servico } })).toBe(false);
        expect(db.doctoraliaAddressService.findUnique).not.toHaveBeenCalled();
    });
    it('legacy VissMed payload without type is not consultation', async () => {
        expect(await isConsultationRecord(catalog(), { ...record, rawPayload: { idpacienteagendamento: 'a' } })).toBe(false);
    });
    it('preserves classification through cancellation/move notifications', () => {
        expect(preserveAppointmentMetadata({ name: 'booking-moved' }, { rawPayload: { tipo_servico: 'Consulta', mostrarnadoctoralia: '0' } }))
            .toEqual({ name: 'booking-moved', tipo_servico: 'Consulta', mostrarnadoctoralia: '0' });
    });
    it.each(['0', 0, false])('disabled consultation remains visible but cannot synchronize (%p)', async flag => {
        const rec = { ...record, rawPayload: { tipo_servico: 'Consulta', mostrarnadoctoralia: flag } };
        expect(await consultationRecords({}, [rec])).toEqual([rec]);
        expect(await canSynchronizeConsultation({}, rec)).toBe(false);
    });
    it('reads current service from move payload, not stale record field', async () => {
        const db = catalog('7580');
        expect(await isConsultationRecord(db, { ...record, rawPayload: { data: { new_visit_booking: { address_service: { id: 'new-exam-address' } } } } })).toBe(false);
        expect(db.doctoraliaAddressService.findUnique.mock.calls[0][0].where.doctoraliaAddressServiceId).toBe('new-exam-address');
    });
    it('fails closed on missing catalog and propagates database failures for retry', async () => {
        const db = catalog();
        db.doctoraliaAddressService.findUnique.mockResolvedValue(null);
        expect(await isConsultationRecord(db, record)).toBe(false);
        db.doctoraliaAddressService.findUnique.mockRejectedValue(new Error('catalog unavailable'));
        await expect(isConsultationRecord(db, record)).rejects.toThrow('catalog unavailable');
    });
    it('direct Doctoralia read cannot reintroduce a persisted VissMed exam', async () => {
        const db: any = catalog();
        db.bookingSync = { findMany: jest.fn().mockResolvedValue([
            { doctoraliaBookingId: 'exam', rawPayload: { tipo_servico: 'Exame' } },
        ]) };
        const result = await filterDoctoraliaBookings(db, 'clinic', [
            { id: 'exam', address_service: { id: 'address-999' } },
            { id: 'consultation', address_service: { id: 'address-999' } },
        ]);
        expect(result.map((b: any) => b.id)).toEqual(['consultation']);
        expect(db.bookingSync.findMany.mock.calls[0][0].where.clinicId).toBe('clinic');
    });
    it('reuses local catalog reads within a batch without remote calls or global stale cache', async () => {
        const db = catalog();
        expect(await consultationRecords(db, Array(1000).fill(record))).toHaveLength(1000);
        expect(db.integrationConnection.findFirst).toHaveBeenCalledTimes(1);
        expect(db.doctoraliaAddressService.findUnique).toHaveBeenCalledTimes(1);
        db.doctoraliaAddressService.findUnique.mockResolvedValue({ service: { doctoraliaServiceId: '7580' } });
        expect(await consultationRecords(db, [record])).toEqual([]);
    });
    it('publishes only consultation services on slots; IDs are dictionary IDs', () => {
        const services = [{ id: 'a', service_id: '291' }, { id: 'b', service_id: '7580' },
            { id: 'c', service_id: '5284' }, { id: '291' }];
        expect(consultationSlotServices(services, 'www.doctoralia.com.br')).toEqual([services[0]]);
        expect(consultationSlotServices(services, 'znanylekarz.pl')).toEqual([]);
    });
});
