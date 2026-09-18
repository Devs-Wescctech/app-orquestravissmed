import { DisabledProfessionalSlots } from './disabled-professional-slots';
import { managedSlotState } from './managed-slot-ranges';

describe('withdraw only future owned availability, never appointments', () => {
    const scope = { clinicId: 'clinic', facilityId: 'f', doctorId: 'd', addressId: 'a' };
    const now = new Date('2026-09-18T15:00:00Z');
    const ranges = [
        { start: '2026-09-17T08:00:00-03:00', end: '2026-09-17T18:00:00-03:00' },
        { start: '2026-09-18T08:00:00-03:00', end: '2026-09-18T18:00:00-03:00' },
        { start: '2026-10-30T08:00:00-03:00', end: '2026-10-30T18:00:00-03:00' },
    ];
    function setup() {
        const state: any = { addressId: 'a', availabilityHash: 'hash', managedState: managedSlotState(scope, 'hash', ranges) };
        const prisma: any = {
            slotPushState: { findMany: jest.fn().mockResolvedValue([state]), upsert: jest.fn() },
            mapping: { findFirst: jest.fn().mockResolvedValue({ status: 'LINKED' }), findMany: jest.fn().mockResolvedValue([]) },
        };
        const client = { replaceSlots: jest.fn().mockResolvedValue({}), cancelBooking: jest.fn(), deleteCalendarBreak: jest.fn(), deleteSlots: jest.fn() };
        const excluded = jest.fn().mockResolvedValue(true);
        const service = new DisabledProfessionalSlots(prisma);
        return { state, prisma, client, excluded, run: () => service.clear('clinic', 'local', 'f', 'd', client, excluded, now) };
    }
    it('trims today, preserves the past and covers previously published dates beyond the default window', async () => {
        const s = setup(); expect(await s.run()).toEqual({ cleared: 1, pending: 0 });
        expect(s.client.replaceSlots).toHaveBeenCalledWith('f', 'd', 'a', { slots: [
            { ...ranges[1], start: '2026-09-18T12:00:00-03:00', address_services: [] },
            { ...ranges[2], address_services: [] },
        ] });
        for (const fn of [s.client.cancelBooking, s.client.deleteCalendarBreak, s.client.deleteSlots]) expect(fn).not.toHaveBeenCalled();
    });
    it.each(['legacy', 'wrongClinic', 'wrongFacility', 'wrongHash', 'invalidRange'])('preserves ambiguous evidence: %s', async problem => {
        const s = setup();
        if (problem === 'legacy') s.state.managedState = null;
        if (problem === 'wrongClinic') s.state.managedState.clinicId = 'another';
        if (problem === 'wrongFacility') s.state.managedState.facilityId = 'another';
        if (problem === 'wrongHash') s.state.availabilityHash = 'another';
        if (problem === 'invalidRange') s.state.managedState.ranges = [{ start: 'invalid', end: 'invalid' }];
        expect(await s.run()).toEqual({ cleared: 0, pending: 1 });
        expect(s.client.replaceSlots).not.toHaveBeenCalled();
    });
    it.each(['unlinked', 'shared', 'reenabled'])('preserves availability when %s before removal', async reason => {
        const s = setup();
        if (reason === 'unlinked') s.prisma.mapping.findFirst.mockResolvedValue(null);
        if (reason === 'shared') s.prisma.mapping.findMany.mockResolvedValue([{ id: 'another' }]);
        if (reason === 'reenabled') s.excluded.mockResolvedValue(false);
        expect(await s.run()).toEqual({ cleared: 0, pending: 1 });
        expect(s.client.replaceSlots).not.toHaveBeenCalled();
    });
    it('retains evidence after an uncertain remote write and can retry next cycle', async () => {
        const s = setup(); s.client.replaceSlots.mockRejectedValueOnce(new Error('timeout'));
        expect(await s.run()).toEqual({ cleared: 0, pending: 1 });
        expect(s.prisma.slotPushState.upsert).not.toHaveBeenCalled();
        expect(await s.run()).toEqual({ cleared: 1, pending: 0 });
    });
    it('reports persistence failure rather than pretending cleanup is fully reconciled', async () => {
        const s = setup(); s.prisma.slotPushState.upsert.mockRejectedValue(new Error('database unavailable'));
        expect(await s.run()).toEqual({ cleared: 0, pending: 1 });
    });
    it('does not mutate an already empty managed calendar or past-only ranges', async () => {
        const s = setup(); s.state.managedState.ranges = [];
        expect(await s.run()).toEqual({ cleared: 0, pending: 0 });
        s.state.managedState.ranges = [ranges[0]];
        expect(await s.run()).toEqual({ cleared: 0, pending: 0 });
        expect(s.client.replaceSlots).not.toHaveBeenCalled();
    });
});
