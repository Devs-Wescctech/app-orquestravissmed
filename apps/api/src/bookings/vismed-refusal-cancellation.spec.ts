import { isDefinitiveSlotRefusal, VismedRefusalCancellation } from './vismed-refusal-cancellation';

const refusal = { status: 402, msg: 'Horário indisponível, tente outro horários' };
function setup() {
    let receipt: any = null;
    const record = { id: 'local', clinicId: 'clinic', vismedDoctorId: 'vm-doctor', origin: 'DOCTORALIA', doctoraliaBookingId: '123',
        doctoraliaFacilityId: 'f', doctoraliaDoctorId: 'd', doctoraliaAddressId: 'a',
        startAt: new Date('2026-10-01T13:00:00Z'), endAt: new Date('2026-10-01T13:30:00Z') };
    const prisma: any = {
        auditLog: { findUnique: jest.fn(async () => receipt), create: jest.fn(async ({ data }) => receipt = data),
            update: jest.fn(async ({ data }) => receipt = { ...receipt, ...data }) },
        bookingSync: { update: jest.fn(async ({ data }) => ({ ...record, ...data })) },
        $transaction: jest.fn(async fn => fn(prisma)),
    };
    const client = { getBooking: jest.fn(async () => ({ id: '123', status: 'booked', start_at: record.startAt.toISOString(), end_at: record.endAt.toISOString() })), cancelBooking: jest.fn(async () => ({})) };
    const controller = new AbortController();
    const deps = { observedRefusal: true, signal: controller.signal, confirmAbsent: jest.fn(async () => true), getClient: jest.fn(async () => client) };
    return { record, prisma, client, deps, controller, service: new VismedRefusalCancellation(prisma) };
}
describe('Definitive VISSMED refusal classification', () => {
    it('accepts only the observed logical refusal', () => expect(isDefinitiveSlotRefusal(refusal)).toBe(true));
    it.each([null, {}, [], { error: 'Horário indisponível' }, { status: 500, msg: refusal.msg }, { status: '402', msg: refusal.msg },
        { ...refusal, success: true }, { ...refusal, idpacienteagendamento: 123 }, { ...refusal, idPacienteAgendamento: 123 }, { ...refusal, data: { id: 123 } },
        { status: 402, msg: 'Não é horário indisponível' }])('does not cancel for uncertain or conflicting response %j', body => {
        expect(isDefinitiveSlotRefusal(body)).toBe(false);
    });
});
describe('Refusal cancellation lifecycle', () => {
    it('does not infer refusal from a pending marker without its durable receipt', async () => {
        const s = setup(); s.deps.observedRefusal = false;
        await expect(s.service.run(s.record, s.deps)).rejects.toThrow('comprovante da recusa');
        expect(s.client.cancelBooking).not.toHaveBeenCalled();
    });
    it('preserves a booking when its VISSMED mapping changes between attempts', async () => {
        const s = setup(); s.deps.confirmAbsent.mockResolvedValueOnce(false);
        await expect(s.service.run(s.record, s.deps)).rejects.toThrow('confirmar ausência');
        await expect(s.service.run({ ...s.record, vismedDoctorId: 'another-doctor' }, s.deps)).rejects.toThrow('comprovante diverge');
        expect(s.client.cancelBooking).not.toHaveBeenCalled();
    });
    it('confirms absence and scoped booking before cancelling, then finishes locally', async () => {
        const s = setup(); await s.service.run(s.record, s.deps);
        expect(s.client.cancelBooking).toHaveBeenCalledWith('f', 'd', 'a', '123', expect.any(String));
        expect(s.prisma.bookingSync.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED', cancelledBy: 'INTEGRATION' }) }));
        await s.service.run(s.record, s.deps);
        expect(s.client.cancelBooking).toHaveBeenCalledTimes(1);
    });
    it('does not cancel when VISSMED existence is unknown or found', async () => {
        const s = setup(); s.deps.confirmAbsent.mockResolvedValue(false);
        await expect(s.service.run(s.record, s.deps)).rejects.toThrow('confirmar ausência');
        expect(s.client.cancelBooking).not.toHaveBeenCalled();
    });
    it('preserves uncertain DELETE and never repeats it', async () => {
        const s = setup(); s.client.cancelBooking.mockRejectedValue(new Error('timeout'));
        await expect(s.service.run(s.record, s.deps)).rejects.toThrow('não confirmou');
        await expect(s.service.run(s.record, s.deps)).rejects.toThrow('não será repetido');
        expect(s.client.cancelBooking).toHaveBeenCalledTimes(1);
        s.client.getBooking.mockResolvedValue({ id: '123', status: 'cancelled', start_at: s.record.startAt.toISOString(), end_at: s.record.endAt.toISOString() });
        await s.service.run(s.record, s.deps);
        expect(s.client.cancelBooking).toHaveBeenCalledTimes(1);
    });
    it('requires exact remote identity and period', async () => {
        const s = setup(); s.client.getBooking.mockResolvedValue({ id: 'other', status: 'booked', start_at: s.record.startAt.toISOString(), end_at: s.record.endAt.toISOString() });
        await expect(s.service.run(s.record, s.deps)).rejects.toThrow('não foi identificada');
        expect(s.client.cancelBooking).not.toHaveBeenCalled();
    });
    it('does not interpret GET 404 as confirmed cancellation', async () => {
        const s = setup(); s.client.getBooking.mockRejectedValue(new Error('404'));
        await expect(s.service.run(s.record, s.deps)).rejects.toThrow('conferir a consulta');
        expect(s.client.cancelBooking).not.toHaveBeenCalled();
    });
    it('requires durable intent before remote write', async () => {
        const s = setup(); s.prisma.$transaction.mockRejectedValue(new Error('database offline'));
        await expect(s.service.run(s.record, s.deps)).rejects.toThrow('database offline');
        expect(s.client.cancelBooking).not.toHaveBeenCalled();
    });
    it('respects a lost claim', async () => {
        const s = setup(); s.deps.confirmAbsent.mockImplementation(async () => { s.controller.abort(); return true; });
        await expect(s.service.run(s.record, s.deps)).rejects.toThrow('posse');
        expect(s.client.cancelBooking).not.toHaveBeenCalled();
    });
    it('does not cancel an appointment already linked to VISSMED', async () => {
        const s = setup(); await expect(s.service.run({ ...s.record, vismedAppointmentId: '456' }, s.deps)).rejects.toThrow('já associado');
        expect(s.client.cancelBooking).not.toHaveBeenCalled();
    });
});
