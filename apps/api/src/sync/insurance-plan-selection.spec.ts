import { selectInsurancePlan } from './insurance-plan-selection';
describe('insurance plan selection', () => {
    it('selects a sole valid plan', () => expect(selectInsurancePlan({ _items: [{ insurance_plan_id: '42' }] })).toEqual({ id: '42', reason: 'single_plan' }));
    it('requires configuration for multiple choices regardless of response order', () => {
        const items = [{ insurance_plan_id: '42' }, { insurance_plan_id: '43' }];
        expect(selectInsurancePlan({ _items: items }).reason).toBe('selection_required');
        expect(selectInsurancePlan({ _items: items.reverse() }).id).toBeNull();
    });
    it('distinguishes no available plan from invalid response', () => {
        expect(selectInsurancePlan({ _items: [] }).reason).toBe('no_available_plan');
        expect(selectInsurancePlan({ _items: [{ id: 'unrecognized' }] }).reason).toBe('invalid_catalog');
    });
    it.each([undefined, { _items: [{ insurance_plan_id: 'undefined' }] }, { _items: [{ insurance_plan_id: '1' }], pages: 2 }])(
        'does not generate an invalid ID or choose from an incomplete catalog', response => expect(selectInsurancePlan(response).id).toBeNull());
});
