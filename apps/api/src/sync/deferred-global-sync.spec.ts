/**
 * Task 133 — Integração processor/service da reserva de prioridade do Global Sync.
 *
 * Cobre em especial o timing real de fila apontado no code review:
 * run A adiado (reserva registrada) + run B independente já persistido como
 * 'running' (enfileirado, guard ainda NÃO ativo) → o callback de re-disparo
 * MANTÉM a reserva; quando B processa, consome a reserva e correlaciona
 * (metrics.resumedByRunId = B no run A) — exatamente uma vez, nunca perda silenciosa.
 */
import { ClinicConcurrencyGuard } from '../bookings/clinic-concurrency-guard';
import { SyncService } from './sync.service';
import { SyncProcessor } from './sync.processor';

const flush = () => new Promise<void>(res => setTimeout(res, 25));

function makePrismaMock() {
    const runs = new Map<string, any>();
    const prisma: any = {
        _runs: runs,
        syncRun: {
            create: jest.fn(async ({ data }: any) => {
                const r = { id: `run-${runs.size + 1}`, ...data };
                runs.set(r.id, r);
                return r;
            }),
            update: jest.fn(async ({ where, data }: any) => {
                const r = { ...(runs.get(where.id) ?? { id: where.id }), ...data };
                runs.set(where.id, r);
                return r;
            }),
            findUnique: jest.fn(async ({ where }: any) => runs.get(where.id) ?? null),
            count: jest.fn(async ({ where }: any) =>
                [...runs.values()].filter(r =>
                    r.clinicId === where.clinicId &&
                    r.status === 'running' &&
                    (!where.type?.not || r.type !== where.type.not)
                ).length),
        },
        clinic: { findUnique: jest.fn(async () => ({ active: true })) },
        auditLog: { create: jest.fn(async () => ({})) },
        integrationConnection: { findMany: jest.fn(async () => []) },
    };
    return prisma;
}

function makeStack() {
    const guard = new ClinicConcurrencyGuard();
    const prisma = makePrismaMock();
    const queueStub: any = { add: jest.fn(async () => ({})) };
    const syncService = new SyncService(
        queueStub, queueStub, prisma,
        null as any, null as any, null as any, null as any,
        guard, null as any,
    );
    const processor = new SyncProcessor(
        prisma, null as any, null as any, null as any,
        guard, null as any, syncService,
    );
    // O corpo real do sync não interessa aqui — só o ciclo acquire/consume/correlate.
    jest.spyOn(processor as any, '_processInner').mockResolvedValue({ status: 'completed' });
    return { guard, prisma, queueStub, syncService, processor };
}

describe('Task 133 — integração: run B independente enfileirado consome e correlaciona a reserva de A', () => {
    it('callback com B "running" (guard NÃO ativo) mantém a reserva; B processa, consome uma vez e grava resumedByRunId', async () => {
        const { guard, prisma, processor } = makeStack();
        const clinicId = 'clinic-1';

        // Run A criado pelo scheduler, clínica ocupada por POLLING → adiado
        prisma._runs.set('run-A', { id: 'run-A', clinicId, type: 'full', status: 'running' });
        guard.tryAcquire(clinicId, 'POLLING');
        const resultA = await processor.process({ data: { syncRunId: 'run-A', clinicId } } as any);

        expect(resultA.status).toBe('skipped');
        expect(String(resultA.reason)).toMatch(/^GLOBAL_SYNC_DEFERRED_/);
        expect(prisma._runs.get('run-A').status).toBe('skipped');
        expect(prisma._runs.get('run-A').metrics.skipReason).toMatch(/^GLOBAL_SYNC_DEFERRED_/);
        expect(guard.hasPriorityPending(clinicId)).toBe(true);

        // Run B independente já persistido como 'running' (enfileirado no BullMQ),
        // guard AINDA não ativo — timing normal de fila.
        prisma._runs.set('run-B', { id: 'run-B', clinicId, type: 'full', status: 'running' });

        // Polling termina → callback de re-disparo executa
        guard.release(clinicId, 'POLLING');
        await flush();

        // A reserva foi MANTIDA (não descartada) e nenhum run novo foi criado
        expect(guard.hasPriorityPending(clinicId)).toBe(true);
        expect(prisma.syncRun.create).not.toHaveBeenCalled();

        // B processa: adquire o guard, executa, consome a reserva e correlaciona
        const resultB = await processor.process({ data: { syncRunId: 'run-B', clinicId } } as any);
        expect(resultB.status).toBe('completed');

        expect(guard.hasPriorityPending(clinicId)).toBe(false);
        expect(prisma._runs.get('run-A').metrics.resumedByRunId).toBe('run-B');
        // skipReason preservado no merge
        expect(prisma._runs.get('run-A').metrics.skipReason).toMatch(/^GLOBAL_SYNC_DEFERRED_/);

        // Consumo exatamente uma vez; clínica totalmente livre
        expect(guard.consumePriority(clinicId)).toBeNull();
        expect(guard.getBlockReason(clinicId)).toBeNull();
        expect(guard.tryAcquire(clinicId, 'POLLING')).toBe(true);
        guard.release(clinicId, 'POLLING');
    });

    it('sem run em andamento, o callback cria um NOVO run correlacionado e re-enfileira; a execução consome a reserva', async () => {
        const { guard, prisma, queueStub, processor } = makeStack();
        const clinicId = 'clinic-1';

        prisma._runs.set('run-A', { id: 'run-A', clinicId, type: 'full', status: 'running' });
        guard.tryAcquire(clinicId, 'POLLING');
        await processor.process({ data: { syncRunId: 'run-A', clinicId } } as any);
        expect(guard.hasPriorityPending(clinicId)).toBe(true);

        guard.release(clinicId, 'POLLING');
        await flush();

        // Novo run criado e correlacionado nos dois sentidos
        expect(prisma.syncRun.create).toHaveBeenCalledTimes(1);
        const newRun = [...prisma._runs.values()].find(r => r.metrics?.deferredFromRunId === 'run-A');
        expect(newRun).toBeDefined();
        expect(prisma._runs.get('run-A').metrics.resumedByRunId).toBe(newRun.id);
        expect(queueStub.add).toHaveBeenCalledWith('process-sync', expect.objectContaining({ syncRunId: newRun.id, clinicId }), expect.anything());
        // Reserva permanece até o run re-disparado executar e consumi-la
        expect(guard.hasPriorityPending(clinicId)).toBe(true);

        await processor.process({ data: { syncRunId: newRun.id, clinicId } } as any);
        expect(guard.hasPriorityPending(clinicId)).toBe(false);
        expect(guard.tryAcquire(clinicId, 'POLLING')).toBe(true);
        guard.release(clinicId, 'POLLING');
    });

    it('race: GLOBAL_SYNC independente consome a reserva entre o release e o callback → nenhum resume obsoleto nem run extra', async () => {
        const { guard, prisma, processor } = makeStack();
        const clinicId = 'clinic-1';

        prisma._runs.set('run-A', { id: 'run-A', clinicId, type: 'full', status: 'running' });
        guard.tryAcquire(clinicId, 'POLLING');
        await processor.process({ data: { syncRunId: 'run-A', clinicId } } as any);
        expect(guard.hasPriorityPending(clinicId)).toBe(true);

        // Polling termina (callback agendado)…
        guard.release(clinicId, 'POLLING');
        // …e no MESMO tick um GLOBAL_SYNC independente B adquire, executa e
        // consome a reserva ANTES do callback rodar. B já terminou: nenhum run
        // permanece 'running' quando o callback obsoleto executaria.
        prisma._runs.set('run-B', { id: 'run-B', clinicId, type: 'full', status: 'running' });
        expect(guard.tryAcquire(clinicId, 'GLOBAL_SYNC')).toBe(true);
        const consumed = guard.consumePriority(clinicId);
        guard.release(clinicId, 'GLOBAL_SYNC');
        prisma._runs.set('run-B', { ...prisma._runs.get('run-B'), status: 'completed' });
        expect(consumed).toEqual({ tag: 'run-A' });

        await flush();

        // Callback obsoleto NÃO criou run extra nem re-registrou reserva
        expect(prisma.syncRun.create).not.toHaveBeenCalled();
        expect(guard.hasPriorityPending(clinicId)).toBe(false);
        expect(guard.tryAcquire(clinicId, 'POLLING')).toBe(true);
        guard.release(clinicId, 'POLLING');
    });

    it('clínica desativada é caso terminal: reserva descartada, nenhum run criado', async () => {
        const { guard, prisma, processor } = makeStack();
        const clinicId = 'clinic-1';
        prisma.clinic.findUnique.mockResolvedValue({ active: false });

        prisma._runs.set('run-A', { id: 'run-A', clinicId, type: 'full', status: 'running' });
        guard.tryAcquire(clinicId, 'POLLING');
        await processor.process({ data: { syncRunId: 'run-A', clinicId } } as any);
        guard.release(clinicId, 'POLLING');
        await flush();

        expect(guard.hasPriorityPending(clinicId)).toBe(false);
        expect(prisma.syncRun.create).not.toHaveBeenCalled();
        expect(guard.tryAcquire(clinicId, 'POLLING')).toBe(true);
        guard.release(clinicId, 'POLLING');
    });

    it('run VisMed em andamento NÃO bloqueia o re-disparo (não toca o guard)', async () => {
        const { guard, prisma, processor } = makeStack();
        const clinicId = 'clinic-1';

        prisma._runs.set('run-A', { id: 'run-A', clinicId, type: 'full', status: 'running' });
        prisma._runs.set('run-V', { id: 'run-V', clinicId, type: 'vismed-full', status: 'running' });
        guard.tryAcquire(clinicId, 'POLLING');
        await processor.process({ data: { syncRunId: 'run-A', clinicId } } as any);
        guard.release(clinicId, 'POLLING');
        await flush();

        // Re-disparo criou o novo run mesmo com o run VisMed em andamento
        expect(prisma.syncRun.create).toHaveBeenCalledTimes(1);
    });
});
