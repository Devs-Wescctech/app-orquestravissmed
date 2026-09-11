import { PushSyncService } from './push-sync.service';
import { Logger } from '@nestjs/common';

function fixture(planItems: any[], existingPlans: any[] = []) {
    const events: any[] = [];
    let current = [{ insurance_provider_id: '7', insurance_plans: { _items: existingPlans } }];
    const prisma: any = { mapping: { findMany: jest.fn(async () => [{ externalId: '7' }]) },
        syncEvent: { create: jest.fn(async ({ data }) => { events.push(data); return data; }) } };
    const client: any = { getCacheIdentity: () => 'fixture', getAddressInsuranceProviders: jest.fn(async () => ({ _items: current })),
        getInsurancePlans: jest.fn(async () => ({ _items: planItems })),
        putAddressInsuranceProvider: jest.fn(async (_f, _d, _a, _p, plans) => { current = [{ insurance_provider_id: '7', insurance_plans: { _items: plans } }]; }),
        addAddressInsuranceProvider: jest.fn(), deleteAddressInsuranceProvider: jest.fn() };
    const service = new PushSyncService(prisma, {} as any, {} as any, { getOrFetch: async (_k, _t, fetch) => fetch() } as any);
    const run = () => (service as any).syncInsuranceProviders('run', client, 'clinic', 'f', 'd', 'a', 'Fixture');
    return { events, client, run };
}
describe('insurance reconciliation', () => {
    beforeAll(() => Logger.overrideLogger(false));
    it('preserves manually selected plans without another write or lookup', async () => {
        const f = fixture([{ insurance_plan_id: '1' }], [{ insurance_plan_id: '9' }]);
        await f.run();
        expect(f.client.putAddressInsuranceProvider).not.toHaveBeenCalled();
        expect(f.client.getInsurancePlans).not.toHaveBeenCalled();
        expect(f.client.getAddressInsuranceProviders).toHaveBeenCalledTimes(1);
    });
    it('links and verifies a sole valid plan with documented PUT', async () => {
        const f = fixture([{ insurance_plan_id: '1' }]);
        await f.run();
        expect(f.client.putAddressInsuranceProvider).toHaveBeenCalledWith('f', 'd', 'a', '7', [{ insurance_plan_id: '1' }]);
        expect(f.events.some(e => e.action === 'regression_warning')).toBe(false);
    });
    it.each([{ plans: [] }, { plans: [{ insurance_plan_id: '1' }, { insurance_plan_id: '2' }] }])('makes unresolved configuration actionable without choosing arbitrarily', async ({ plans }) => {
        const f = fixture(plans);
        await f.run();
        expect(f.client.putAddressInsuranceProvider).not.toHaveBeenCalled();
        expect(f.events.some(e => e.action === 'plan_pending')).toBe(true);
        expect(f.events.some(e => e.action === 'regression_warning')).toBe(true);
    });
    it('reports a failed plan lookup', async () => {
        const f = fixture([]); f.client.getInsurancePlans.mockRejectedValue(new Error('offline'));
        await f.run();
        expect(f.events.some(e => e.action === 'error')).toBe(true);
    });
});
