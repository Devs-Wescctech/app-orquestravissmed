/**
 * Task 136 — Stagger determinístico da Global Sync entre clínicas.
 *
 * Cobre: fórmula de slot dinâmico (1/2/10/20/50 clínicas), determinismo
 * independente da ordem do banco, checagem de SyncRun running no MOMENTO do
 * disparo, skip/erro isolados sem cancelar demais timers, isRunning correto
 * (sem ciclo paralelo, liberado no finally) e shutdown limpo
 * (onModuleDestroy cancela timers e resolve as Promises, nenhum callback
 * dispara após isShuttingDown=true).
 */
import { SyncSchedulerService, computeStaggerPlan } from './sync-scheduler.service';

const MIN = 60 * 1000;

function makeClinics(n: number) {
    return Array.from({ length: n }, (_, i) => ({
        id: `clinic-${String(i + 1).padStart(3, '0')}`,
        name: `Clínica ${i + 1}`,
    }));
}

function makeService(clinics: any[]) {
    const prisma: any = {
        clinic: { findMany: jest.fn(async () => clinics) },
        syncRun: {
            count: jest.fn(async () => 0),
            updateMany: jest.fn(async () => ({ count: 0 })),
        },
        skippedBookingAlert: {
            updateMany: jest.fn(async () => ({ count: 0 })),
            deleteMany: jest.fn(async () => ({ count: 0 })),
        },
    };
    const syncService: any = {
        triggerGlobalSync: jest.fn(async () => ({ vismedRunId: 'v', doctoraliaRunId: 'd' })),
    };
    const service = new SyncSchedulerService(prisma, syncService);
    return { service, prisma, syncService };
}

// Avança fake timers permitindo que microtasks (awaits) rodem entre passos.
async function advance(ms: number) {
    await jest.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
    jest.useFakeTimers();
    delete process.env.DISABLE_SYNC_CRON;
});

afterEach(() => {
    jest.useRealTimers();
});

describe('computeStaggerPlan (função pura)', () => {
    it('1 clínica → offset 0 (disparo imediato), slot travado no teto de 3 min', () => {
        const plan = computeStaggerPlan(makeClinics(1));
        expect(plan.slotMs).toBe(3 * MIN);
        expect(plan.entries).toHaveLength(1);
        expect(plan.entries[0].offsetMs).toBe(0);
    });

    it('2 clínicas → slot 3 min (teto), offsets 0 e 3 min', () => {
        const plan = computeStaggerPlan(makeClinics(2));
        expect(plan.slotMs).toBe(3 * MIN);
        expect(plan.entries.map(e => e.offsetMs)).toEqual([0, 3 * MIN]);
    });

    it('10 clínicas → slot 2m24s, última em 21m36s (< 24 min)', () => {
        const plan = computeStaggerPlan(makeClinics(10));
        expect(plan.slotMs).toBe(144_000);
        expect(plan.entries[9].offsetMs).toBe(9 * 144_000);
        expect(plan.entries[9].offsetMs).toBeLessThan(24 * MIN);
    });

    it('20 clínicas → slot 1m12s; 50 clínicas → 28.8s; sempre dentro da janela de 24 min', () => {
        const p20 = computeStaggerPlan(makeClinics(20));
        expect(p20.slotMs).toBe(72_000);
        expect(p20.entries[19].offsetMs).toBeLessThan(24 * MIN);

        const p50 = computeStaggerPlan(makeClinics(50));
        expect(p50.slotMs).toBe(28_800);
        expect(p50.entries[49].offsetMs).toBe(49 * 28_800);
        expect(p50.entries[49].offsetMs).toBeLessThan(24 * MIN);
    });

    it('volume extremo (500 clínicas) → todas ainda dentro da janela por construção', () => {
        const plan = computeStaggerPlan(makeClinics(500));
        expect(plan.entries[499].offsetMs).toBeLessThan(24 * MIN);
    });

    it('determinismo: offsets ordenados por clinicId, independente da ordem do banco', () => {
        const clinics = makeClinics(5);
        const shuffled = [clinics[3], clinics[0], clinics[4], clinics[2], clinics[1]];
        const a = computeStaggerPlan(clinics);
        const b = computeStaggerPlan(shuffled);
        expect(b.entries.map(e => ({ id: e.clinic.id, off: e.offsetMs })))
            .toEqual(a.entries.map(e => ({ id: e.clinic.id, off: e.offsetMs })));
    });

    it('redistribui ao adicionar/remover clínica (slot recalculado por ciclo)', () => {
        const before = computeStaggerPlan(makeClinics(12));
        const after = computeStaggerPlan(makeClinics(13));
        expect(before.slotMs).toBe(Math.floor(24 * MIN / 12));
        expect(after.slotMs).toBe(Math.floor(24 * MIN / 13));
        expect(after.slotMs).not.toBe(before.slotMs);
    });

    it('lista vazia → sem entradas', () => {
        expect(computeStaggerPlan([])).toEqual({ slotMs: 0, entries: [] });
    });
});

describe('ciclo staggered do scheduler', () => {
    it('1 clínica dispara imediatamente e o ciclo encerra (isRunning liberado)', async () => {
        const { service, syncService } = makeService(makeClinics(1));
        const cycle = service.runGlobalSyncForAllClinics();
        await advance(0);
        expect(syncService.triggerGlobalSync).toHaveBeenCalledTimes(1);
        await cycle;
        expect((service as any).isRunning).toBe(false);
    });

    it('10 clínicas: disparos escalonados a cada 2m24s, todos dentro de ~24 min', async () => {
        const { service, syncService } = makeService(makeClinics(10));
        const cycle = service.runGlobalSyncForAllClinics();
        await advance(0);
        expect(syncService.triggerGlobalSync).toHaveBeenCalledTimes(1);
        await advance(144_000 - 1);
        expect(syncService.triggerGlobalSync).toHaveBeenCalledTimes(1);
        await advance(1);
        expect(syncService.triggerGlobalSync).toHaveBeenCalledTimes(2);
        await advance(9 * 144_000);
        expect(syncService.triggerGlobalSync).toHaveBeenCalledTimes(10);
        await cycle;
        expect((service as any).isRunning).toBe(false);
    });

    it('checagem de SyncRun running ocorre NO MOMENTO do disparo, não no início do ciclo', async () => {
        const clinics = makeClinics(2);
        const { service, prisma, syncService } = makeService(clinics);
        // No início do ciclo a clínica 2 está livre; fica ocupada só depois.
        let clinic2Busy = false;
        prisma.syncRun.count.mockImplementation(async ({ where }: any) =>
            where.clinicId === 'clinic-002' && clinic2Busy ? 1 : 0);

        const cycle = service.runGlobalSyncForAllClinics();
        await advance(0); // clínica 1 dispara
        clinic2Busy = true; // fica ocupada ANTES do timer da clínica 2
        await advance(3 * MIN);
        await cycle;

        expect(syncService.triggerGlobalSync).toHaveBeenCalledTimes(1);
        expect(syncService.triggerGlobalSync).toHaveBeenCalledWith('clinic-001');
    });

    it('erro em uma clínica não cancela os timers das demais; skip isolado idem', async () => {
        const { service, prisma, syncService } = makeService(makeClinics(3));
        syncService.triggerGlobalSync.mockImplementation(async (id: string) => {
            if (id === 'clinic-001') throw new Error('boom');
            return { vismedRunId: 'v', doctoraliaRunId: 'd' };
        });
        prisma.syncRun.count.mockImplementation(async ({ where }: any) =>
            where.clinicId === 'clinic-002' ? 1 : 0); // clínica 2 skippada

        const cycle = service.runGlobalSyncForAllClinics();
        await advance(2 * 3 * MIN);
        await cycle;

        // clínica 3 disparou normalmente apesar do erro na 1 e skip na 2
        expect(syncService.triggerGlobalSync).toHaveBeenCalledWith('clinic-003');
        expect((service as any).isRunning).toBe(false);
    });

    it('nenhum ciclo paralelo inicia enquanto há timers pendentes (isRunning=true durante o ciclo)', async () => {
        const { service, prisma, syncService } = makeService(makeClinics(5));
        const cycle = service.runGlobalSyncForAllClinics();
        await advance(MIN); // meio do ciclo, timers pendentes
        expect((service as any).isRunning).toBe(true);

        // Segundo cron dispara no meio → pulado, sem novos findMany/timers
        const callsBefore = prisma.clinic.findMany.mock.calls.length;
        await service.runGlobalSyncForAllClinics();
        expect(prisma.clinic.findMany.mock.calls.length).toBe(callsBefore);

        await advance(5 * 3 * MIN);
        await cycle;
        expect((service as any).isRunning).toBe(false);
        expect(syncService.triggerGlobalSync).toHaveBeenCalledTimes(5);
    });

    it('integração com a reserva (#133) inalterada: o scheduler apenas chama triggerGlobalSync', async () => {
        const { service, syncService } = makeService(makeClinics(1));
        const cycle = service.runGlobalSyncForAllClinics();
        await advance(0);
        await cycle;
        // Nenhuma fila/retry própria: exatamente uma chamada direta por clínica.
        expect(syncService.triggerGlobalSync).toHaveBeenCalledTimes(1);
        expect(syncService.triggerGlobalSync).toHaveBeenCalledWith('clinic-001');
    });

    it('nenhuma clínica ativa → ciclo encerra sem erro', async () => {
        const { service, syncService } = makeService([]);
        await service.runGlobalSyncForAllClinics();
        expect(syncService.triggerGlobalSync).not.toHaveBeenCalled();
        expect((service as any).isRunning).toBe(false);
    });
});

describe('shutdown (onModuleDestroy)', () => {
    it('ciclo com timers pendentes → destroy cancela timers, ciclo finaliza sem Promise pendurada, nenhum callback executa depois', async () => {
        const { service, syncService } = makeService(makeClinics(5));
        const cycle = service.runGlobalSyncForAllClinics();
        await advance(0); // primeira clínica dispara
        expect(syncService.triggerGlobalSync).toHaveBeenCalledTimes(1);
        expect((service as any).pendingDispatches.size).toBe(4);

        service.onModuleDestroy();
        expect((service as any).pendingDispatches.size).toBe(0);

        // O ciclo termina (allSettled resolve) e isRunning é liberado — sem avançar timers.
        await cycle;
        expect((service as any).isRunning).toBe(false);

        // Mesmo avançando o relógio, nenhum callback dispara após isShuttingDown=true.
        await advance(30 * MIN);
        expect(syncService.triggerGlobalSync).toHaveBeenCalledTimes(1);
    });

    it('após shutdown, novos ciclos do cron não iniciam', async () => {
        const { service, prisma } = makeService(makeClinics(2));
        service.onModuleDestroy();
        await service.runGlobalSyncForAllClinics();
        expect(prisma.clinic.findMany).not.toHaveBeenCalled();
    });
});
