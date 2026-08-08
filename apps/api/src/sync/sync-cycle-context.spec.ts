import { SyncCycleContext } from './sync-cycle-context';

const F = 'fac1';
const D = 'doc1';
const A = 'addr1';
const A2 = 'addr2';

const ADDRS = [{ id: A, name: 'Clínica A' }];
const SVCS_BEFORE = [{ id: 'svc1', service_id: '10', service_name: 'Cardiologia' }];
const SVCS_AFTER = [
    { id: 'svc1', service_id: '10', service_name: 'Cardiologia' },
    { id: 'svc2', service_id: '20', service_name: 'Neurologia' },
];

describe('SyncCycleContext', () => {
    describe('addresses', () => {
        it('returns undefined on first access (miss)', () => {
            const ctx = new SyncCycleContext();
            expect(ctx.getAddresses(F, D)).toBeUndefined();
        });

        it('returns cached value on second access (hit)', () => {
            const ctx = new SyncCycleContext();
            ctx.setAddresses(F, D, ADDRS);
            expect(ctx.getAddresses(F, D)).toBe(ADDRS);
        });

        it('isolates different (facilityId, doctorId) pairs', () => {
            const ctx = new SyncCycleContext();
            ctx.setAddresses(F, D, ADDRS);
            expect(ctx.getAddresses(F, 'doc2')).toBeUndefined();
            expect(ctx.getAddresses('fac2', D)).toBeUndefined();
        });

        it('tracks hit and miss counters', () => {
            const ctx = new SyncCycleContext();
            ctx.getAddresses(F, D); // miss
            ctx.setAddresses(F, D, ADDRS);
            ctx.getAddresses(F, D); // hit
            ctx.getAddresses(F, D); // hit
            const { hits, misses } = ctx.getStats();
            expect(hits.addresses).toBe(2);
            expect(misses.addresses).toBe(1);
        });
    });

    describe('services', () => {
        it('returns undefined on first access (miss)', () => {
            const ctx = new SyncCycleContext();
            expect(ctx.getServices(F, D, A)).toBeUndefined();
        });

        it('returns cached value on second access (hit)', () => {
            const ctx = new SyncCycleContext();
            ctx.setServices(F, D, A, SVCS_BEFORE);
            expect(ctx.getServices(F, D, A)).toBe(SVCS_BEFORE);
        });

        it('isolates different addressIds', () => {
            const ctx = new SyncCycleContext();
            ctx.setServices(F, D, A, SVCS_BEFORE);
            expect(ctx.getServices(F, D, A2)).toBeUndefined();
        });

        it('isolates different (facilityId, doctorId) pairs', () => {
            const ctx = new SyncCycleContext();
            ctx.setServices(F, D, A, SVCS_BEFORE);
            expect(ctx.getServices(F, 'doc2', A)).toBeUndefined();
            expect(ctx.getServices('fac2', D, A)).toBeUndefined();
        });

        it('tracks hit and miss counters independently from addresses', () => {
            const ctx = new SyncCycleContext();
            ctx.getServices(F, D, A); // miss
            ctx.setServices(F, D, A, SVCS_BEFORE);
            ctx.getServices(F, D, A); // hit
            const { hits, misses } = ctx.getStats();
            expect(hits.services).toBe(1);
            expect(misses.services).toBe(1);
            expect(hits.addresses).toBe(0);
            expect(misses.addresses).toBe(0);
        });
    });

    describe('invalidateServices', () => {
        it('forces a miss after invalidation (simulates post-mutation behaviour)', () => {
            const ctx = new SyncCycleContext();
            ctx.setServices(F, D, A, SVCS_BEFORE);
            expect(ctx.getServices(F, D, A)).toBe(SVCS_BEFORE); // hit

            // PushSync mutated the list → invalidate
            ctx.invalidateServices(F, D, A);

            // SlotSync now gets a miss and must re-fetch from Doctoralia
            expect(ctx.getServices(F, D, A)).toBeUndefined();
        });

        it('does not affect other addresses on the same doctor', () => {
            const ctx = new SyncCycleContext();
            ctx.setServices(F, D, A, SVCS_BEFORE);
            ctx.setServices(F, D, A2, SVCS_AFTER);

            ctx.invalidateServices(F, D, A);

            expect(ctx.getServices(F, D, A)).toBeUndefined();  // invalidated
            expect(ctx.getServices(F, D, A2)).toBe(SVCS_AFTER); // untouched
        });

        it('allows re-population after invalidation', () => {
            const ctx = new SyncCycleContext();
            ctx.setServices(F, D, A, SVCS_BEFORE);
            ctx.invalidateServices(F, D, A);

            // SlotSync re-fetches and stores updated list
            ctx.setServices(F, D, A, SVCS_AFTER);
            expect(ctx.getServices(F, D, A)).toBe(SVCS_AFTER);
        });
    });

    describe('cycle isolation', () => {
        it('a new context instance starts empty (simulates a new cycle)', () => {
            const ctx1 = new SyncCycleContext();
            ctx1.setAddresses(F, D, ADDRS);
            ctx1.setServices(F, D, A, SVCS_BEFORE);

            // New cycle = new instance
            const ctx2 = new SyncCycleContext();
            expect(ctx2.getAddresses(F, D)).toBeUndefined();
            expect(ctx2.getServices(F, D, A)).toBeUndefined();
        });

        it('SlotSync called in isolation (no context) falls back to undefined → caller must fetch', () => {
            // When SlotSync is invoked without a cycleCtx, the optional-chain returns undefined.
            // This test documents that contract — the caller code checks `!== undefined`.
            const ctx: SyncCycleContext | undefined = undefined;
            expect(ctx?.getAddresses(F, D)).toBeUndefined();
            expect(ctx?.getServices(F, D, A)).toBeUndefined();
        });
    });

    describe('getStats', () => {
        it('returns independent copies of hit/miss counters', () => {
            const ctx = new SyncCycleContext();
            ctx.setAddresses(F, D, ADDRS);
            ctx.getAddresses(F, D); // hit
            const stats = ctx.getStats();
            stats.hits.addresses = 999; // mutate the returned object
            // must not affect internal state
            expect(ctx.getStats().hits.addresses).toBe(1);
        });
    });
});
