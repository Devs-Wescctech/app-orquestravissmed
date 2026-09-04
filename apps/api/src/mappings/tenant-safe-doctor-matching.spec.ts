import { MatchingEngineService } from './matching-engine.service';
import { Logger } from '@nestjs/common';

describe('Task 261 tenant-safe doctor matching', () => {
    afterEach(() => delete process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS);

    function fixture(overrides: any = {}) {
        const created: any[] = [];
        const prisma: any = {
            vismedDoctor: {
                findUnique: jest.fn().mockResolvedValue({
                    id: 'v1', name: 'VissMed Name', documentType: 'CRM', documentNumber: 'CRM/SP 123',
                }),
            },
            integrationConnection: {
                findMany: jest.fn(({ where }: any) => Promise.resolve(
                    where.provider === 'vismed'
                        ? [{ id: 'vc1', status: 'connected' }]
                        : [{ id: 'dc1', status: 'connected', catalogScopeVersion: 4 }],
                )),
            },
            doctoraliaCatalogGeneration: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'g1',
                    doctorCount: 1,
                    members: [{
                        facilityId: 'f1',
                        doctoraliaExternalId: 'd1',
                        credentials: [{ council: 'CRM', number: '123', uf: 'SP', regional: null }],
                    }],
                }),
                count: jest.fn().mockResolvedValue(1),
            },
            mapping: {
                findMany: jest.fn().mockResolvedValue([]),
                create: jest.fn(({ data }) => { created.push(data); return data; }),
            },
            $transaction: jest.fn((fn: any) => fn(prisma)),
            ...overrides,
        };
        return { prisma, created, service: new MatchingEngineService(prisma) };
    }

    it('is disabled by an empty allowlist and keeps the tenant catalog path untouched', async () => {
        const { prisma, service } = fixture();
        prisma.professionalUnifiedMapping = { findFirst: jest.fn().mockResolvedValue({ id: 'manual' }) };
        await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(true);
        expect(prisma.integrationConnection.findMany).not.toHaveBeenCalled();
    });

    it('creates only a missing mapping from one fresh scoped candidate, without external calls or PUM writes', async () => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        const { prisma, created, service } = fixture();
        await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(true);
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({
            clinicId: 'clinic-1', entityType: 'DOCTOR', vismedId: 'v1',
            externalId: 'd1', status: 'LINKED',
        });
        expect(JSON.stringify(created[0].conflictData)).not.toContain('CRM/SP 123');
        expect(JSON.stringify(created[0].conflictData)).not.toContain('RQE');
        expect(prisma.professionalUnifiedMapping).toBeUndefined();
    });

    it.each([
        ['vismed', 'paused'],
        ['vismed', 'disconnected'],
        ['vismed', 'error'],
        ['doctoralia', 'paused'],
        ['doctoralia', 'disconnected'],
        ['doctoralia', 'error'],
    ])('fails closed when the initial %s connection is %s', async (provider, status) => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        const { prisma, created, service } = fixture();
        prisma.integrationConnection.findMany.mockImplementation(({ where }: any) => Promise.resolve(
            where.provider === provider
                ? [{ id: `${provider}-1`, status, catalogScopeVersion: 4 }]
                : [{ id: `${where.provider}-1`, status: 'connected', catalogScopeVersion: 4 }],
        ));
        await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(false);
        expect(created).toHaveLength(0);
        expect(prisma.doctoraliaCatalogGeneration.findFirst).not.toHaveBeenCalled();
    });

    it('derives one allowlisted clinic for a no-scope caller and never enters legacy/PUM matching', async () => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        const { prisma, created, service } = fixture();
        prisma.mapping.findMany
            .mockResolvedValueOnce([{ clinicId: 'clinic-1' }]) // scope evidence
            .mockResolvedValueOnce([]) // no authority yet
            .mockResolvedValueOnce([]); // atomic recheck
        prisma.professionalUnifiedMapping = { findFirst: jest.fn() };
        prisma.doctoraliaDoctor = { findMany: jest.fn() };
        await expect(service.runMatchingForDoctor('v1')).resolves.toBe(true);
        expect(created).toHaveLength(1);
        expect(prisma.professionalUnifiedMapping.findFirst).not.toHaveBeenCalled();
        expect(prisma.doctoraliaDoctor.findMany).not.toHaveBeenCalled();
    });

    it('fails closed for no-scope multi-clinic evidence when an allowlisted tenant is involved', async () => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        const { prisma, service } = fixture();
        prisma.mapping.findMany.mockResolvedValue([
            { clinicId: 'clinic-1' },
            { clinicId: 'clinic-2' },
        ]);
        prisma.professionalUnifiedMapping = { findFirst: jest.fn() };
        prisma.doctoraliaDoctor = { findMany: jest.fn() };
        await expect(service.runMatchingForDoctor('v1')).resolves.toBe(false);
        expect(prisma.professionalUnifiedMapping.findFirst).not.toHaveBeenCalled();
        expect(prisma.doctoraliaDoctor.findMany).not.toHaveBeenCalled();
    });

    it.each([
        ['expired/missing generation', null],
        ['empty generation', { id: 'g1', doctorCount: 0, members: [] }],
    ])('fails closed for %s', async (_label, generation) => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        const { prisma, created, service } = fixture();
        prisma.doctoraliaCatalogGeneration.findFirst.mockResolvedValue(generation);
        await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(false);
        expect(created).toHaveLength(0);
    });

    it('preserves UNLINKED and divergent LINKED manual state', async () => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        for (const mapping of [
            { id: 'm1', status: 'UNLINKED', externalId: null },
            { id: 'm2', status: 'LINKED', externalId: 'other' },
        ]) {
            const { prisma, created, service } = fixture();
            prisma.mapping.findMany.mockResolvedValue([mapping]);
            await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(false);
            expect(created).toHaveLength(0);
        }
    });

    it('preserves a coherent LINKED mapping as the manual authority', async () => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        const { prisma, created, service } = fixture();
        prisma.mapping.findMany.mockResolvedValue([{ id: 'm1', status: 'LINKED', externalId: 'd1' }]);
        await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(true);
        expect(created).toHaveLength(0);
    });

    it('deduplicates facilities but fails closed for two doctors with the same strong identity', async () => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        const { prisma, created, service } = fixture();
        prisma.doctoraliaCatalogGeneration.findFirst.mockResolvedValue({
            id: 'g1',
            doctorCount: 3,
            members: [
                {
                    facilityId: 'f1', doctoraliaExternalId: 'd1',
                    credentials: [{ council: 'CRM', number: '123', uf: 'SP', regional: null }],
                },
                {
                    facilityId: 'f2', doctoraliaExternalId: 'd1',
                    credentials: [{ council: 'CRM', number: '123', uf: 'SP', regional: null }],
                },
                {
                    facilityId: 'f2', doctoraliaExternalId: 'd2',
                    credentials: [{ council: 'CRM', number: '123', uf: 'SP', regional: null }],
                },
            ],
        });
        await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(false);
        expect(created).toHaveLength(0);
    });

    it('uses published member evidence even if the global doctor changes afterwards', async () => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        const { prisma, created, service } = fixture();
        prisma.doctoraliaCatalogGeneration.findFirst.mockResolvedValue({
            id: 'g1', doctorCount: 1,
            members: [{
                facilityId: 'f1', doctoraliaExternalId: 'd1',
                credentials: [{ council: 'CRM', number: '123', uf: 'SP', regional: null }],
            }],
        });
        await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(true);
        expect(created).toHaveLength(1);
    });

    it.each([
        ['CRM-RJ 52 prefix with auxiliary RQE', 'CRM', '52-0113173-7 RQE 678', 'CRM/RJ 1131737', true],
        ['CRN numeric regional equal', 'CRN', 'CRN-4/00123', 'CRN4/123', true],
        ['CRN numeric regional divergent', 'CRN', 'CRN-4/00123', 'CRN5/123', false],
    ])('%s', async (_label, type, vismedRaw, doctoraliaRaw, expected) => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        const { prisma, service } = fixture();
        prisma.vismedDoctor.findUnique.mockResolvedValue({
            id: 'v1', name: 'VissMed Name', documentType: type, documentNumber: vismedRaw,
        });
        prisma.doctoraliaCatalogGeneration.findFirst.mockResolvedValue({
            id: 'g1', doctorCount: 1,
            members: [{
                facilityId: 'f1', doctoraliaExternalId: 'd1',
                credentials: doctoraliaRaw.startsWith('CRN')
                    ? [{ council: 'CRN', number: '123', uf: null, regional: doctoraliaRaw.includes('CRN5') ? '5' : '4' }]
                    : [{ council: 'CRM', number: '1131737', uf: 'RJ', regional: null }],
            }],
        });
        await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(expected);
    });

    it.each([
        ['CRM without UF', 'CRM', 'CRM 123', { council: 'CRM', number: '123', uf: null, regional: null }],
        ['hinted number without UF', 'CRM', '123', { council: 'CRM', number: '123', uf: null, regional: null }],
        ['CRN without regional', 'CRN', 'CRN/123', { council: 'CRN', number: '123', uf: null, regional: null }],
        ['candidate missing UF', 'CRM', 'CRM/SP 123', { council: 'CRM', number: '123', uf: null, regional: null }],
        ['federal CFM defaults closed', 'CFM', 'CFM 123', { council: 'CFM', number: '123', uf: null, regional: null }],
    ])('fails closed for incomplete scope: %s', async (_label, type, vismedRaw, credential) => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        const { prisma, created, service } = fixture();
        prisma.vismedDoctor.findUnique.mockResolvedValue({
            id: 'v1', name: 'Doctor', documentType: type, documentNumber: vismedRaw,
        });
        prisma.doctoraliaCatalogGeneration.findFirst.mockResolvedValue({
            id: 'g1', doctorCount: 1,
            members: [{ facilityId: 'f1', doctoraliaExternalId: 'd1', credentials: [credential] }],
        });
        await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(false);
        expect(created).toHaveLength(0);
    });

    it('fails closed on a concurrent mapping creation', async () => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        const { prisma, service } = fixture();
        prisma.mapping.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: 'won-by-other-request' }]);
        await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(false);
        expect(prisma.mapping.create).not.toHaveBeenCalled();
    });

    it('fails closed if PostgreSQL unique enforcement rejects the atomic insert', async () => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        const { prisma, service } = fixture();
        prisma.mapping.findMany.mockResolvedValue([]);
        prisma.mapping.create.mockRejectedValue({ code: 'P2002', message: 'unique conflict' });
        await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(false);
        expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('fails closed when a second Doctoralia connection appears inside the transaction', async () => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        const { prisma, created, service } = fixture();
        let doctoraliaReads = 0;
        prisma.integrationConnection.findMany.mockImplementation(({ where }: any) => {
            if (where.provider === 'vismed') return Promise.resolve([{ id: 'vc1', status: 'connected' }]);
            doctoraliaReads++;
            return Promise.resolve(doctoraliaReads === 1
                ? [{ id: 'dc1', status: 'connected', catalogScopeVersion: 4 }]
                : [{ id: 'dc1', status: 'connected', catalogScopeVersion: 4 }, { id: 'dc2', status: 'connected', catalogScopeVersion: 1 }]);
        });
        await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(false);
        expect(created).toHaveLength(0);
    });

    it.each(['paused', 'disconnected', 'error'])(
        'fails closed when a %s Doctoralia connection wins the read-to-create race',
        async (status) => {
            process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
            const { prisma, created, service } = fixture();
            let doctoraliaReads = 0;
            prisma.integrationConnection.findMany.mockImplementation(({ where }: any) => {
                if (where.provider === 'vismed') return Promise.resolve([{ id: 'vc1', status: 'connected' }]);
                doctoraliaReads++;
                return Promise.resolve([{
                    id: 'dc1',
                    status: doctoraliaReads === 1 ? 'connected' : status,
                    catalogScopeVersion: 4,
                }]);
            });
            await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(false);
            expect(created).toHaveLength(0);
            expect(prisma.mapping.create).not.toHaveBeenCalled();
        },
    );

    it.each(['paused', 'disconnected', 'error'])(
        'fails closed when a Vismed connection becomes %s inside the mapping transaction',
        async (status) => {
            process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
            const { prisma, created, service } = fixture();
            let vismedReads = 0;
            prisma.integrationConnection.findMany.mockImplementation(({ where }: any) => {
                if (where.provider === 'vismed') {
                    vismedReads++;
                    return Promise.resolve([{ id: 'vc1', status: vismedReads === 1 ? 'connected' : status }]);
                }
                return Promise.resolve([{ id: 'dc1', status: 'connected', catalogScopeVersion: 4 }]);
            });
            await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(false);
            expect(created).toHaveLength(0);
            expect(prisma.mapping.create).not.toHaveBeenCalled();
        },
    );

    it('never logs raw CRM/RQE evidence on the tenant-safe path', async () => {
        process.env.DOCTORALIA_TENANT_SAFE_DOCTOR_MATCH_CLINIC_IDS = 'clinic-1';
        const raw = 'CRM/SP 123 RQE 456';
        const spies = ['log', 'warn', 'debug', 'error'].map(method =>
            jest.spyOn(Logger.prototype, method as 'log').mockImplementation(),
        );
        const { prisma, service } = fixture();
        prisma.vismedDoctor.findUnique.mockResolvedValue({
            id: 'v1', name: 'VissMed Name', documentType: 'CRM', documentNumber: raw,
        });
        await expect(service.runMatchingForDoctor('v1', 'clinic-1')).resolves.toBe(true);
        const output = spies.flatMap(spy => spy.mock.calls).flat().join(' ');
        expect(output).not.toContain(raw);
        expect(output).not.toContain('RQE 456');
        spies.forEach(spy => spy.mockRestore());
    });
});