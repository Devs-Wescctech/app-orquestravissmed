/**
 * Task 216 — Fase 1: Full Sync VisMed pela baseUrl da clínica.
 *
 * Cobre isolamento de roteamento nos DOIS caminhos (processor via fila e fallback direto):
 *
 *  (a) Redis disponível → processor usa domain/clientId da clínica nas 4 chamadas.
 *  (b) Redis indisponível → caminho direto usa EXATAMENTE a mesma domain/clientId.
 *  (c) Conexão VisMed ausente → nenhum GET VisMed, SyncRun=failed.
 *  (d) domain ausente → nenhum GET VisMed, SyncRun=failed.
 *  (e) clientId ausente/inválido → nenhum GET VisMed, SyncRun=failed.
 *  (f) job.idEmpresaGestora ≠ clientId da conexão → falha observável.
 *  (g) Nunca usa 'api-vissmed-7' nem empresa 286 implicitamente.
 *  (h) Clínica A recebe baseUrl A e clínica B recebe baseUrl B.
 *  (i) Nenhuma desativação de médicos quando a lista encolhe.
 *  (j) Especialidade com campos nulos continua ignorada.
 *  (k) Upserts existentes seguem funcionando.
 */
import { VismedSyncProcessor } from './vismed-sync.processor';
import { SyncService } from '../sync.service';

// ---------------------------------------------------------------------------
// Minimal prisma fake — só o que o resolver e o processor precisam.
// ---------------------------------------------------------------------------
function buildConn(clinicId: string, clientId: string, domain: string, status = 'active') {
    return { clinicId, provider: 'vismed', status, clientId, domain };
}

function buildPrisma(connections: any[] = []) {
    let uid = 0;
    const id = () => `id-${++uid}`;
    const specialties: any[] = [];
    const doctors: any[] = [];
    const links: any[] = [];
    const syncRuns: any[] = [];

    const prisma: any = {
        _specialties: specialties,
        _doctors: doctors,
        _links: links,
        _syncRuns: syncRuns,
        integrationConnection: {
            findFirst: jest.fn(async ({ where }: any) =>
                connections.find(c => c.clinicId === where.clinicId && c.provider === where.provider) ?? null),
            findMany: jest.fn(async () => []),
        },
        syncRun: {
            create: jest.fn(async ({ data }: any) => {
                const r = { id: `run-${++uid}`, ...data };
                syncRuns.push(r);
                return r;
            }),
            update: jest.fn(async ({ where, data }: any) => {
                const r = syncRuns.find(x => x.id === where.id);
                if (r) Object.assign(r, data);
                return r ?? {};
            }),
            count: jest.fn(async () => 0),
        },
        syncEvent: { create: jest.fn(async () => ({})) },
        auditLog: { create: jest.fn(async () => ({})) },
        mapping: { upsert: jest.fn(async () => ({})) },
        vismedUnit: {
            upsert: jest.fn(async () => ({ id: id() })),
            findUnique: jest.fn(async () => null),
        },
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
                    (where.vismedId === undefined || s.vismedId === where.vismedId) &&
                    (where.idEmpresaGestora === undefined ||
                        (where.idEmpresaGestora === null
                            ? s.idEmpresaGestora == null
                            : s.idEmpresaGestora === where.idEmpresaGestora))
                ) ?? null),
            findMany: jest.fn(async ({ where, orderBy }: any) => {
                let res = specialties;
                if (where?.normalizedName !== undefined) res = res.filter(s => s.normalizedName === where.normalizedName);
                if (where?.vismedId?.notIn) res = res.filter(s => !where.vismedId.notIn.includes(s.vismedId));
                if (where?.idEmpresaGestora !== undefined) {
                    res = res.filter(s =>
                        where.idEmpresaGestora === null
                            ? s.idEmpresaGestora == null
                            : s.idEmpresaGestora === where.idEmpresaGestora);
                }
                if (orderBy?.vismedId === 'asc') res = [...res].sort((a, b) => a.vismedId - b.vismedId);
                return res.map(s => ({
                    ...s,
                    doctors: links.filter(l => l.vismedSpecialtyId === s.id),
                    mappings: [],
                }));
            }),
            create: jest.fn(async ({ data }: any) => { const s = { id: id(), ...data }; specialties.push(s); return s; }),
            update: jest.fn(async ({ where, data }: any) => {
                const s = specialties.find(x => x.id === where.id);
                if (s) Object.assign(s, data);
                return s;
            }),
            findUnique: jest.fn(async ({ where }: any) => specialties.find(s => s.id === where.id) ?? null),
            delete: jest.fn(async () => ({})),
        },
        vismedProfessionalSpecialty: {
            upsert: jest.fn(async ({ where, create }: any) => {
                const k = where.vismedDoctorId_vismedSpecialtyId;
                let l = links.find(x => x.vismedDoctorId === k.vismedDoctorId && x.vismedSpecialtyId === k.vismedSpecialtyId);
                if (!l) { l = { id: id(), ...create }; links.push(l); }
                return l;
            }),
            findMany: jest.fn(async () => []),
            findUnique: jest.fn(async () => null),
            delete: jest.fn(async () => ({})),
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

const matchingStub: any = { runMatchingForSpecialty: jest.fn(async () => {}) };

function buildVismedClient(overrides: Partial<{
    getUnidades: jest.Mock;
    getEspecialidades: jest.Mock;
    getProfissionais: jest.Mock;
    getConvenios: jest.Mock;
}> = {}) {
    return {
        getUnidades: jest.fn(async () => [{ idunidade: '1', nomeunidade: 'U1', codunidade: '1', cnpj: null, nomecidade: 'Cidade' }]),
        getEspecialidades: jest.fn(async () => [{ idcategoriaservico: '100', nomecategoriaservico: 'Cardiologia' }]),
        getProfissionais: jest.fn(async () => [{ idprofissional: '9001', nomecompleto: 'DR. TESTE', ativo: '1', especialidades: 'Cardiologia' }]),
        getConvenios: jest.fn(async () => [{ idconvenio: '1', nomeconvenio: 'Particular' }]),
        ...overrides,
    };
}

function processorJob(idEmpresaGestora: number | undefined, clinicId: string, syncRunId = 'run-ext'): any {
    return { id: 'j1', name: 'vismed-sync', data: { idEmpresaGestora, clinicId, syncRunId } };
}

// ---------------------------------------------------------------------------
// (a/b) Processor e caminho direto usam o domain/clientId da clínica
// ---------------------------------------------------------------------------
describe('(a) Processor: usa baseUrl e idEmpresaGestora da conexão da clínica', () => {
    it('repassa a baseUrl da clínica a todas as 4 chamadas de catálogo', async () => {
        const domain = 'https://app.vissmed.com.br/api-docctor-3';
        const prisma = buildPrisma([buildConn('clinic-a', '52', domain)]);
        const client = buildVismedClient();
        const processor = new VismedSyncProcessor(prisma as any, client as any, matchingStub);

        await processor.process(processorJob(52, 'clinic-a'));

        expect(client.getUnidades).toHaveBeenCalledWith(52, domain);
        expect(client.getEspecialidades).toHaveBeenCalledWith(52, domain);
        expect(client.getProfissionais).toHaveBeenCalledWith(52, domain);
        expect(client.getConvenios).toHaveBeenCalledWith(52, domain);
    });

    it('nunca passa api-vissmed-7 implicitamente quando há conexão configurada', async () => {
        const domain = 'https://app.vissmed.com.br/api-docctor-3';
        const prisma = buildPrisma([buildConn('clinic-a', '52', domain)]);
        const client = buildVismedClient();
        const processor = new VismedSyncProcessor(prisma as any, client as any, matchingStub);

        await processor.process(processorJob(52, 'clinic-a'));

        const allCalls = [
            ...client.getUnidades.mock.calls,
            ...client.getEspecialidades.mock.calls,
            ...client.getProfissionais.mock.calls,
            ...client.getConvenios.mock.calls,
        ];
        for (const call of allCalls) {
            expect(call[1]).not.toContain('api-vissmed-7');
        }
    });
});

describe('(b) Caminho direto (SyncService.runVismedSyncDirect): mesma baseUrl que o processor', () => {
    it('usa o domain da conexão, não o default global', async () => {
        const domain = 'https://app.vissmed.com.br/api-docctor-3';
        const prisma = buildPrisma([buildConn('clinic-a', '52', domain)]);
        const client = buildVismedClient();

        // Instancia SyncService com dependências mínimas para o caminho direto
        const svc: any = new SyncService(
            {} as any, {} as any, prisma as any, client as any, {} as any,
            matchingStub, {} as any, {} as any, {} as any,
        );
        await (svc as any).runVismedSyncDirect('run-direct', 'clinic-a', 52);

        expect(client.getUnidades).toHaveBeenCalledWith(52, domain);
        expect(client.getEspecialidades).toHaveBeenCalledWith(52, domain);
        expect(client.getProfissionais).toHaveBeenCalledWith(52, domain);
        expect(client.getConvenios).toHaveBeenCalledWith(52, domain);

        const allCalls = [
            ...client.getUnidades.mock.calls,
            ...client.getEspecialidades.mock.calls,
            ...client.getProfissionais.mock.calls,
            ...client.getConvenios.mock.calls,
        ];
        for (const call of allCalls) {
            expect(call[1]).not.toContain('api-vissmed-7');
        }
    });
});

// ---------------------------------------------------------------------------
// (c) Conexão ausente → fail-closed
// ---------------------------------------------------------------------------
describe('(c) Conexão VisMed ausente → nenhum GET, SyncRun=failed', () => {
    it('processor falha sem chamar a VisMed', async () => {
        const prisma = buildPrisma([]); // sem conexão
        const client = buildVismedClient();
        const processor = new VismedSyncProcessor(prisma as any, client as any, matchingStub);

        await expect(processor.process(processorJob(52, 'clinic-x'))).rejects.toThrow();

        expect(client.getUnidades).not.toHaveBeenCalled();
        expect(client.getEspecialidades).not.toHaveBeenCalled();
        expect(client.getProfissionais).not.toHaveBeenCalled();
        expect(client.getConvenios).not.toHaveBeenCalled();

        // The processor updates the externally-provided syncRunId to 'failed'
        const updateCall = prisma.syncRun.update.mock.calls.find(
            (c: any) => c[0]?.data?.status === 'failed',
        );
        expect(updateCall).toBeDefined();
    });

    it('caminho direto falha sem chamar a VisMed', async () => {
        const prisma = buildPrisma([]);
        const client = buildVismedClient();
        const svc: any = new SyncService(
            {} as any, {} as any, prisma as any, client as any, {} as any,
            matchingStub, {} as any, {} as any, {} as any,
        );
        prisma._syncRuns.push({ id: 'run-direct', status: 'running' });
        await (svc as any).runVismedSyncDirect('run-direct', 'clinic-x', 52);

        expect(client.getUnidades).not.toHaveBeenCalled();
        const r = prisma._syncRuns.find((x: any) => x.id === 'run-direct');
        expect(r?.status).toBe('failed');
    });
});

// ---------------------------------------------------------------------------
// (d) domain ausente → fail-closed
// ---------------------------------------------------------------------------
describe('(d) domain ausente na conexão → nenhum GET, SyncRun=failed', () => {
    it('processor falha sem chamar a VisMed', async () => {
        const prisma = buildPrisma([buildConn('clinic-a', '52', '')]); // domain vazio
        const client = buildVismedClient();
        const processor = new VismedSyncProcessor(prisma as any, client as any, matchingStub);

        await expect(processor.process(processorJob(52, 'clinic-a'))).rejects.toThrow(/domain/i);
        expect(client.getUnidades).not.toHaveBeenCalled();
    });

    it('caminho direto falha sem chamar a VisMed', async () => {
        const prisma = buildPrisma([{ ...buildConn('clinic-a', '52', ''), domain: null }]);
        const client = buildVismedClient();
        const svc: any = new SyncService(
            {} as any, {} as any, prisma as any, client as any, {} as any,
            matchingStub, {} as any, {} as any, {} as any,
        );
        prisma._syncRuns.push({ id: 'run-d', status: 'running' });
        await (svc as any).runVismedSyncDirect('run-d', 'clinic-a', 52);
        expect(client.getUnidades).not.toHaveBeenCalled();
        expect(prisma._syncRuns.find((r: any) => r.id === 'run-d')?.status).toBe('failed');
    });
});

// ---------------------------------------------------------------------------
// (e) clientId ausente/inválido → fail-closed
// ---------------------------------------------------------------------------
describe('(e) clientId ausente ou inválido → nenhum GET, SyncRun=failed', () => {
    it('clientId null → processor falha', async () => {
        const prisma = buildPrisma([{ ...buildConn('clinic-a', '52', 'https://x.com/api-1'), clientId: null }]);
        const client = buildVismedClient();
        const processor = new VismedSyncProcessor(prisma as any, client as any, matchingStub);
        await expect(processor.process(processorJob(undefined, 'clinic-a'))).rejects.toThrow(/clientId/i);
        expect(client.getUnidades).not.toHaveBeenCalled();
    });

    it('clientId "abc" (não-numérico) → processor falha', async () => {
        const prisma = buildPrisma([{ ...buildConn('clinic-a', '52', 'https://x.com/api-1'), clientId: 'abc' }]);
        const client = buildVismedClient();
        const processor = new VismedSyncProcessor(prisma as any, client as any, matchingStub);
        await expect(processor.process(processorJob(undefined, 'clinic-a'))).rejects.toThrow(/clientId/i);
        expect(client.getUnidades).not.toHaveBeenCalled();
    });

    it('status "error" → processor falha sem chamar VisMed', async () => {
        const prisma = buildPrisma([buildConn('clinic-a', '52', 'https://x.com/api-1', 'error')]);
        const client = buildVismedClient();
        const processor = new VismedSyncProcessor(prisma as any, client as any, matchingStub);
        await expect(processor.process(processorJob(52, 'clinic-a'))).rejects.toThrow(/error/i);
        expect(client.getUnidades).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// (f) job.idEmpresaGestora ≠ clientId da conexão → falha observável
// ---------------------------------------------------------------------------
describe('(f) job.idEmpresaGestora diverge do clientId da conexão → falha observável', () => {
    it('processor lança erro e não chama VisMed', async () => {
        const prisma = buildPrisma([buildConn('clinic-a', '52', 'https://app.vissmed.com.br/api-docctor-3')]);
        const client = buildVismedClient();
        const processor = new VismedSyncProcessor(prisma as any, client as any, matchingStub);

        // Job diz empresa 99, mas conexão diz 52 → divergência
        await expect(processor.process(processorJob(99, 'clinic-a'))).rejects.toThrow(/divergente/i);
        expect(client.getUnidades).not.toHaveBeenCalled();

        const failCall = prisma.syncRun.update.mock.calls.find(
            (c: any) => c[0]?.data?.status === 'failed',
        );
        expect(failCall).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// (g) Nunca usa api-vissmed-7 nem empresa 286 implicitamente
// ---------------------------------------------------------------------------
describe('(g) Nunca usa api-vissmed-7 nem empresa 286 implicitamente', () => {
    it('com conexão válida, empresa 286 no DB: usa 286 SÓ se é o clientId da conexão — não como fallback silencioso', async () => {
        // Aqui 286 está na conexão propositalmente → é legítimo
        const domain = 'https://app.vissmed.com.br/api-vissmed-7';
        const prisma = buildPrisma([buildConn('clinic-b', '286', domain)]);
        const client = buildVismedClient();
        const processor = new VismedSyncProcessor(prisma as any, client as any, matchingStub);

        await processor.process(processorJob(286, 'clinic-b'));

        // Todas as 4 chamadas usam 286 e o domain explícito da conexão (não o default implícito)
        expect(client.getUnidades).toHaveBeenCalledWith(286, domain);
        expect(client.getEspecialidades).toHaveBeenCalledWith(286, domain);
    });

    it('sem conexão configurada: não usa 286 nem api-vissmed-7 como fallback — falha', async () => {
        const prisma = buildPrisma([]);
        const client = buildVismedClient();
        const processor = new VismedSyncProcessor(prisma as any, client as any, matchingStub);

        await expect(processor.process(processorJob(undefined, 'clinic-unknown'))).rejects.toThrow();
        expect(client.getUnidades).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// (h) Clínica A usa baseUrl A, clínica B usa baseUrl B — sem contaminação
// ---------------------------------------------------------------------------
describe('(h) Clínica A e clínica B recebem baseUrls distintas', () => {
    it('dois processors independentes: cada um usa a URL da sua clínica', async () => {
        const domainA = 'https://app.vissmed.com.br/api-docctor-3';
        const domainB = 'https://app.vissmed.com.br/api-vissmed-5';
        const prismaA = buildPrisma([buildConn('clinic-a', '52', domainA)]);
        const prismaB = buildPrisma([buildConn('clinic-b', '4', domainB)]);
        const clientA = buildVismedClient();
        const clientB = buildVismedClient();

        const procA = new VismedSyncProcessor(prismaA as any, clientA as any, matchingStub);
        const procB = new VismedSyncProcessor(prismaB as any, clientB as any, matchingStub);

        await procA.process(processorJob(52, 'clinic-a'));
        await procB.process(processorJob(4, 'clinic-b'));

        expect(clientA.getUnidades).toHaveBeenCalledWith(52, domainA);
        expect(clientB.getUnidades).toHaveBeenCalledWith(4, domainB);
        // Sem contaminação cruzada
        expect(clientA.getUnidades).not.toHaveBeenCalledWith(expect.anything(), domainB);
        expect(clientB.getUnidades).not.toHaveBeenCalledWith(expect.anything(), domainA);
    });
});

// ---------------------------------------------------------------------------
// (i) Nenhuma desativação de médicos antigos quando a lista encolhe
// ---------------------------------------------------------------------------
describe('(i) Lista de profissionais encolhe: médicos antigos não são desativados', () => {
    it('upsert não remove profissionais que não vieram no retorno', async () => {
        const domain = 'https://app.vissmed.com.br/api-docctor-3';
        const prisma = buildPrisma([buildConn('clinic-a', '52', domain)]);
        const matchingFake: any = { runMatchingForSpecialty: jest.fn(async () => {}) };

        // Primeiro ciclo: 2 profissionais
        const client1 = buildVismedClient({
            getProfissionais: jest.fn(async () => [
                { idprofissional: '1', nomecompleto: 'DR. A', ativo: '1', especialidades: '' },
                { idprofissional: '2', nomecompleto: 'DR. B', ativo: '1', especialidades: '' },
            ]),
        });
        const proc1 = new VismedSyncProcessor(prisma as any, client1 as any, matchingFake);
        await proc1.process(processorJob(52, 'clinic-a'));

        expect(prisma._doctors).toHaveLength(2);

        // Segundo ciclo: só 1 profissional → o outro NÃO é removido/desativado
        const client2 = buildVismedClient({
            getProfissionais: jest.fn(async () => [
                { idprofissional: '1', nomecompleto: 'DR. A', ativo: '1', especialidades: '' },
            ]),
        });
        const proc2 = new VismedSyncProcessor(prisma as any, client2 as any, matchingFake);
        await proc2.process(processorJob(52, 'clinic-a', 'run-ext2'));

        // Médico 2 permanece no banco — não é desativado
        expect(prisma._doctors).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// (j) Especialidade com campos nulos é ignorada sem quebrar o sync
// ---------------------------------------------------------------------------
describe('(j) Especialidade com idcategoriaservico ou nomecategoriaservico nulos é ignorada', () => {
    it('sync conclui com sucesso mesmo com especialidades malformadas', async () => {
        const domain = 'https://app.vissmed.com.br/api-docctor-3';
        const prisma = buildPrisma([buildConn('clinic-a', '52', domain)]);
        const client = buildVismedClient({
            getEspecialidades: jest.fn(async () => [
                { idcategoriaservico: null, nomecategoriaservico: 'Fantasma' },   // null id
                { idcategoriaservico: '100', nomecategoriaservico: null },          // null name
                { idcategoriaservico: '101', nomecategoriaservico: 'Cardiologia' }, // válida
            ]),
        });
        const processor = new VismedSyncProcessor(prisma as any, client as any, matchingStub);

        await expect(processor.process(processorJob(52, 'clinic-a'))).resolves.not.toThrow();

        // Só a especialidade válida foi criada
        const namedSpecs = prisma._specialties.filter((s: any) => s.name === 'Cardiologia');
        expect(namedSpecs).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// (k) Upserts existentes (unidade, convênio) seguem funcionando
// ---------------------------------------------------------------------------
describe('(k) Upserts existentes de unidades e convênios funcionam normalmente', () => {
    it('upsert de unidade e convênio chamados com dados corretos', async () => {
        const domain = 'https://app.vissmed.com.br/api-docctor-3';
        const prisma = buildPrisma([buildConn('clinic-a', '52', domain)]);
        const client = buildVismedClient({
            getUnidades: jest.fn(async () => [
                { idunidade: '10', nomeunidade: 'Sede', codunidade: '1', cnpj: '00.000.000/0001-00', nomecidade: 'SP' },
            ]),
            getConvenios: jest.fn(async () => [
                { idconvenio: '5', nomeconvenio: 'Plano X', ativo: '1' },
            ]),
        });
        const processor = new VismedSyncProcessor(prisma as any, client as any, matchingStub);

        await processor.process(processorJob(52, 'clinic-a'));

        expect(prisma.vismedUnit.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ where: { vismedId: 10 } }),
        );
        expect(prisma.vismedInsurance.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ where: { vismedId: 5 } }),
        );
    });
});
