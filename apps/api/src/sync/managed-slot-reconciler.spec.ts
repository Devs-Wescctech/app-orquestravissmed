import { reconcileManagedRemoval } from './managed-slot-reconciler';
import { periodsHash } from './managed-period-replacement';
const scope = { clinicId: 'c', facilityId: 'f', doctorId: 'd', addressId: 'a' };
const first = { start: '2030-01-02T08:10:00-03:00', end: '2030-01-02T08:40:00-03:00', address_services: [{ address_service_id: '5', duration: 30 }] };
const second = { ...first, start: '2030-01-02T09:10:00-03:00', end: '2030-01-02T09:40:00-03:00' };
const periods = [first, second], hash = periodsHash(periods);
const state = { ...scope, version: 1, hash, periodsHash: periodsHash(periods), periods, ranges: periods.map(({ start, end }) => ({ start, end })) };
const snapshot = ps => ({ _items: ps.map(p => ({ start: p.start, address_services: { _items: [{ id: '5' }] } })) });
function fixture() {
    let remote = periods;
    const client = {
        getSlotsForReconciliation: jest.fn(async () => snapshot(remote)),
        getBookings: jest.fn(async () => ({ _items: [] })), getCalendarBreaks: jest.fn(async () => ({ _items: [] })),
        replaceSlots: jest.fn(async (_f, _d, _a, body) => { remote = body.slots.filter(p => p.address_services.length); }),
    };
    const authorized = jest.fn(async () => true), persist = jest.fn(async () => undefined);
    const onPending = jest.fn();
    const run = () => reconcileManagedRemoval({ state, hash, scope, targets: [first], client, authorized, persist, now: new Date('2029-01-01'), verifyAttempts: 1, onPending } as any);
    return { client, authorized, persist, run, onPending, getRemote: () => remote };
}
describe('verified replacement', () => {
    it.each([
        ['booking', 'bookings_present', 'not_sent'],
        ['break', 'breaks_present', 'not_sent'],
        ['incomplete', 'bookings_incomplete', 'not_sent'],
        ['mismatch', 'remote_mismatch', 'not_sent'],
        ['read', 'remote_read_failed', 'not_sent'],
        ['write', 'write_unconfirmed', 'unknown'],
        ['verify', 'verification_mismatch', 'unknown'],
        ['persist', 'journal_update_failed', 'confirmed'],
    ])('reports a precise safe reason for %s', async (kind, code, writeState) => {
        const f = fixture();
        if (kind === 'booking') f.client.getBookings.mockResolvedValue({ _items: [{}] });
        if (kind === 'break') f.client.getCalendarBreaks.mockResolvedValue({ _items: [{}] });
        if (kind === 'incomplete') f.client.getBookings.mockResolvedValue({ _items: [], _links: { next: 'page2' } } as any);
        if (kind === 'mismatch') f.client.getSlotsForReconciliation.mockResolvedValue(snapshot([]));
        if (kind === 'read') f.client.getBookings.mockRejectedValue(new Error('secret raw error'));
        if (kind === 'write') f.client.replaceSlots.mockRejectedValue(new Error('secret raw error'));
        if (kind === 'verify') f.client.replaceSlots.mockImplementation(async () => undefined);
        if (kind === 'persist') f.persist.mockRejectedValue(new Error('secret raw error'));
        expect(await f.run()).toBe(false);
        expect(f.onPending).toHaveBeenCalledWith({ code, writeState });
        expect(JSON.stringify(f.onPending.mock.calls)).not.toContain('secret');
        if (writeState === 'not_sent') expect(f.client.replaceSlots).not.toHaveBeenCalled();
    });
    it('does not remove anything when a published second service is absent from remote read-back', async () => {
        const f = fixture();
        const full = [first, { ...second, address_services: [...second.address_services, { address_service_id: '6', duration: 30 }] }];
        const digest = periodsHash(full);
        expect(await reconcileManagedRemoval({ state: { ...state, hash: digest, periodsHash: digest, periods: full },
            hash: digest, scope, targets: [first], client: f.client, authorized: f.authorized, persist: f.persist,
            now: new Date('2029-01-01'), verifyAttempts: 1 })).toBe(false);
        expect(f.client.replaceSlots).not.toHaveBeenCalled();
        expect(f.persist).not.toHaveBeenCalled();
    });
    it('removes first, preserves control and saves evidence only after read-back', async () => {
        const f = fixture(); expect(await f.run()).toBe(true);
        expect(f.getRemote()).toEqual([second]); expect(f.persist).toHaveBeenCalledWith([second]);
    });
    it.each(['unknown', 'booking', 'break', 'changed', 'unauthorized', 'writeFailure', 'readBackMismatch'])('never claims success for %s', async reason => {
        const f = fixture();
        if (reason === 'unknown') f.client.getSlotsForReconciliation.mockResolvedValue(snapshot([...periods, { ...second, start: '2030-01-02T10:00:00-03:00' }]));
        if (reason === 'booking') f.client.getBookings.mockResolvedValue({ _items: [{}] });
        if (reason === 'break') f.client.getCalendarBreaks.mockResolvedValue({ _items: [{}] });
        if (reason === 'changed') f.client.getSlotsForReconciliation.mockResolvedValueOnce(snapshot(periods)).mockResolvedValue(snapshot([second]));
        if (reason === 'unauthorized') f.authorized.mockResolvedValue(false);
        if (reason === 'writeFailure') f.client.replaceSlots.mockRejectedValue(new Error('timeout'));
        if (reason === 'readBackMismatch') f.client.replaceSlots.mockImplementation(async () => undefined);
        expect(await f.run()).toBe(false); expect(f.persist).not.toHaveBeenCalled();
        if (!['writeFailure', 'readBackMismatch'].includes(reason)) expect(f.client.replaceSlots).not.toHaveBeenCalled();
    });
});
