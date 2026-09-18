import { createHash } from 'crypto';
import { planManagedRemoval, snapshotMatches, periodsHash } from './managed-period-replacement';

const scope = { clinicId: 'c', facilityId: 'f', doctorId: 'd', addressId: 'a' };
const service = [{ address_service_id: '5', duration: 30 }];
const first = { start: '2030-01-02T08:10:00-03:00', end: '2030-01-02T08:40:00-03:00', address_services: service };
const second = { start: '2030-01-02T09:10:00-03:00', end: '2030-01-02T09:40:00-03:00', address_services: service, insurance_accepted: 'with-insurance-only', insurance_providers: [7], insurance_plans: [72] };
const periods = [first, second];
const hash = createHash('sha256').update(JSON.stringify(periods)).digest('hex');
const state = { ...scope, version: 1, hash, periodsHash: periodsHash(periods), periods, ranges: periods.map(({ start, end }) => ({ start, end })) };
const now = new Date('2029-01-01T00:00:00Z');
describe('complete known-day replacement', () => {
    it('removes only 08:10 by resending the entire retained 09:10 configuration', () => {
        const plan = planManagedRemoval(state, hash, scope, [first], now)!;
        expect(plan.slots).toEqual([{ ...first, address_services: [] }, second]);
        expect(plan.remaining).toEqual([second]);
        expect(plan.dates).toEqual(['2030-01-02']);
    });
    it.each(['periods', 'hash', 'clinicId', 'ranges'])('rejects incomplete/stale/foreign evidence: %s', key => {
        expect(planManagedRemoval({ ...state, [key]: null }, hash, scope, [first], now)).toBeNull();
    });
    it('rejects unknown targets, past targets, overlapping periods and malformed periods', () => {
        expect(planManagedRemoval(state, hash, scope, [{ ...first, start: second.start }], now)).toBeNull();
        expect(planManagedRemoval(state, hash, scope, [first], new Date('2030-01-03'))).toBeNull();
        expect(planManagedRemoval({ ...state, periods: [first, first] }, hash, scope, [first], now)).toBeNull();
    });
    it('accepts exact expanded slots and rejects additional, missing, paginated or different-service slots', () => {
        const rows = periods.map(p => ({ start: p.start, address_services: { _items: [{ id: '5' }] } }));
        expect(snapshotMatches({ _items: rows }, periods)).toBe(true);
        for (const body of [{ _items: rows.slice(1) }, { _items: [...rows, rows[0]] }, { _items: rows, _links: { next: { href: 'next' } } }, { _items: [{ start: first.start, address_services: { _items: [{ id: '9' }] } }, rows[1]] }, null]) {
            expect(snapshotMatches(body, periods)).toBe(false);
        }
    });
});
