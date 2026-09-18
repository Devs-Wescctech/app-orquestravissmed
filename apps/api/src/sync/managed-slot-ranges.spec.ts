import { managedClearPayload, managedSlotState } from './managed-slot-ranges';

const scope = { clinicId: 'clinic-a', facilityId: 'f', doctorId: 'd', addressId: 'a' };
const slots = [{ start: '2026-09-12T08:00:00-03:00', end: '2026-09-12T12:00:00-03:00' }];
describe('managed availability cleanup', () => {
    it('retains full sent configuration as evidence for future safe replacement', () => {
        const full = [{ ...slots[0], address_services: [{ address_service_id: 5, duration: 30 }], insurance_providers: [7] }];
        expect((managedSlotState(scope, 'hash', full) as any).periods).toEqual(full);
    });
    it('uses documented empty address_services inside the exact prior range, never slots: []', () => {
        const state = managedSlotState(scope, 'hash', slots);
        expect(managedClearPayload(state, 'hash', scope, ['2026-09-12'])).toEqual({ slots: [{ ...slots[0], address_services: [] }] });
    });
    it.each([null, {}, { version: 1, hash: 'hash', ...scope, ranges: [{ start: 'invalid', end: 'invalid' }] }])(
        'requires valid evidence and valid intervals', state => expect(managedClearPayload(state, 'hash', scope, ['2026-09-12'])).toBeNull());
    it('rejects stale evidence left by old application version and foreign clinic', () => {
        const state = managedSlotState(scope, 'hash', slots);
        expect(managedClearPayload(state, 'new-hash', scope, ['2026-09-12'])).toBeNull();
        expect(managedClearPayload(state, 'hash', { ...scope, clinicId: 'other' }, ['2026-09-12'])).toBeNull();
    });
    it('does not widen to dates outside the complete source snapshot', () => {
        expect(managedClearPayload(managedSlotState(scope, 'hash', slots), 'hash', scope, ['2026-09-13'])).toBeNull();
    });
    it('rejects malformed ranges before saving management evidence', () => {
        expect(() => managedSlotState(scope, 'hash', [null])).toThrow('Invalid managed slot range');
    });
});
