/**
 * Task 61 — Categorias duplicadas por nome no vínculo médico↔categoria.
 *
 * Cobre os dois pontos de entrada da sync (processor enfileirado e fallback direto
 * do SyncService), verificando:
 *  - vínculo a TODAS as categorias homônimas, em ordem determinística (vismedId asc);
 *  - criação de categoria "fantasma" SOMENTE quando nenhuma homônima existe;
 *  - remoção de vínculos SYNC obsoletos (categoria fora das especialidades atuais);
 *  - preservação de vínculos MANUAL na limpeza.
 */
import { VismedSyncProcessor } from './vismed-sync.processor';
import { SyncService } from '../sync.service';

// ---------------------------------------------------------------------------
// Prisma fake em memória, cobrindo só o que os fluxos usam.
// ---------------------------------------------------------------------------
function buildPrismaFake() {
    let uid = 0;
    const id = () => `id-${++uid}`;

    const specialties: any[] = [
        { id: 'spec-180', vismedId: 180, name: 'Oftalmologia', normalizedName: 'oftalmologia' },
        { id: 'spec-3472', vismedId: 3472, name: 'Oftalmologia', normalizedName: 'oftalmologia' },
        { id: 'spec-196', vismedId: 196, name: 'Fisioterapia', normalizedName: 'fisioterapia' },
        { id: 'spec-man', vismedId: 555561, name: 'Manual', normalizedName: 'manual' },
    ];
    const doctors: any[] = [];
    const links: any[] = [
        // Estado quebrado atual: só 180 (uma das homônimas) + 196 obsoleta + vínculo MANUAL.
        // vismedDoctorId será rebindado após o upsert do doctor (ver vismedDoctor.upsert).
        { id: 'l-180', vismedDoctorId: 'doc-mateus', vismedSpecialtyId: 'spec-180', source: 'SYNC' },
        { id: 'l-196', vismedDoctorId: 'doc-mateus', vismedSpecialtyId: 'spec-196', source: 'SYNC' },
        { id: 'l-man', vismedDoctorId: 'doc-mateus', vismedSpecialtyId: 'spec-man', source: 'MANUAL' },
    ];

    const prisma: any = {
        _specialties: specialties,
        _links: links,
        syncRun: { create: jest.fn(async () => ({ id: 'run-1' })), update: jest.fn(async () => ({})) },
        syncEvent: { create: jest.fn(async () => ({})) },
        auditLog: { create: jest.fn(async () => ({})) },
        mapping: { upsert: jest.fn(async () => ({})) },
        vismedUnit: { upsert: jest.fn(async () => ({ id: id() })), findUnique: jest.fn(async () => null) },
        vismedInsurance: { upsert: jest.fn(async () => ({ id: id() })) },
        integrationConnection: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
        vismedDoctor: {
            upsert: jest.fn(async ({ where, create }: any) => {
                let d = doctors.find(x => x.vismedId === where.vismedId);
                if (!d) {
                    d = { id: 'doc-mateus', ...create };
                    doctors.push(d);
                }
                return d;
            }),
        },
        vismedSpecialty: {
            // Filtro de empresa gestora: `null` casa registros sem escopo; número casa igual.
            findFirst: jest.fn(async ({ where }: any) => {
                return specialties.find(s =>
                    (where.vismedId === undefined || s.vismedId === where.vismedId)
                    && (where.idEmpresaGestora === undefined
                        || (where.idEmpresaGestora === null ? s.idEmpresaGestora == null : s.idEmpresaGestora === where.idEmpresaGestora))
                ) || null;
            }),
            update: jest.fn(async ({ where, data }: any) => {
                const s = specialties.find(x => x.id === where.id);
                Object.assign(s, data);
                return s;
            }),
            findMany: jest.fn(async ({ where, orderBy }: any) => {
                let res = specialties;
                if (where?.normalizedName !== undefined) res = res.filter(s => s.normalizedName === where.normalizedName);
                if (where?.vismedId?.notIn) res = res.filter(s => !where.vismedId.notIn.includes(s.vismedId));
                if (where?.idEmpresaGestora !== undefined) {
                    res = res.filter(s => where.idEmpresaGestora === null ? s.idEmpresaGestora == null : s.idEmpresaGestora === where.idEmpresaGestora);
                }
                if (orderBy?.vismedId === 'asc') res = [...res].sort((a, b) => a.vismedId - b.vismedId);
                // include doctors/mappings p/ migrateObsoleteSpecialties
                return res.map(s => ({ ...s, doctors: links.filter(l => l.vismedSpecialtyId === s.id), mappings: [] }));
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
            findMany: jest.fn(async ({ where }: any) => {
                return links
                    .filter(l => l.vismedDoctorId === where.vismedDoctorId
                        && l.source === where.source
                        && !where.vismedSpecialtyId.notIn.includes(l.vismedSpecialtyId))
                    .filter(l => {
                        // Filtro de escopo do stale-link cleanup: empresa da execução OU sem escopo.
                        if (!where.specialty?.OR) return true;
                        const spec = specialties.find(s => s.id === l.vismedSpecialtyId);
                        return where.specialty.OR.some((cond: any) =>
                            cond.idEmpresaGestora === null ? spec?.idEmpresaGestora == null : spec?.idEmpresaGestora === cond.idEmpresaGestora);
                    })
                    .map(l => ({ ...l, specialty: specialties.find(s => s.id === l.vismedSpecialtyId) }));
            }),
            delete: jest.fn(async ({ where }: any) => {
                const i = links.findIndex(l => l.id === where.id);
                if (i >= 0) links.splice(i, 1);
                return {};
            }),
        },
        $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    return prisma;
}

const vismedFixture = {
    getUnidades: jest.fn(async () => []),
    getEspecialidades: jest.fn(async () => [
        { idcategoriaservico: '180', nomecategoriaservico: 'Oftalmologia' },
        { idcategoriaservico: '3472', nomecategoriaservico: 'Oftalmologia' },
        { idcategoriaservico: '196', nomecategoriaservico: 'Fisioterapia' },
        { idcategoriaservico: '555561', nomecategoriaservico: 'Manual' },
    ]),
    getProfissionais: jest.fn(async () => [
        // Especialidades atuais: só Oftalmologia + uma inexistente no catálogo (fantasma).
        { idprofissional: '999901', nomecompleto: 'DR. MATEUS', ativo: '1', especialidades: 'Oftalmologia, Quiropraxia Nova' },
    ]),
    getConvenios: jest.fn(async () => []),
};
const matchingStub: any = { runMatchingForSpecialty: jest.fn(async () => {}) };

function expectCorrectLinks(prisma: any) {
    const byVid = prisma._links
        .map((l: any) => ({
            vid: prisma._specialties.find((s: any) => s.id === l.vismedSpecialtyId)?.vismedId,
            source: l.source,
            norm: prisma._specialties.find((s: any) => s.id === l.vismedSpecialtyId)?.normalizedName,
        }))
        .sort((a: any, b: any) => a.vid - b.vid);

    // Homônimas: AMBAS 180 e 3472 vinculadas
    expect(byVid.some((l: any) => l.vid === 180)).toBe(true);
    expect(byVid.some((l: any) => l.vid === 3472)).toBe(true);
    // Obsoleta SYNC (196 Fisioterapia) removida
    expect(byVid.some((l: any) => l.vid === 196)).toBe(false);
    // MANUAL preservado mesmo fora das especialidades atuais
    expect(byVid.some((l: any) => l.vid === 555561 && l.source === 'MANUAL')).toBe(true);
    // Fantasma criada apenas para o nome sem homônimas ("Quiropraxia Nova")
    const ghosts = prisma._specialties.filter((s: any) => s.normalizedName === 'quiropraxia nova');
    expect(ghosts.length).toBe(1);
    expect(byVid.some((l: any) => l.norm === 'quiropraxia nova')).toBe(true);
    // Nenhuma fantasma extra de "Oftalmologia" (homônimas já existiam)
    expect(prisma._specialties.filter((s: any) => s.normalizedName === 'oftalmologia').length).toBe(2);
}

describe('Task 61 — categorias homônimas (processor enfileirado)', () => {
    it('vincula todas as homônimas, remove SYNC obsoleto, preserva MANUAL, fantasma só sem homônimas — idempotente', async () => {
        const prisma = buildPrismaFake();
        const processor = new VismedSyncProcessor(prisma, vismedFixture as any, matchingStub);
        const job: any = { id: 'j1', name: 'vismed-sync', data: { idEmpresaGestora: 286, clinicId: 'c1', syncRunId: 'run-1' } };

        await processor.process(job);
        expectCorrectLinks(prisma);
        const snapshot = JSON.stringify([...prisma._links].map((l: any) => l.vismedSpecialtyId).sort());

        // Reexecução: determinístico (mesmo resultado)
        await processor.process(job);
        expectCorrectLinks(prisma);
        expect(JSON.stringify([...prisma._links].map((l: any) => l.vismedSpecialtyId).sort())).toBe(snapshot);
    });
});

describe('Task 61 — categorias homônimas (fallback direto do SyncService)', () => {
    it('mesmo comportamento no caminho direto (sem Redis)', async () => {
        const prisma = buildPrismaFake();
        const svc: any = new SyncService(
            {} as any, {} as any, prisma, vismedFixture as any, {} as any, matchingStub, {} as any,
        );
        await (svc as any).runVismedSyncDirect('run-1', 'c1', 286);
        expectCorrectLinks(prisma);
    });
});
