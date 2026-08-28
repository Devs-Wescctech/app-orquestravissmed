import { MatchingEngineService } from './matching-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseLicenseString, extractDoctoraliaLicenseStrings, buildDoctoraliaDoctorUpsertData } from './license.util';

/**
 * Task 141 — Camada 0: match de médicos por CRM (Doctoralia ↔ VisMed).
 */
describe('license.util — parseLicenseString', () => {
    it('parseia "CRM/SP 21.212.112" (conselho, UF e dígitos normalizados)', () => {
        expect(parseLicenseString('CRM/SP 21.212.112')).toEqual({ council: 'CRM', uf: 'SP', digits: '21212112' });
    });

    it('parseia número puro "21212112" sem conselho/UF', () => {
        expect(parseLicenseString('21212112')).toEqual({ council: null, uf: null, digits: '21212112' });
    });

    it('usa o councilHint (documentType VisMed) quando a string é só número', () => {
        expect(parseLicenseString('12345', 'CRM')).toEqual({ council: 'CRM', uf: null, digits: '12345' });
    });

    it('ignora zeros à esquerda e pontuação', () => {
        expect(parseLicenseString('CRM-RJ 0052.123')!.digits).toBe('52123');
        expect(parseLicenseString('52123')!.digits).toBe('52123');
    });

    it('parseia token colado "CRMSP 12345"', () => {
        expect(parseLicenseString('CRMSP 12345')).toEqual({ council: 'CRM', uf: 'SP', digits: '12345' });
    });

    it('reconhece outros conselhos (CRP, CRO)', () => {
        expect(parseLicenseString('CRP 06/12345')!.council).toBe('CRP');
        expect(parseLicenseString('CRO/SP 999')!.council).toBe('CRO');
    });

    it('retorna null sem dígitos utilizáveis', () => {
        expect(parseLicenseString('CRM/SP')).toBeNull();
        expect(parseLicenseString('')).toBeNull();
        expect(parseLicenseString(null)).toBeNull();
        expect(parseLicenseString('000')).toBeNull();
    });
});

describe('license.util — extractDoctoraliaLicenseStrings', () => {
    it('tolera lista ausente/vazia', () => {
        expect(extractDoctoraliaLicenseStrings({})).toEqual([]);
        expect(extractDoctoraliaLicenseStrings({ license_numbers: [] })).toEqual([]);
        expect(extractDoctoraliaLicenseStrings(null)).toEqual([]);
    });

    it('aceita strings e objetos', () => {
        expect(extractDoctoraliaLicenseStrings({ license_numbers: ['CRM/SP 123'] })).toEqual(['CRM/SP 123']);
        expect(extractDoctoraliaLicenseStrings({ license_numbers: [{ type: 'CRM', number: '123' }] })).toEqual(['CRM 123']);
    });

    it('lê a relação ANINHADA doctor.license_numbers (shape do include with[]=doctor.license_numbers)', () => {
        const item = {
            id: 88123,
            name: 'Maria',
            surname: 'Souza',
            doctor: { id: 555, license_numbers: ['CRM/SP 21.212.112'] },
        };
        expect(extractDoctoraliaLicenseStrings(item)).toEqual(['CRM/SP 21.212.112']);
    });

    it('lê lista aninhada envelopada em _items com objetos (type/region/number separados)', () => {
        const item = {
            id: 88123,
            doctor: {
                license_numbers: {
                    _items: [
                        { id: 1, type: 'CRM', region: 'SP', number: '21212112' },
                        { id: 2, type: 'RQE', number: 4321 },
                    ],
                },
            },
        };
        const out = extractDoctoraliaLicenseStrings(item);
        expect(out).toEqual(['CRM SP 21212112', 'RQE 4321']);
        // O parser preserva conselho/UF/número vindos em campos separados
        expect(parseLicenseString(out[0])).toEqual({ council: 'CRM', uf: 'SP', digits: '21212112' });
    });
});

describe('sync — buildDoctoraliaDoctorUpsertData (fixture da listagem de médicos)', () => {
    it('upsert recebe licenseNumbers populados a partir do payload aninhado real', () => {
        const apiItem = {
            id: 88123,
            name: 'Maria',
            surname: 'Aparecida Souza',
            doctor: { id: 555, license_numbers: [{ type: 'CRM', region: 'SP', number: '21.212.112' }] },
        };
        const { create, update } = buildDoctoraliaDoctorUpsertData(apiItem, 'fac-1');
        expect(create).toMatchObject({
            doctoraliaDoctorId: '88123',
            doctoraliaFacilityId: 'fac-1',
            name: 'Maria Aparecida Souza',
            licenseNumbers: ['CRM SP 21.212.112'],
        });
        expect(update.doctoraliaFacilityId).toBe('fac-1');
        expect(update.licenseNumbers).toEqual(['CRM SP 21.212.112']);
        // E a camada 0 consegue consumir o que foi persistido
        expect(parseLicenseString(update.licenseNumbers[0])).toEqual({ council: 'CRM', uf: 'SP', digits: '21212112' });
    });

    it('tolera médico sem a relação (lista vazia persistida, sem quebra)', () => {
        const { create, update } = buildDoctoraliaDoctorUpsertData({ id: 9, name: 'Dr. X' }, 'fac-1');
        expect(create.licenseNumbers).toEqual([]);
        expect(update.licenseNumbers).toEqual([]);
        expect(create.name).toBe('Dr. X');
    });
});

describe('MatchingEngineService — Camada 0 (CRM)', () => {
    const VISMED_DOC = {
        id: 'v1',
        name: 'Maria Aparecida Souza',
        documentNumber: 'CRM/SP 21.212.112',
        documentType: 'CRM',
    };

    function buildPrisma(opts: {
        vismedDoc?: any;
        dDoctors: Array<{ id: string; doctoraliaDoctorId?: string; name: string; licenseNumbers?: string[] }>;
        otherVismedDocs?: Array<{ id: string; name: string; documentNumber?: string | null; documentType?: string | null }>;
    }) {
        const created: any[] = [];
        const reviews: any[] = [];
        const dDoctors = opts.dDoctors.map((d, i) => ({ doctoraliaDoctorId: `ext-${i}`, licenseNumbers: [], ...d }));
        const prisma: any = {
            vismedDoctor: {
                findUnique: jest.fn().mockResolvedValue(opts.vismedDoc ?? VISMED_DOC),
                findMany: jest.fn().mockResolvedValue(opts.otherVismedDocs ?? []),
            },
            professionalUnifiedMapping: {
                findFirst: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockImplementation(({ data }: any) => { created.push(data); return Promise.resolve(data); }),
                update: jest.fn(),
            },
            doctoraliaDoctor: {
                findMany: jest.fn().mockResolvedValue(dDoctors),
                findUnique: jest.fn().mockResolvedValue(null),
            },
            mapping: {
                findMany: jest.fn().mockResolvedValue([]),
                findFirst: jest.fn().mockResolvedValue(null),
            },
            doctorMatchReview: {
                findFirst: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockImplementation(({ data }: any) => { reviews.push(data); return Promise.resolve({ id: 'r1', ...data }); }),
                update: jest.fn(),
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            },
        };
        return { prisma, created, reviews };
    }

    it('(a) mesmo CRM + mesma UF → auto-link mesmo com nomes bem diferentes', async () => {
        const { prisma, created } = buildPrisma({
            dDoctors: [
                { id: 'd1', name: 'Dra. M. A. de Souza Filha', licenseNumbers: ['CRM/SP 21.212.112'] },
                { id: 'd2', name: 'Dr. Outro', licenseNumbers: ['CRM/SP 999'] },
            ],
        });
        const svc = new MatchingEngineService(prisma as PrismaService);
        await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(true);
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ vismedDoctorId: 'v1', doctoraliaDoctorId: 'd1' });
    });

    it('(a2) formatos variados: "CRM/SP 21.212.112" (VisMed) casa com "CRMSP 21212112" (Doctoralia)', async () => {
        const { prisma, created } = buildPrisma({
            dDoctors: [{ id: 'd1', name: 'Nome Totalmente Diferente', licenseNumbers: ['CRMSP 21212112'] }],
        });
        const svc = new MatchingEngineService(prisma as PrismaService);
        await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(true);
        expect(created[0]).toMatchObject({ doctoraliaDoctorId: 'd1' });
    });

    it('(b) mesmo número + UFs diferentes → NÃO casa (cai no fluxo por nome, sem match)', async () => {
        const { prisma, created, reviews } = buildPrisma({
            dDoctors: [{ id: 'd1', name: 'Fulano de Tal', licenseNumbers: ['CRM/RS 21.212.112'] }],
        });
        const svc = new MatchingEngineService(prisma as PrismaService);
        await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(false);
        expect(created).toHaveLength(0);
        expect(reviews).toHaveLength(0);
    });

    it('(c) CRM sem UF nos dois lados, número único → auto-link (regra conservadora)', async () => {
        const { prisma, created } = buildPrisma({
            vismedDoc: { ...VISMED_DOC, documentNumber: '21212112' },
            dDoctors: [
                { id: 'd1', name: 'Nome Diferente', licenseNumbers: ['CRM 21212112'] },
                { id: 'd2', name: 'Outro', licenseNumbers: ['CRM 555'] },
            ],
        });
        const svc = new MatchingEngineService(prisma as PrismaService);
        await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(true);
        expect(created[0]).toMatchObject({ doctoraliaDoctorId: 'd1' });
    });

    it('(d) CRM sem UF com colisão no lado Doctoralia → revisão manual, nunca auto-link', async () => {
        const { prisma, created, reviews } = buildPrisma({
            vismedDoc: { ...VISMED_DOC, documentNumber: '21212112' },
            dDoctors: [
                { id: 'd1', name: 'Médico SP', licenseNumbers: ['CRM/SP 21212112'] },
                { id: 'd2', name: 'Médico RS', licenseNumbers: ['CRM/RS 21212112'] },
            ],
        });
        const svc = new MatchingEngineService(prisma as PrismaService);
        await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(false);
        expect(created).toHaveLength(0);
        expect(reviews).toHaveLength(1);
        expect(reviews[0].reason).toContain('CRM');
        expect((reviews[0].candidates as any[]).map(c => c.source)).toContain('CRM_CONFLICT');
    });

    it('(d2) colisão no lado VisMed (outro médico com o mesmo CRM) → revisão manual', async () => {
        const { prisma, created, reviews } = buildPrisma({
            dDoctors: [{ id: 'd1', name: 'Nome Diferente', licenseNumbers: ['CRM/SP 21212112'] }],
            otherVismedDocs: [{ id: 'v2', name: 'Homônimo VisMed', documentNumber: 'CRM/SP 21212112', documentType: 'CRM' }],
        });
        const svc = new MatchingEngineService(prisma as PrismaService);
        await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(false);
        expect(created).toHaveLength(0);
        expect(reviews).toHaveLength(1);
        expect(reviews[0].reason).toContain('VisMed');
    });

    it('(e) CRM × CRP com o mesmo número → NÃO casa (conselho faz parte da identidade)', async () => {
        const { prisma, created, reviews } = buildPrisma({
            vismedDoc: { ...VISMED_DOC, documentNumber: '21212112', documentType: 'CRP' },
            dDoctors: [{ id: 'd1', name: 'Outro Nome', licenseNumbers: ['CRM/SP 21212112'] }],
        });
        const svc = new MatchingEngineService(prisma as PrismaService);
        await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(false);
        expect(created).toHaveLength(0);
        expect(reviews).toHaveLength(0);
    });

    it('(f) sem CRM no VisMed → cai no fluxo por nome exatamente como hoje (match exato ainda funciona)', async () => {
        const { prisma, created } = buildPrisma({
            vismedDoc: { id: 'v1', name: 'Maria Aparecida Souza', documentNumber: null, documentType: null },
            dDoctors: [{ id: 'd1', name: 'Maria Aparecida Souza', licenseNumbers: ['CRM/SP 111'] }],
        });
        const svc = new MatchingEngineService(prisma as PrismaService);
        await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(true);
        expect(created[0]).toMatchObject({ doctoraliaDoctorId: 'd1' });
    });

    it('(g) médicos Doctoralia sem license numbers → camada 0 é neutra (fluxo por nome intacto)', async () => {
        const { prisma, created } = buildPrisma({
            dDoctors: [{ id: 'd1', name: 'Maria Aparecida Souza' }],
        });
        const svc = new MatchingEngineService(prisma as PrismaService);
        await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(true);
        expect(created[0]).toMatchObject({ doctoraliaDoctorId: 'd1' });
    });

    it('(h) UF só no lado VisMed, número único → regra conservadora permite auto-link', async () => {
        const { prisma, created } = buildPrisma({
            dDoctors: [{ id: 'd1', name: 'Nome Diferente', licenseNumbers: ['CRM 21212112'] }],
        });
        const svc = new MatchingEngineService(prisma as PrismaService);
        await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(true);
        expect(created[0]).toMatchObject({ doctoraliaDoctorId: 'd1' });
    });
});
