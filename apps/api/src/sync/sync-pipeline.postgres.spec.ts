import { PrismaClient } from '@prisma/client';
import { SyncProcessor } from './sync.processor';
import { SyncService } from './sync.service';
import { Logger } from '@nestjs/common';

// Opt-in, restricted to the disposable database documented in the runbook.
const enabled = process.env.SYNC_TEST_DATABASE === 'true';
(enabled ? describe : describe.skip)('Doctoralia pipeline with PostgreSQL and simulated APIs', () => {
    let prisma: PrismaClient;
    let clinicId: string;
    const serviceId = '2000000101', insuranceId = 2000000102, doctorId = 'sync-fixture-doctor';
    const client: any = {
        getCacheIdentity: () => 'sync-fixture',
        getFacilities: jest.fn(async () => ({ _items: [{ id: 'sync-fixture-facility', name: 'Fixture' }] })),
        getDoctors: jest.fn(async () => ({ _items: [{ id: doctorId, name: 'Test', surname: 'Fixture' }] })),
        getAddresses: jest.fn(async () => ({ _items: [] })),
        getServicesDictionary: jest.fn(async () => ({ _items: [{ id: serviceId, name: 'Fixture service' }] })),
        getInsuranceProviders: jest.fn(async () => ({ _items: [{ id: insuranceId, name: 'Fixture insurance' }] })),
    };
    const cache: any = { getOrFetch: async (_key, _ttl, fetch) => fetch() };
    const matching: any = { runMatchingForUnmatched: jest.fn() };
    const push: any = { pushToDoctoralia: jest.fn() };
    const docplanner: any = { createClient: () => client };

    beforeAll(async () => {
        const url = new URL(process.env.DATABASE_URL || 'http://invalid');
        if (url.hostname !== '127.0.0.1' || url.port !== '55439' || url.pathname !== '/sync_test') {
            throw new Error('Only the disposable local sync_test database is permitted.');
        }
        Logger.overrideLogger(false);
        prisma = new PrismaClient();
        const clinic = await prisma.clinic.create({ data: { name: 'Synthetic sync test' } });
        clinicId = clinic.id;
        await prisma.integrationConnection.create({ data: { clinicId, provider: 'doctoralia', clientId: 'fixture-public-client', domain: 'doctoralia.com.br' } });
    });
    afterAll(async () => {
        if (!prisma) return;
        if (clinicId) await prisma.clinic.delete({ where: { id: clinicId } });
        await prisma.doctoraliaDoctor.deleteMany({ where: { doctoraliaDoctorId: doctorId } });
        await prisma.doctoraliaService.deleteMany({ where: { doctoraliaServiceId: serviceId } });
        await prisma.doctoraliaInsuranceProvider.deleteMany({ where: { doctoraliaId: insuranceId } });
        await prisma.$disconnect();
    });

    async function runPipeline(path: 'queue' | 'direct') {
        const run = await prisma.syncRun.create({ data: { clinicId, type: 'full', status: 'running' } });
        if (path === 'queue') {
            const worker = new SyncProcessor(prisma as any, docplanner, matching, push, {} as any, cache, {} as any);
            await (worker as any)._processInner({ id: 'fixture' }, run.id, clinicId);
        } else {
            const service = new SyncService({} as any, {} as any, prisma as any, {} as any, docplanner, matching, push, {} as any, cache);
            await (service as any)._runDoctoraliaSyncDirectBody(run.id, clinicId);
        }
        return prisma.syncRun.findUniqueOrThrow({ where: { id: run.id } });
    }

    it('queue refreshes catalogs once, next direct cycle retains persistent freshness and counts one doctor', async () => {
        const first = await runPipeline('queue');
        expect(first.status).toBe('completed');
        expect(first.totalRecords).toBe(4); // facility + doctor + 2 global dictionary records
        const firstReport = (first.metrics as any).report;
        expect(firstReport.categories.doctors.verified).toBe(1);
        const dictionaryBefore = await prisma.doctoraliaService.findUniqueOrThrow({ where: { doctoraliaServiceId: serviceId } });
        const next = await runPipeline('direct');
        expect(next.status).toBe('completed');
        expect(next.totalRecords).toBe(2);
        expect((next.metrics as any).report.categories.doctors.unchanged).toBe(1);
        expect(client.getServicesDictionary).toHaveBeenCalledTimes(1);
        const dictionaryAfter = await prisma.doctoraliaService.findUniqueOrThrow({ where: { doctoraliaServiceId: serviceId } });
        expect(dictionaryAfter.updatedAt).toEqual(dictionaryBefore.updatedAt);
    });

    it('persists partial success when a nested stage reports an error', async () => {
        push.pushToDoctoralia.mockImplementationOnce(async (_clinic, runId) => {
            await prisma.syncEvent.create({ data: { syncRunId: runId, entityType: 'SLOT_SYNC', action: 'error', message: 'Synthetic rejection' } });
        });
        const run = await runPipeline('queue');
        expect(run.status).toBe('completed_with_warnings');
        expect((run.metrics as any).report.errors).toBe(1);
    });

    it('migration accepts legacy records with no intervals and retains existing hashes', async () => {
        const row = await prisma.slotPushState.create({ data: { doctoraliaDoctorId: doctorId, addressId: 'fixture-address', availabilityHash: 'legacy-hash' } });
        expect(row.managedState).toBeNull();
        expect(row.availabilityHash).toBe('legacy-hash');
        await prisma.slotPushState.delete({ where: { id: row.id } });
    });
});
