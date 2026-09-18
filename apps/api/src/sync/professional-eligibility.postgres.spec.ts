import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { DisabledProfessionalSlots } from './disabled-professional-slots';
import { managedSlotState } from './managed-slot-ranges';
import { periodsHash } from './managed-period-replacement';
import { ProfessionalEligibility } from '../integrations/vismed/professional-eligibility';

const enabled = process.env.ELIGIBILITY_PG_TESTS === '1';
if (enabled) {
    const url = new URL(process.env.DATABASE_URL || '');
    if (url.hostname !== '127.0.0.1' || url.port !== '55439' || url.pathname !== '/sync_test') throw new Error('Disposable local sync_test required');
}
(enabled ? describe : describe.skip)('eligibility and cleanup with real PostgreSQL', () => {
    const prisma = new PrismaClient();
    const id = randomUUID();
    const scope = { clinicId: `eligibility-${id}`, facilityId: `f-${id}`, doctorId: `d-${id}`, addressId: `a-${id}` };
    const foreignClinic = `${scope.clinicId}-foreign`;
    const localId = `local-${id}`;
    const ranges = [{ start: '2030-01-02T08:00:00-03:00', end: '2030-01-02T09:00:00-03:00' }];
    const client = { replaceSlots: jest.fn() };
    const run = () => new DisabledProfessionalSlots(prisma as any).assess(scope.clinicId, scope.facilityId, scope.doctorId, new Date('2026-09-18T15:00:00Z'));
    beforeAll(async () => {
        await prisma.clinic.createMany({ data: [{ id: scope.clinicId, name: 'Synthetic eligibility' }, { id: foreignClinic, name: 'Synthetic foreign clinic' }] });
        await prisma.mapping.create({ data: { clinicId: scope.clinicId, entityType: 'DOCTOR', vismedId: localId, externalId: scope.doctorId, status: 'LINKED' } });
        await prisma.integrationConnection.create({ data: { clinicId: scope.clinicId, provider: 'vismed', domain: 'https://app.vissmed.com.br/api-docctor-3', clientId: '52', status: 'connected' } });
    });
    beforeEach(async () => {
        client.replaceSlots.mockReset().mockResolvedValue({});
        await prisma.mapping.deleteMany({ where: { clinicId: foreignClinic } });
        await prisma.slotPushState.deleteMany({ where: { doctoraliaDoctorId: scope.doctorId } });
        await prisma.slotPushState.create({ data: { doctoraliaDoctorId: scope.doctorId, addressId: scope.addressId, availabilityHash: 'evidence', managedState: managedSlotState(scope, 'evidence', ranges) as any } });
    });
    afterAll(async () => {
        await prisma.slotPushState.deleteMany({ where: { doctoraliaDoctorId: scope.doctorId } });
        await prisma.clinic.deleteMany({ where: { id: { in: [scope.clinicId, foreignClinic] } } });
        await prisma.$disconnect();
    });
    it('reads the real clinic connection and recognizes fresh eligibility changes', async () => {
        const roster = jest.fn().mockResolvedValue([{ id: 6983 }]);
        const gate = new ProfessionalEligibility(prisma as any, { getProfissionaisForEligibility: roster } as any);
        expect((await gate.check(scope.clinicId, 6983)).state).toBe('enabled');
        roster.mockResolvedValue([]);
        expect((await gate.check(scope.clinicId, 6983)).state).toBe('excluded');
        expect((await gate.check(foreignClinic, 6983)).state).toBe('unknown');
    });
    it('preserves evidence and pending across service instances without PUT', async () => {
        expect(await run()).toEqual({ cleared: 0, pending: 1 });
        expect(await run()).toEqual({ cleared: 0, pending: 1 });
        expect(client.replaceSlots).not.toHaveBeenCalled();
        const state = await prisma.slotPushState.findFirstOrThrow({ where: { doctoraliaDoctorId: scope.doctorId } });
        expect((state.managedState as any).ranges).toEqual(ranges);
    });
    it('does not access a failing provider or advance durable evidence', async () => {
        client.replaceSlots.mockRejectedValueOnce(new Error('synthetic timeout'));
        expect(await run()).toEqual({ cleared: 0, pending: 1 });
        expect((await prisma.slotPushState.findFirstOrThrow({ where: { doctoraliaDoctorId: scope.doctorId } })).availabilityHash).toBe('evidence');
        expect(await run()).toEqual({ cleared: 0, pending: 1 });
        expect(client.replaceSlots).not.toHaveBeenCalled();
    });
    it('detects a shared mapping in another clinic and never removes its slots', async () => {
        await prisma.mapping.create({ data: { clinicId: foreignClinic, entityType: 'DOCTOR', externalId: scope.doctorId, vismedId: `foreign-${id}`, status: 'LINKED' } });
        expect(await run()).toEqual({ cleared: 0, pending: 1 });
        expect(client.replaceSlots).not.toHaveBeenCalled();
    });
    it('persists a verified full-journal removal and preserves another address', async () => {
        const periods = [{ ...ranges[0], address_services: [{ address_service_id: '5', duration: 60 }] }];
        const hash = periodsHash(periods);
        await prisma.slotPushState.updateMany({ where: { doctoraliaDoctorId: scope.doctorId }, data: {
            availabilityHash: hash, managedState: managedSlotState(scope, hash, periods) as any,
        } });
        const other = await prisma.slotPushState.create({ data: {
            doctoraliaDoctorId: scope.doctorId, addressId: `${scope.addressId}-other`, availabilityHash: 'untouched',
        } });
        let remote = periods;
        const provider = {
            getSlotsForReconciliation: jest.fn(async () => ({ _items: remote.map(p => ({ start: p.start, address_services: { _items: [{ id: '5' }] } })) })),
            getBookings: jest.fn(async () => ({ _items: [] })),
            getCalendarBreaks: jest.fn(async () => ({ _items: [] })),
            replaceSlots: jest.fn(async (_f, _d, _a, body) => { remote = body.slots.filter(p => p.address_services.length); }),
        };
        const service = new DisabledProfessionalSlots(prisma as any);
        expect(await service.reconcile(scope.clinicId, localId, scope.facilityId, scope.doctorId, provider,
            async () => true, ['2030-01-02'], new Date('2029-01-01'), scope.addressId)).toEqual({ cleared: 1, pending: 0 });
        const stored = await prisma.slotPushState.findFirstOrThrow({ where: { doctoraliaDoctorId: scope.doctorId, addressId: scope.addressId } });
        expect(stored.availabilityHash).toBe(periodsHash([]));
        expect((stored.managedState as any).periods).toEqual([]);
        expect((await prisma.slotPushState.findUniqueOrThrow({ where: { id: other.id } })).availabilityHash).toBe('untouched');
        expect(await service.reconcile(scope.clinicId, localId, scope.facilityId, scope.doctorId, provider,
            async () => true, ['2030-01-02'], new Date('2029-01-01'), scope.addressId)).toEqual({ cleared: 0, pending: 0 });
        expect(provider.replaceSlots).toHaveBeenCalledTimes(1);
    });
});
