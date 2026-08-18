/**
 * Task 206 — Catálogo de categorias VisMed escopado por empresa gestora.
 *
 * Reproduz o cenário real das duas clínicas:
 *  - Empresa A (52, Petrópolis):  Fonoaudiologia = 3484
 *  - Empresa B (4, São Leopoldo): Fonoaudiologia = 192
 *
 * Verifica:
 *  1. Coexistência: homônimas das duas empresas coexistem sem migração/sobrescrita.
 *  2. Idempotência: ciclos alternados de sync (52 → 4 → 52 → 4) não geram
 *     migrações cruzadas nem alterações após a estabilização.
 *  3. Obsoletos detectados SOMENTE dentro do próprio escopo — categoria da outra
 *     empresa (fora do retorno da API) nunca é migrada/apagada.
 *  4. Claim de registro legado sem escopo (idEmpresaGestora NULL) pelo vismedId.
 *  5. Vínculos SYNC de outra empresa nunca são removidos pelo stale-link cleanup.
 */
import { VismedSyncProcessor } from './vismed-sync.processor';

function buildPrismaFake(seedSpecialties: any[] = [], seedLinks: any[] = []) {
    let uid = 0;
    const id = () => `id-${++uid}`;

    const specialties: any[] = [...seedSpecialties];
    const doctors: any[] = [];
    const links: any[] = [...seedLinks];
    const events: any[] = [];

    const empMatch = (s: any, v: any) =>
        v === undefined || (v === null ? s.idEmpresaGestora == null : s.idEmpresaGestora === v);

    const prisma: any = {
        _specialties: specialties,
        _links: links,
        _events: events,
        syncRun: { create: jest.fn(async () => ({ id: 'run-x' })), update: jest.fn(async () => ({})) },
        syncEvent: { create: jest.fn(async ({ data }: any) => { events.push(data); return data; }) },
        mapping: { upsert: jest.fn(async () => ({})) },
        vismedUnit: { upsert: jest.fn(async () => ({ id: id() })), findUnique: jest.fn(async () => null) },
        vismedInsurance: { upsert: jest.fn(async () => ({ id: id() })) },
        vismedDoctor: {
            upsert: jest.fn(async ({ where, create }: any) => {
                let d = doctors.find(x => x.vismedId === where.vismedId);
                if (!d) { d = { id: `doc-${where.vismedId}`, ...create }; doctors.push(d); }
                return d;
            }),
        },
        vismedSpecialty: {
            findFirst: jest.fn(async ({ where }: any) =>
                specialties.find(s =>
                    (where.vismedId === undefined || s.vismedId === where.vismedId)
                    && empMatch(s, where.idEmpresaGestora)) || null),
            update: jest.fn(async ({ where, data }: any) => {
                const s = specialties.find(x => x.id === where.id);
                Object.assign(s, data);
                return s;
            }),
            findMany: jest.fn(async ({ where, orderBy }: any) => {
                let res = specialties;
                if (where?.normalizedName !== undefined) res = res.filter(s => s.normalizedName === where.normalizedName);
                if (where?.vismedId?.notIn) res = res.filter(s => !where.vismedId.notIn.includes(s.vismedId));
                if (where?.idEmpresaGestora !== undefined) res = res.filter(s => empMatch(s, where.idEmpresaGestora));
                if (orderBy?.vismedId === 'asc') res = [...res].sort((a, b) => a.vismedId - b.vismedId);
                return res.map(s => ({
                    ...s,
                    doctors: links.filter(l => l.vismedSpecialtyId === s.id),
                    mappings: [],
                }));
            }),
            create: jest.fn(async ({ data }: any) => {
                const s = { id: id(), ...data };
                specialties.push(s);
                return s;
            }),
            findUnique: jest.fn(async ({ where }: any) => specialties.find(s => s.id === where.id) || null),
            delete: jest.fn(async ({ where }: any) => {
                const i = specialties.findIndex(s => s.id === where.id);
                if (i >= 0) specialties.splice(i, 1);
                return {};
            }),
        },
        vismedProfessionalSpecialty: {
            upsert: jest.fn(async ({ where, create }: any) => {
                const k = where.vismedDoctorId_vismedSpecialtyId;
                let l = links.find(x => x.vismedDoctorId === k.vismedDoctorId && x.vismedSpecialtyId === k.vismedSpecialtyId);
                if (!l) { l = { id: id(), ...create }; links.push(l); }
                return l;
            }),
            findUnique: jest.fn(async ({ where }: any) => {
                const k = where.vismedDoctorId_vismedSpecialtyId;
                return links.find(x => x.vismedDoctorId === k.vismedDoctorId && x.vismedSpecialtyId === k.vismedSpecialtyId) || null;
            }),
            findMany: jest.fn(async ({ where }: any) =>
                links
                    .filter(l => l.vismedDoctorId === where.vismedDoctorId
                        && l.source === where.source
                        && !where.vismedSpecialtyId.notIn.includes(l.vismedSpecialtyId))
                    .filter(l => {
                        if (!where.specialty?.OR) return true;
                        const spec = specialties.find(s => s.id === l.vismedSpecialtyId);
                        return where.specialty.OR.some((cond: any) =>
                            cond.idEmpresaGestora === null ? spec?.idEmpresaGestora == null : spec?.idEmpresaGestora === cond.idEmpresaGestora);
                    })
                    .map(l => ({ ...l, specialty: specialties.find(s => s.id === l.vismedSpecialtyId) }))),
            update: jest.fn(async ({ where, data }: any) => {
                const l = links.find(x => x.id === where.id);
                Object.assign(l, data);
                return l;
            }),
            delete: jest.fn(async ({ where }: any) => {
                const i = links.findIndex(l => l.id === where.id);
                if (i >= 0) links.splice(i, 1);
                return {};
            }),
        },
        specialtyServiceMapping: {
            findUnique: jest.fn(async () => null),
            update: jest.fn(async () => ({})),
            delete: jest.fn(async () => ({})),
        },
        $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    return prisma;
}

const matchingStub: any = { runMatchingForSpecialty: jest.fn(async () => { }) };

// Catálogos reais (recorte): disjuntos entre empresas, nomes homônimos.
const CATALOGO_52 = [
    { idcategoriaservico: '3484', nomecategoriaservico: 'Fonoaudiologia' },
    { idcategoriaservico: '3487', nomecategoriaservico: 'Psicologia' },
];
const CATALOGO_4 = [
    { idcategoriaservico: '192', nomecategoriaservico: 'Fonoaudiologia' },
    { idcategoriaservico: '195', nomecategoriaservico: 'Psicologia' },
];

function buildVismedClient() {
    return {
        getUnidades: jest.fn(async () => []),
        getEspecialidades: jest.fn(async (emp: number) => (Number(emp) === 52 ? CATALOGO_52 : CATALOGO_4)),
        getProfissionais: jest.fn(async (emp: number) => Number(emp) === 52
            ? [{ idprofissional: '9001', nomecompleto: 'DRA. PETRO', ativo: '1', especialidades: 'Fonoaudiologia' }]
            : [{ idprofissional: '9002', nomecompleto: 'DR. LEO', ativo: '1', especialidades: 'Fonoaudiologia' }]),
        getConvenios: jest.fn(async () => []),
    };
}

function job(emp: number, clinic: string): any {
    return { id: `j-${emp}`, name: 'vismed-sync', data: { idEmpresaGestora: emp, clinicId: clinic, syncRunId: 'run-x' } };
}

describe('Task 206 — coexistência e idempotência entre empresas gestoras', () => {
    it('homônimas 192 e 3484 coexistem; ciclos alternados 52→4→52→4 não geram migração cruzada', async () => {
        const prisma = buildPrismaFake();
        const processor = new VismedSyncProcessor(prisma, buildVismedClient() as any, matchingStub);

        // Ciclo de estabilização
        await processor.process(job(52, 'clinic-petro'));
        await processor.process(job(4, 'clinic-leo'));

        const snapshot = () => JSON.stringify(
            prisma._specialties.map((s: any) => [s.idEmpresaGestora, s.vismedId]).sort()
        ) + '|' + JSON.stringify(
            prisma._links.map((l: any) => [l.vismedDoctorId, l.vismedSpecialtyId]).sort()
        );
        const stable = snapshot();

        // Ambas homônimas coexistem, escopadas
        const fonos = prisma._specialties.filter((s: any) => s.normalizedName === 'fonoaudiologia');
        expect(fonos.map((s: any) => [s.idEmpresaGestora, s.vismedId]).sort()).toEqual([[4, 192], [52, 3484]]);

        // Cada médico vinculado à Fono da SUA empresa
        const linkVids = prisma._links.map((l: any) => ({
            doc: l.vismedDoctorId,
            vid: prisma._specialties.find((s: any) => s.id === l.vismedSpecialtyId)?.vismedId,
        }));
        expect(linkVids).toContainEqual({ doc: 'doc-9001', vid: 3484 });
        expect(linkVids).toContainEqual({ doc: 'doc-9002', vid: 192 });
        expect(linkVids).not.toContainEqual({ doc: 'doc-9001', vid: 192 });
        expect(linkVids).not.toContainEqual({ doc: 'doc-9002', vid: 3484 });

        // Ciclos seguintes: NENHUMA alteração, NENHUMA migração
        prisma._events.length = 0;
        await processor.process(job(52, 'clinic-petro'));
        await processor.process(job(4, 'clinic-leo'));
        expect(snapshot()).toBe(stable);
        expect(prisma._events.filter((e: any) => e.action === 'specialty_migrated')).toHaveLength(0);
        expect(prisma._events.filter((e: any) => e.action === 'specialty_link_removed')).toHaveLength(0);
    });

    it('registro legado sem escopo é reivindicado pelo vismedId, preservando vínculos', async () => {
        const legado = { id: 'spec-legado', vismedId: 3484, idEmpresaGestora: null, name: 'Fonoaudiologia', normalizedName: 'fonoaudiologia' };
        const linkManual = { id: 'l-man', vismedDoctorId: 'doc-9001', vismedSpecialtyId: 'spec-legado', source: 'MANUAL' };
        const prisma = buildPrismaFake([legado], [linkManual]);
        const processor = new VismedSyncProcessor(prisma, buildVismedClient() as any, matchingStub);

        await processor.process(job(52, 'clinic-petro'));

        const claimed = prisma._specialties.find((s: any) => s.id === 'spec-legado');
        expect(claimed.idEmpresaGestora).toBe(52);
        // Vínculo MANUAL preservado no mesmo registro (sem duplicata criada)
        expect(prisma._specialties.filter((s: any) => s.vismedId === 3484)).toHaveLength(1);
        expect(prisma._links.some((l: any) => l.id === 'l-man')).toBe(true);
        expect(prisma._events.some((e: any) => e.action === 'specialty_claimed')).toBe(true);
    });

    it('obsoletos: migração só dentro do próprio escopo; categorias da outra empresa intocadas', async () => {
        // Empresa 52 tinha um código antigo (999) para Fonoaudiologia que sumiu do retorno.
        const antiga52 = { id: 'spec-999', vismedId: 999, idEmpresaGestora: 52, name: 'Fonoaudiologia', normalizedName: 'fonoaudiologia' };
        const daOutra = { id: 'spec-192', vismedId: 192, idEmpresaGestora: 4, name: 'Fonoaudiologia', normalizedName: 'fonoaudiologia' };
        const linkAntigo = { id: 'l-999', vismedDoctorId: 'doc-9001', vismedSpecialtyId: 'spec-999', source: 'SYNC' };
        const linkOutra = { id: 'l-192', vismedDoctorId: 'doc-9002', vismedSpecialtyId: 'spec-192', source: 'SYNC' };
        const prisma = buildPrismaFake([antiga52, daOutra], [linkAntigo, linkOutra]);
        const processor = new VismedSyncProcessor(prisma, buildVismedClient() as any, matchingStub);

        await processor.process(job(52, 'clinic-petro'));

        // 999 (própria empresa) migrada para 3484 e removida
        expect(prisma._specialties.some((s: any) => s.vismedId === 999)).toBe(false);
        // 192 (empresa 4) permanece INTOCADA, com o vínculo do médico da outra clínica
        const spec192 = prisma._specialties.find((s: any) => s.vismedId === 192);
        expect(spec192).toBeDefined();
        expect(spec192.idEmpresaGestora).toBe(4);
        expect(prisma._links.some((l: any) => l.id === 'l-192')).toBe(true);
        // Vínculo do médico da empresa 52 acabou na 3484
        const spec3484 = prisma._specialties.find((s: any) => s.vismedId === 3484);
        expect(prisma._links.some((l: any) => l.vismedDoctorId === 'doc-9001' && l.vismedSpecialtyId === spec3484.id)).toBe(true);
    });
});
