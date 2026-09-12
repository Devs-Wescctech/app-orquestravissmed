import { PushSyncService } from './push-sync.service';
import { Logger } from '@nestjs/common';
import { classifySyncEvents } from './sync-observation';

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
    it('records a valid empty catalog as information without writes or warnings', async () => {
        const f = fixture([]);
        const result = await f.run();
        expect(result.providersWithoutPlans).toBe(0);
        expect(result.providersMissingPlanIds).toEqual([]);
        expect(f.client.putAddressInsuranceProvider).not.toHaveBeenCalled();
        expect(f.client.addAddressInsuranceProvider).not.toHaveBeenCalled();
        expect(f.client.deleteAddressInsuranceProvider).not.toHaveBeenCalled();
        expect(f.events.some(e => e.action === 'catalog_without_plans')).toBe(true);
        expect(classifySyncEvents(f.events)).toMatchObject({ warnings: 0, errors: 0 });
    });
    it.each([{ plans: [{ insurance_plan_id: '1' }, { insurance_plan_id: '2' }] }, { plans: [{ id: 'invalid' }] }])('makes unresolved configuration actionable without choosing arbitrarily', async ({ plans }) => {
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
        expect(f.events.some(e => e.action === 'catalog_without_plans')).toBe(false);
        expect(f.events.some(e => e.action === 'regression_warning')).toBe(true);
    });
    it('does not exempt incomplete catalogs even when their first page is empty', async () => {
        const f = fixture([]);
        f.client.getInsurancePlans.mockResolvedValue({ _items: [], _links: { next: { href: '/next' } } });
        await f.run();
        expect(f.events.some(e => e.action === 'plan_pending')).toBe(true);
        expect(f.events.some(e => e.action === 'catalog_without_plans')).toBe(false);
    });
    it('reclassifies a provider when plans become available in a later cycle', async () => {
        const f = fixture([]);
        await f.run();
        f.events.length = 0;
        f.client.getInsurancePlans.mockResolvedValue({ _items: [{ insurance_plan_id: '1' }, { insurance_plan_id: '2' }] });
        await f.run();
        expect(f.events.some(e => e.action === 'plan_pending')).toBe(true);
        expect(f.events.some(e => e.action === 'regression_warning')).toBe(true);
    });
    it('still warns if a provider with an empty catalog is not confirmed after adding', async () => {
        const f = fixture([]);
        f.client.getAddressInsuranceProviders.mockResolvedValue({ _items: [] });
        await f.run();
        expect(f.events.some(e => e.action === 'provider_pending')).toBe(true);
        expect(classifySyncEvents(f.events).warnings).toBeGreaterThan(0);
    });
});
