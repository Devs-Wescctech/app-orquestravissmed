import { ConfigService } from '@nestjs/config';
import { DocplannerClient } from '../integrations/docplanner.service';
import {
    DoctoraliaCatalogService,
    DOCTORALIA_CATALOG_EXPIRED_RETENTION_MS,
    DOCTORALIA_CATALOG_TTL_MS,
} from './doctoralia-catalog.service';

describe('Task 261 Doctoralia tenant catalog', () => {
    beforeEach(() => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'c1';
    });

    afterEach(() => {
        delete process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS;
    });

    it('performs zero credential/client/network work when the allowlist is empty', async () => {
        delete process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS;
        const prisma: any = { integrationConnection: { findMany: jest.fn() } };
        const docplanner: any = { createClient: jest.fn() };
        await expect(new DoctoraliaCatalogService(prisma, docplanner).refreshClinicCatalog('c1'))
            .resolves.toEqual({ skipped: 'clinic_not_allowlisted' });
        expect(prisma.integrationConnection.findMany).not.toHaveBeenCalled();
        expect(docplanner.createClient).not.toHaveBeenCalled();
    });

    it('does not create a client when another replica owns the persisted lease', async () => {
        const prisma: any = {
            integrationConnection: { findMany: jest.fn().mockResolvedValue([{
                id: 'dc1', status: 'connected', clientId: 'client',
                clientSecret: 'secret', domain: 'example.test', catalogScopeVersion: 1,
            }]) },
            $queryRawUnsafe: jest.fn().mockResolvedValue([]),
        };
        const docplanner: any = { createClient: jest.fn() };
        await expect(new DoctoraliaCatalogService(prisma, docplanner).refreshClinicCatalog('c1', 4))
            .resolves.toEqual({ skipped: 'catalog_lease_held' });
        expect(docplanner.createClient).not.toHaveBeenCalled();
    });

    it('aborts before publication when distributed lease ownership is lost during enumeration', async () => {
        const prisma: any = {
            integrationConnection: { findMany: jest.fn().mockResolvedValue([{
                id: 'dc1', status: 'connected', clientId: 'client',
                clientSecret: 'secret', domain: 'example.test', catalogScopeVersion: 1,
            }]) },
            $queryRawUnsafe: jest.fn().mockResolvedValue([{ owner: expect.anything() }]),
            doctoraliaCatalogLease: {
                findUnique: jest.fn().mockResolvedValue({
                    owner: 'another-replica', expiresAt: new Date(Date.now() + 60_000),
                }),
                deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
            },
            $transaction: jest.fn(),
        };
        // Return the actual generated owner from the acquire parameters.
        prisma.$queryRawUnsafe.mockImplementation((sql: string, ...args: any[]) =>
            sql.includes('INSERT INTO "DoctoraliaCatalogLease"')
                ? [{ owner: args[2] }]
                : [],
        );
        const client: any = {
            setCatalogAttemptGuard: jest.fn(),
            enumerateFacilitiesAndDoctors: jest.fn(async (_budget: number, guard: () => Promise<void>) => {
                await guard();
                throw new Error('unreachable');
            }),
        };
        const docplanner: any = { createClient: jest.fn().mockReturnValue(client) };
        await expect(new DoctoraliaCatalogService(prisma, docplanner).refreshClinicCatalog('c1', 4))
            .rejects.toThrow('lease lost');
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });
    it.each(['paused', 'disconnected', 'error'])(
        'does not authenticate or enumerate a %s connection',
        async (status) => {
            const prisma: any = {
                integrationConnection: {
                    findMany: jest.fn().mockResolvedValue([{
                        id: 'dc1', status, clientId: 'client', clientSecret: 'secret',
                        domain: 'www.doctoralia.com.br', catalogScopeVersion: 1,
                    }]),
                },
            };
            const docplanner: any = { createClient: jest.fn() };
            const result = await new DoctoraliaCatalogService(prisma, docplanner).refreshClinicCatalog('c1');
            expect(result).toEqual({ skipped: 'connection_not_connected' });
            expect(docplanner.createClient).not.toHaveBeenCalled();
        },
    );

    it('does not authenticate an unconfigured connection', async () => {
        const prisma: any = {
            integrationConnection: {
                findMany: jest.fn().mockResolvedValue([{
                    id: 'dc1', status: 'connected', clientId: null, catalogScopeVersion: 1,
                }]),
            },
        };
        const docplanner: any = { createClient: jest.fn() };
        await expect(new DoctoraliaCatalogService(prisma, docplanner).refreshClinicCatalog('c1'))
            .resolves.toEqual({ skipped: 'connection_not_configured' });
        expect(docplanner.createClient).not.toHaveBeenCalled();
    });

    it('enumerates all facility/doctor pages through GETs and a shared budget', async () => {
        const client = new DocplannerClient({} as ConfigService);
        client.setBaseUrl('https://www.doctoralia.com.br');
        const request = jest.spyOn(client as any, 'request')
            .mockResolvedValueOnce({
                _items: [{ id: 'f1' }],
                _links: { next: { href: '/api/v3/integration/facilities?page=2' } },
            })
            .mockResolvedValueOnce({ _items: [{ id: 'f2' }], _links: {} })
            .mockResolvedValueOnce({
                _items: [{ id: 'd1' }],
                _links: { next: '/api/v3/integration/facilities/f1/doctors?page=2' },
            })
            .mockResolvedValueOnce({ _items: [{ id: 'd2' }], _links: {} })
            .mockResolvedValueOnce({ _items: [{ id: 'd3' }], _links: {} });

        const result = await client.enumerateFacilitiesAndDoctors(5);
        expect(result.facilities.map(f => f.id)).toEqual(['f1', 'f2']);
        expect(result.doctorsByFacility.get('f1')!.map(d => d.id)).toEqual(['d1', 'd2']);
        expect(result.doctorsByFacility.get('f2')!.map(d => d.id)).toEqual(['d3']);
        expect(result.getRequests).toBe(5);
        expect(request.mock.calls.every(call => call[0] === 'GET')).toBe(true);
    });

    it('fails before publish on incomplete enumeration', async () => {
        const prisma: any = { $transaction: jest.fn() };
        const client: any = { enumerateFacilitiesAndDoctors: jest.fn().mockRejectedValue(new Error('page 2 failed')) };
        const service = new DoctoraliaCatalogService(prisma);
        await expect(service.refresh('c1', { id: 'dc1', catalogScopeVersion: 2 }, client))
            .rejects.toThrow('page 2 failed');
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('publishes members atomically with a fixed 30 minute expiry', async () => {
        const createdGenerations: any[] = [];
        const tx: any = {
            integrationConnection: {
                findMany: jest.fn().mockResolvedValue([{ id: 'dc1', catalogScopeVersion: 2, status: 'connected' }]),
                findUnique: jest.fn().mockResolvedValue({
                    clinicId: 'c1', provider: 'doctoralia', status: 'connected', catalogScopeVersion: 2,
                }),
            },
            doctoraliaDoctor: {
                upsert: jest.fn().mockResolvedValue({
                    id: 'doctor-row',
                    doctoraliaDoctorId: 'd1',
                }),
            },
            doctoraliaCatalogGeneration: {
                create: jest.fn(({ data }) => {
                    createdGenerations.push(data);
                    return { id: 'g1' };
                }),
                deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
            },
        };
        const prisma: any = { $transaction: jest.fn((fn: any) => fn(tx)) };
        const client: any = {
            enumerateFacilitiesAndDoctors: jest.fn().mockResolvedValue({
                facilities: [{ id: 'f1' }],
                doctorsByFacility: new Map([['f1', [{
                    id: 'd1', name: 'Maria', doctor: { license_numbers: ['CRM/SP 123'] },
                }]]]),
                getRequests: 2,
            }),
        };
        const before = Date.now();
        const result = await new DoctoraliaCatalogService(prisma)
            .refresh('c1', { id: 'dc1', catalogScopeVersion: 2 }, client);
        expect(result).toMatchObject({ generationId: 'g1', facilityCount: 1, doctorCount: 1 });
        const data = createdGenerations[0];
        expect(data.catalogScopeVersion).toBe(2);
        expect(data.members.create[0]).toMatchObject({
            facilityId: 'f1',
            doctoraliaExternalId: 'd1',
        });
        expect(data.members.create[0].credentials.create).toEqual([
            { council: 'CRM', number: '123', uf: 'SP', regional: null },
        ]);
        expect(data.members.create[0]).not.toHaveProperty('licenseNumbers');
        const doctorUpsert = tx.doctoraliaDoctor.upsert.mock.calls[0][0];
        expect(doctorUpsert.create).not.toHaveProperty('licenseNumbers');
        expect(doctorUpsert.update).not.toHaveProperty('licenseNumbers');
        expect(data.expiresAt.getTime() - data.publishedAt.getTime()).toBe(DOCTORALIA_CATALOG_TTL_MS);
        expect(data.publishedAt.getTime()).toBeGreaterThanOrEqual(before);
        const prune = tx.doctoraliaCatalogGeneration.deleteMany.mock.calls[0][0];
        expect(prune.where.expiresAt.lt.getTime()).toBe(
            data.publishedAt.getTime() - DOCTORALIA_CATALOG_EXPIRED_RETENTION_MS,
        );
        // The strict `< cutoff` predicate retains current, non-expired, and
        // recently-expired generations; only older expired history is removed.
        expect(prune.where.expiresAt).toEqual({ lt: expect.any(Date) });
    });

    it('does not prune or replace a generation when publication fails', async () => {
        const tx: any = {
            integrationConnection: {
                findMany: jest.fn().mockResolvedValue([{ id: 'changed', catalogScopeVersion: 3 }]),
            },
            doctoraliaCatalogGeneration: {
                create: jest.fn(),
                deleteMany: jest.fn(),
            },
        };
        const prisma: any = { $transaction: jest.fn((fn: any) => fn(tx)) };
        const client: any = {
            enumerateFacilitiesAndDoctors: jest.fn().mockResolvedValue({
                facilities: [], doctorsByFacility: new Map(), getRequests: 1,
            }),
        };
        await expect(new DoctoraliaCatalogService(prisma)
            .refresh('c1', { id: 'dc1', catalogScopeVersion: 2 }, client))
            .rejects.toThrow('scope changed');
        expect(tx.doctoraliaCatalogGeneration.create).not.toHaveBeenCalled();
        expect(tx.doctoraliaCatalogGeneration.deleteMany).not.toHaveBeenCalled();
    });

    it.each(['paused', 'disconnected', 'error'])(
        'rejects a read-to-publish %s status race immediately before create',
        async (status) => {
            const tx: any = {
                integrationConnection: {
                    findMany: jest.fn().mockResolvedValue([{ id: 'dc1', catalogScopeVersion: 2, status: 'connected' }]),
                    findUnique: jest.fn().mockResolvedValue({
                        clinicId: 'c1', provider: 'doctoralia', status, catalogScopeVersion: 2,
                    }),
                },
                doctoraliaDoctor: { upsert: jest.fn().mockResolvedValue({ id: 'doctor-row', doctoraliaDoctorId: 'd1' }) },
                doctoraliaCatalogGeneration: { create: jest.fn(), deleteMany: jest.fn() },
            };
            const prisma: any = { $transaction: jest.fn((fn: any) => fn(tx)) };
            const client: any = {
                enumerateFacilitiesAndDoctors: jest.fn().mockResolvedValue({
                    facilities: [{ id: 'f1' }],
                    doctorsByFacility: new Map([['f1', [{ id: 'd1', name: 'Maria', doctor: { license_numbers: ['CRM/SP 123'] } }]]]),
                    getRequests: 1,
                }),
            };
            await expect(new DoctoraliaCatalogService(prisma)
                .refresh('c1', { id: 'dc1', catalogScopeVersion: 2 }, client))
                .rejects.toThrow('not connected');
            expect(tx.doctoraliaCatalogGeneration.create).not.toHaveBeenCalled();
        },
    );
});