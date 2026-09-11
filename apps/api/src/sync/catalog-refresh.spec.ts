import { refreshCatalogs, CATALOG_REFRESH_MS } from './catalog-refresh';

function fixture() {
    const events: any[] = [], services = new Map(), insurances = new Map();
    const model = (rows: Map<any, any>) => ({
        findUnique: jest.fn(async ({ where }) => rows.get(Object.values(where)[0]) || null),
        upsert: jest.fn(async ({ where, create, update }) => {
            const key = Object.values(where)[0];
            rows.set(key, rows.has(key) ? { ...rows.get(key), ...update } : create);
            return rows.get(key);
        }),
    });
    const prisma: any = { doctoraliaService: model(services), doctoraliaInsuranceProvider: model(insurances), syncEvent: {
        create: jest.fn(async ({ data }) => { const event = { ...data, timestamp: new Date() }; events.push(event); return event; }),
        findFirst: jest.fn(async ({ where }) => [...events].reverse().find(e => e.action === where.action
            && (!where.syncRunId || e.syncRunId === where.syncRunId)
            && (!where.externalId || e.externalId === where.externalId)
            && (!where.timestamp || e.timestamp >= where.timestamp.gte)) || null),
    } };
    const client: any = { getServicesDictionary: jest.fn(async () => ({ _items: [{ id: '1', name: 'Consultation' }, { id: '2', name: 'Examination' }] })),
        getInsuranceProviders: jest.fn(async () => ({ _items: [{ id: '3', name: 'Insurance' }] })) };
    const connection = { id: 'connection-a', clinicId: 'clinic-a', domain: 'doctoralia.com.br', clientId: 'public-client', catalogScopeVersion: 1 };
    return { prisma, client, connection, events, services };
}

describe('durable catalog refresh', () => {
    it('second cycle after a restart uses successful checkpoints, with no reads of catalog items or writes', async () => {
        const { prisma, client, connection } = fixture();
        await refreshCatalogs(prisma, client, connection, 'run1');
        prisma.doctoraliaService.findUnique.mockClear(); prisma.doctoraliaService.upsert.mockClear();
        await refreshCatalogs(prisma, client, connection, 'run2');
        expect(client.getServicesDictionary).toHaveBeenCalledTimes(1);
        expect(prisma.doctoraliaService.findUnique).not.toHaveBeenCalled();
        expect(prisma.doctoraliaService.upsert).not.toHaveBeenCalled();
    });

    it('expired checkpoint refreshes and writes only the changed item', async () => {
        const { prisma, client, connection, events, services } = fixture();
        await refreshCatalogs(prisma, client, connection, 'run1');
        for (const e of events) e.timestamp = new Date(Date.now() - CATALOG_REFRESH_MS - 1);
        services.set('1', { ...services.get('1'), name: 'Old' });
        prisma.doctoraliaService.upsert.mockClear();
        await refreshCatalogs(prisma, client, connection, 'run2');
        expect(prisma.doctoraliaService.upsert).toHaveBeenCalledTimes(1);
        expect(prisma.doctoraliaService.upsert.mock.calls[0][0].where).toEqual({ doctoraliaServiceId: '1' });
    });

    it('does not mark a failed write fresh and retries it next cycle', async () => {
        const { prisma, client, connection, events } = fixture();
        prisma.doctoraliaService.upsert.mockRejectedValueOnce(new Error('DB temporarily unavailable'));
        await refreshCatalogs(prisma, client, connection, 'run1');
        expect(events.some(e => e.action === 'catalog_services_refreshed')).toBe(false);
        await refreshCatalogs(prisma, client, connection, 'run2');
        expect(client.getServicesDictionary).toHaveBeenCalledTimes(2);
        expect(events.some(e => e.action === 'catalog_services_refreshed')).toBe(true);
    });

    it.each([{ _items: [] }, { _items: [{ id: '1', name: 'A' }], pages: 2 }, { _items: [{ name: 'Missing ID' }] }])(
        'rejects incomplete/invalid catalogs before writing', async response => {
            const { prisma, client, connection, events } = fixture();
            client.getServicesDictionary.mockResolvedValue(response);
            await refreshCatalogs(prisma, client, connection, 'run');
            expect(prisma.doctoraliaService.upsert).not.toHaveBeenCalled();
            expect(events.some(e => e.action === 'catalog_services_refreshed')).toBe(false);
        });

    it.each([{ clinicId: 'b' }, { id: 'b' }, { domain: 'other' }, { clientId: 'other' }, { catalogScopeVersion: 2 }])(
        'does not reuse freshness across scope changes %j', async change => {
            const { prisma, client, connection } = fixture();
            await refreshCatalogs(prisma, client, connection, 'run1');
            await refreshCatalogs(prisma, client, { ...connection, ...change }, 'run2');
            expect(client.getServicesDictionary).toHaveBeenCalledTimes(2);
        });

    it('explicit manual refresh bypasses checkpoint', async () => {
        const { prisma, client, connection, events } = fixture();
        await refreshCatalogs(prisma, client, connection, 'run1');
        for (const event of events) event.timestamp = new Date(Date.now() - 1000);
        events.push({ syncRunId: 'manual', action: 'catalog_refresh_requested', timestamp: new Date() });
        await refreshCatalogs(prisma, client, connection, 'manual');
        expect(client.getServicesDictionary).toHaveBeenCalledTimes(2);
    });

    it('honors a deferred manual request once when another run resumes it', async () => {
        const { prisma, client, connection, events } = fixture();
        await refreshCatalogs(prisma, client, connection, 'first');
        for (const event of events) event.timestamp = new Date(Date.now() - 2000);
        events.push({ syncRunId: 'deferred', action: 'catalog_refresh_requested', timestamp: new Date(Date.now() - 1000) });
        await refreshCatalogs(prisma, client, connection, 'resumed');
        await refreshCatalogs(prisma, client, connection, 'next');
        expect(client.getServicesDictionary).toHaveBeenCalledTimes(2);
        expect(client.getInsuranceProviders).toHaveBeenCalledTimes(2);
    });
});
