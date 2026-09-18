import { DisabledProfessionalSlots } from './disabled-professional-slots';
import { managedSlotState } from './managed-slot-ranges';
import { periodsHash } from './managed-period-replacement';

describe('suspend unsafe replacement cleanup without losing evidence', () => {
    it('automatically reconciles a complete persisted day after fresh authorization', async () => {
        const periods = [{ ...owned, address_services: [{ address_service_id: '5', duration: 30 }] }];
        const hash = periodsHash(periods);
        let saved: any = { id: 'state', addressId: 'a', availabilityHash: hash, managedState: managedSlotState(scope, hash, periods) };
        let remote = periods;
        const prisma: any = {
            slotPushState: { findMany: async () => [saved], findUnique: async () => saved, updateMany: jest.fn(async ({ data }) => { saved = { ...saved, ...data }; return { count: 1 }; }) },
            mapping: { findFirst: async () => ({ status: 'LINKED' }), findMany: async () => [] },
        };
        const client: any = { getBookings: async () => ({ _items: [] }), getCalendarBreaks: async () => ({ _items: [] }),
            getSlotsForReconciliation: async () => ({ _items: remote.map(p => ({ start: p.start, address_services: { _items: [{ id: '5' }] } })) }),
            replaceSlots: jest.fn(async (_f, _d, _a, body) => { remote = body.slots.filter(p => p.address_services.length); }) };
        const result = await new DisabledProfessionalSlots(prisma).reconcile('clinic', 'local', 'f', 'd', client, async () => true, undefined, now);
        expect(result).toEqual({ cleared: 1, pending: 0 });
        expect(saved.managedState.periods).toEqual([]);
        expect(client.replaceSlots).toHaveBeenCalledTimes(1);
    });
    const scope = { clinicId: 'clinic', facilityId: 'f', doctorId: 'd', addressId: 'a' };
    const now = new Date('2026-09-18T15:00:00Z');
    const owned = { start: '2030-01-02T08:10:00-03:00', end: '2030-01-02T08:40:00-03:00' };
    function fixture() {
        const state: any = { addressId: 'a', availabilityHash: 'proof', managedState: managedSlotState(scope, 'proof', [owned]) };
        const prisma: any = { slotPushState: { findMany: jest.fn().mockResolvedValue([state]), upsert: jest.fn() } };
        const run = (time = now) => new DisabledProfessionalSlots(prisma).assess('clinic', 'f', 'd', time);
        return { state, prisma, run };
    }
    it('preserves unrelated availability under the replacement semantics observed in Doctoralia sandbox', async () => {
        const f = fixture();
        const unrelated = { start: '2030-01-02T09:10:00-03:00', end: '2030-01-02T09:40:00-03:00' };
        const remote = [owned, unrelated];
        // The assessment deliberately receives no remote client and cannot issue a destructive PUT.
        expect(await f.run()).toEqual({ cleared: 0, pending: 1 });
        expect(remote).toContainEqual(unrelated);
        expect(f.state.managedState.ranges).toEqual([owned]);
        expect(f.prisma.slotPushState.upsert).not.toHaveBeenCalled();
    });
    it.each(['legacy', 'clinic', 'facility', 'doctor', 'address', 'hash', 'version', 'ranges'])('retains uncertain evidence: %s', async kind => {
        const f = fixture();
        if (kind === 'legacy') f.state.managedState = null;
        else if (kind === 'ranges') f.state.managedState.ranges = {};
        else f.state.managedState[{ clinic: 'clinicId', facility: 'facilityId', doctor: 'doctorId', address: 'addressId' }[kind] || kind] = 'invalid';
        expect(await f.run()).toEqual({ cleared: 0, pending: 1 });
        expect(f.prisma.slotPushState.upsert).not.toHaveBeenCalled();
    });
    it.each([null, { start: 1, end: 'x' }, { start: 'invalid', end: 'invalid' }, { start: owned.end, end: owned.start }])('retains malformed range %j', async range => {
        const f = fixture(); f.state.managedState.ranges = [range];
        expect(await f.run()).toEqual({ cleared: 0, pending: 1 });
    });
    it('does not report past-only or already empty evidence as pending', async () => {
        const f = fixture(); f.state.managedState.ranges = [];
        expect(await f.run()).toEqual({ cleared: 0, pending: 0 });
        f.state.managedState.ranges = [{ start: '2026-09-17T08:00:00-03:00', end: '2026-09-17T09:00:00-03:00' }];
        expect(await f.run()).toEqual({ cleared: 0, pending: 0 });
        expect(f.prisma.slotPushState.upsert).not.toHaveBeenCalled();
    });
    it('retains pending across retries and rejects an invalid clock', async () => {
        const f = fixture();
        expect(await f.run()).toEqual({ cleared: 0, pending: 1 });
        expect(await f.run()).toEqual({ cleared: 0, pending: 1 });
        expect(await f.run(new Date('invalid'))).toEqual({ cleared: 0, pending: 1 });
    });
});
