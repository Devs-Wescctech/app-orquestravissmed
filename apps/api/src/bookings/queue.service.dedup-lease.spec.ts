/**
 * P1 — SyncJob: deduplicação atômica (P1a) e ownership/lease (P1b).
 *
 * Testes contra banco REAL: a garantia de dedup é do Postgres via índice
 * único parcial "SyncJob_dedupKey_active_key", não de check-then-create.
 */
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from './queue.service';

jest.setTimeout(60000);

const prisma = new PrismaService();
const svc: any = new QueueService(prisma as any);
let WORKER_ID = '';

const CLINIC = 'test-clinic-p1';
const key = (s: string) => `p1test:${s}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

async function cleanup() {
    await prisma.syncJob.deleteMany({ where: { clinicId: CLINIC } });
}

beforeAll(async () => {
    await prisma.$connect();
    await cleanup();
    WORKER_ID = (await svc.getMetrics()).workerId;
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

function countByKey(dedupKey: string) {
    return prisma.syncJob.count({ where: { dedupKey } });
}

async function makeRunningJob(k: string, opts: { attempts?: number; maxAttempts?: number; lockedBy?: string; lockedAgoMs?: number } = {}) {
    const job = await svc.enqueue(CLINIC, 't', {}, { dedupKey: k, maxAttempts: opts.maxAttempts ?? 5 });
    return prisma.syncJob.update({
        where: { id: job.id },
        data: {
            status: 'RUNNING',
            attempts: opts.attempts ?? 1,
            lockedBy: opts.lockedBy ?? WORKER_ID,
            lockedAt: new Date(Date.now() - (opts.lockedAgoMs ?? 0)),
        },
    });
}

describe('P1a — deduplicação atômica', () => {
    it('INSERT direto de duplicata ativa falha no nível SQL', async () => {
        const k = key('sql');
        await svc.enqueue(CLINIC, 't', {}, { dedupKey: k });
        await expect(prisma.$executeRaw`
            INSERT INTO "SyncJob" (id, "clinicId", type, payload, "nextRunAt", "dedupKey", "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), ${CLINIC}, 't', '{}'::jsonb, now(), ${k}, now(), now())
        `).rejects.toThrow(/SyncJob_dedupKey_active_key|23505|Unique/i);
    });

    it('dois enqueue() concorrentes com a mesma chave → 1 job (mesmo id retornado)', async () => {
        const k = key('conc-enq');
        const [a, b] = await Promise.all([
            svc.enqueue(CLINIC, 't', { n: 1 }, { dedupKey: k }),
            svc.enqueue(CLINIC, 't', { n: 2 }, { dedupKey: k }),
        ]);
        expect(await countByKey(k)).toBe(1);
        expect(a.id).toBe(b.id);
    });

    it('dois enqueueBatch() concorrentes com a mesma chave → 1 job', async () => {
        const k = key('conc-batch');
        const mk = () => [{ clinicId: CLINIC, type: 't', payload: {}, dedupKey: k }];
        await Promise.all([svc.enqueueBatch(mk()), svc.enqueueBatch(mk())]);
        expect(await countByKey(k)).toBe(1);
    });

    it('chave repetida dentro do MESMO batch → 1 job', async () => {
        const k = key('intra-batch');
        await svc.enqueueBatch([
            { clinicId: CLINIC, type: 't', payload: { n: 1 }, dedupKey: k },
            { clinicId: CLINIC, type: 't', payload: { n: 2 }, dedupKey: k },
        ]);
        expect(await countByKey(k)).toBe(1);
    });

    it('PENDING bloqueia duplicata (enqueue e batch)', async () => {
        const k = key('pending');
        await svc.enqueue(CLINIC, 't', {}, { dedupKey: k });
        await svc.enqueue(CLINIC, 't', {}, { dedupKey: k });
        await svc.enqueueBatch([{ clinicId: CLINIC, type: 't', payload: {}, dedupKey: k }]);
        expect(await countByKey(k)).toBe(1);
    });

    it('RUNNING bloqueia duplicata (dedupKey sobrevive ao claim)', async () => {
        const k = key('running');
        const job = await makeRunningJob(k);
        const dup = await svc.enqueue(CLINIC, 't', {}, { dedupKey: k });
        expect(dup.id).toBe(job.id);
        expect(await countByKey(k)).toBe(1);
    });

    it('FAILED com retries restantes bloqueia duplicata', async () => {
        const k = key('failed-retry');
        const job = await svc.enqueue(CLINIC, 't', {}, { dedupKey: k, maxAttempts: 5 });
        await prisma.syncJob.update({ where: { id: job.id }, data: { status: 'FAILED', attempts: 2 } });
        const dup = await svc.enqueue(CLINIC, 't', {}, { dedupKey: k });
        expect(dup.id).toBe(job.id);
        expect(await countByKey(k)).toBe(1);
    });

    it('COMPLETED libera a chave para novo job', async () => {
        const k = key('completed');
        const job = await svc.enqueue(CLINIC, 't', {}, { dedupKey: k });
        await prisma.syncJob.update({ where: { id: job.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
        const novo = await svc.enqueue(CLINIC, 't', {}, { dedupKey: k });
        expect(novo.id).not.toBe(job.id);
        expect(await countByKey(k)).toBe(2);
    });

    it('DEAD libera a chave para novo job', async () => {
        const k = key('dead');
        const job = await svc.enqueue(CLINIC, 't', {}, { dedupKey: k });
        await prisma.syncJob.update({ where: { id: job.id }, data: { status: 'DEAD', attempts: 5 } });
        const novo = await svc.enqueue(CLINIC, 't', {}, { dedupKey: k });
        expect(novo.id).not.toBe(job.id);
    });

    it('retryDeadLetters com job ativo conflitante pula o DEAD sem quebrar', async () => {
        await cleanup();
        const k = key('retry-dl');
        const dead = await svc.enqueue(CLINIC, 't', {}, { dedupKey: k });
        await prisma.syncJob.update({ where: { id: dead.id }, data: { status: 'DEAD', attempts: 5 } });
        const active = await svc.enqueue(CLINIC, 't', {}, { dedupKey: k }); // chave liberada pelo DEAD
        expect(active.id).not.toBe(dead.id);

        const res = await svc.retryDeadLetters(CLINIC);
        const still = await prisma.syncJob.findUnique({ where: { id: dead.id } });
        expect(still!.status).toBe('DEAD'); // pulado por conflito com o índice
        expect(res.skippedCount).toBeGreaterThanOrEqual(1);
    });

    it('retryDeadLetters ressuscita DEAD sem conflito', async () => {
        const k = key('retry-dl-ok');
        const dead = await svc.enqueue(CLINIC, 't', {}, { dedupKey: k });
        await prisma.syncJob.update({ where: { id: dead.id }, data: { status: 'DEAD', attempts: 5 } });
        await svc.retryDeadLetters(CLINIC);
        const after = await prisma.syncJob.findUnique({ where: { id: dead.id } });
        expect(after!.status).toBe('PENDING');
        expect(after!.attempts).toBe(0);
    });

    it('chaves diferentes são independentes; sem dedupKey nunca deduplica', async () => {
        const k1 = key('ind-1');
        const k2 = key('ind-2');
        await svc.enqueue(CLINIC, 't', {}, { dedupKey: k1 });
        await svc.enqueue(CLINIC, 't', {}, { dedupKey: k2 });
        expect(await countByKey(k1)).toBe(1);
        expect(await countByKey(k2)).toBe(1);
        const a = await svc.enqueue(CLINIC, 't', {});
        const b = await svc.enqueue(CLINIC, 't', {});
        expect(a.id).not.toBe(b.id);
    });

    it('enqueue com delayMs preserva nextRunAt futuro (contrato de retorno)', async () => {
        const k = key('delay');
        const job = await svc.enqueue(CLINIC, 't', {}, { dedupKey: k, delayMs: 60000 });
        expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 30000);
    });
});

describe('P1b — ownership / lease', () => {
    it('claimJob preserva dedupKey e altera apenas lockedBy/lockedAt/attempts/status', async () => {
        await cleanup();
        const k = key('claim');
        const before = await svc.enqueue(CLINIC, 't', { x: 1 }, { dedupKey: k, priority: 9999 });
        const claimed = await svc.claimJob();
        expect(claimed).not.toBeNull();
        expect(claimed.id).toBe(before.id);
        expect(claimed.dedupKey).toBe(k);
        expect(claimed.status).toBe('RUNNING');
        expect(claimed.lockedBy).toBe(WORKER_ID);
        expect(claimed.attempts).toBe(1);
        expect(claimed.payload).toEqual(before.payload);
        expect(claimed.priority).toBe(before.priority);
        expect(claimed.maxAttempts).toBe(before.maxAttempts);
    });

    it('worker dono completa; job COMPLETED e chave liberada', async () => {
        const k = key('own-complete');
        const job = await makeRunningJob(k);
        await svc.completeJob(job.id, k);
        const after = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(after!.status).toBe('COMPLETED');
        expect(after!.lockedBy).toBeNull();
        expect(after!.dedupKey).toBe(k); // preservado como registro histórico
        const novo = await svc.enqueue(CLINIC, 't', {}, { dedupKey: k });
        expect(novo.id).not.toBe(job.id);
    });

    it('worker que NÃO é o dono não completa (no-op, sem exceção)', async () => {
        const k = key('foreign-complete');
        const job = await makeRunningJob(k, { lockedBy: 'other-worker' });
        await expect(svc.completeJob(job.id, k)).resolves.toBeUndefined();
        const after = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(after!.status).toBe('RUNNING');
        expect(after!.lockedBy).toBe('other-worker');
    });

    it('worker dono falha job → FAILED com backoff e dedupKey preservado', async () => {
        const k = key('own-fail');
        const job = await makeRunningJob(k, { attempts: 1, maxAttempts: 5 });
        await svc.failJob(job.id, 'boom', 1, 5, k);
        const after = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(after!.status).toBe('FAILED');
        expect(after!.dedupKey).toBe(k);
        expect(after!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
        // FAILED em retry continua bloqueando a chave
        const dup = await svc.enqueue(CLINIC, 't', {}, { dedupKey: k });
        expect(dup.id).toBe(job.id);
    });

    it('failJob com attempts esgotados → DEAD', async () => {
        const k = key('own-dead');
        const job = await makeRunningJob(k, { attempts: 5, maxAttempts: 5 });
        await svc.failJob(job.id, 'boom', 5, 5, k);
        const after = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(after!.status).toBe('DEAD');
    });

    it('worker que NÃO é o dono não falha o job (no-op)', async () => {
        const k = key('foreign-fail');
        const job = await makeRunningJob(k, { lockedBy: 'other-worker' });
        await svc.failJob(job.id, 'boom', 1, 5, k);
        const after = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(after!.status).toBe('RUNNING');
    });

    it('cleanup recupera job com lease expirado → FAILED com backoff, dedupKey preservado', async () => {
        const k = key('cleanup-stale');
        const job = await makeRunningJob(k, { lockedAgoMs: 6 * 60 * 1000, lockedBy: 'dead-worker' });
        const res = await svc.runStaleLockCleanup();
        expect(res.recovered).toBeGreaterThanOrEqual(1);
        const after = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(after!.status).toBe('FAILED');
        expect(after!.dedupKey).toBe(k);
        expect(after!.lockedBy).toBeNull();
        expect(after!.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 30000);
    });

    it('cleanup com attempts esgotados → DEAD (zumbi FAILED/attempts>=max eliminado)', async () => {
        const k = key('cleanup-dead');
        const job = await makeRunningJob(k, { lockedAgoMs: 6 * 60 * 1000, lockedBy: 'dead-worker', attempts: 5, maxAttempts: 5 });
        const res = await svc.runStaleLockCleanup();
        expect(res.dead).toBeGreaterThanOrEqual(1);
        const after = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(after!.status).toBe('DEAD');
        expect(after!.dedupKey).toBe(k);
    });

    it('cleanup NÃO recupera job com heartbeat recente (lease vivo)', async () => {
        const k = key('cleanup-alive');
        const job = await makeRunningJob(k, { lockedAgoMs: 6 * 60 * 1000 });
        // heartbeat renova o lease...
        await svc.heartbeatTick(job, { leaseLost: false });
        await svc.runStaleLockCleanup();
        const after = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(after!.status).toBe('RUNNING'); // não reciclado
        expect(after!.lockedBy).toBe(WORKER_ID);
    });

    it('heartbeat renova lockedAt para o dono e detecta perda de lease (count=0)', async () => {
        const k = key('hb');
        const job = await makeRunningJob(k, { lockedAgoMs: 2 * 60 * 1000 });
        const state = { leaseLost: false };
        await svc.heartbeatTick(job, state);
        const renewed = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(renewed!.lockedAt!.getTime()).toBeGreaterThan(Date.now() - 60000);
        expect(state.leaseLost).toBe(false);

        // Outro worker assume → próximo tick detecta count===0 → lease-lost
        await prisma.syncJob.update({ where: { id: job.id }, data: { lockedBy: 'worker-B' } });
        await svc.heartbeatTick(job, state);
        expect(state.leaseLost).toBe(true);
    });

    it('heartbeat com erro transitório de banco NÃO marca lease-lost', async () => {
        const k = key('hb-transient');
        const job = await makeRunningJob(k);
        const state = { leaseLost: false };
        const spy = jest.spyOn(prisma.syncJob, 'updateMany').mockRejectedValueOnce(new Error('connection reset'));
        await svc.heartbeatTick(job, state);
        expect(state.leaseLost).toBe(false);
        spy.mockRestore();
        // Próximo tick (sem erro) renova normalmente
        await svc.heartbeatTick(job, state);
        expect(state.leaseLost).toBe(false);
    });

    it('cenário formal: A perde lease → cleanup recupera → B assume → A tardio não sobrescreve', async () => {
        const k = key('formal');
        // A (nosso WORKER_ID) possui o job, lease expirado
        const job = await makeRunningJob(k, { lockedAgoMs: 6 * 60 * 1000 });
        await svc.runStaleLockCleanup();
        let cur = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(cur!.status).toBe('FAILED');
        // B reivindica
        await prisma.syncJob.update({
            where: { id: job.id },
            data: { status: 'RUNNING', lockedBy: 'worker-B', lockedAt: new Date() },
        });
        // A termina depois e tenta completar/falhar → count=0 → no-op
        await svc.completeJob(job.id, k);
        cur = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(cur!.status).toBe('RUNNING');
        expect(cur!.lockedBy).toBe('worker-B');
        await svc.failJob(job.id, 'late failure', 1, 5, k);
        cur = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(cur!.status).toBe('RUNNING');
        expect(cur!.lockedBy).toBe('worker-B');
        // B mantém a posse e completa normalmente
        const asB = await prisma.syncJob.updateMany({
            where: { id: job.id, status: 'RUNNING', lockedBy: 'worker-B' },
            data: { status: 'COMPLETED', completedAt: new Date(), lockedAt: null, lockedBy: null },
        });
        expect(asB.count).toBe(1);
    });

    it('processJob com lease perdido descarta o resultado (não completa)', async () => {
        const k = key('discard');
        const job = await makeRunningJob(k);
        svc.registerHandler('discard-test', async () => {
            // Simula tomada por outro worker durante a execução do handler
            await prisma.syncJob.update({ where: { id: job.id }, data: { lockedBy: 'worker-B' } });
        });
        // Heartbeat de teste: um tick logo após o handler rodar detecta a perda
        const hbSpy = jest.spyOn(svc, 'startHeartbeat').mockImplementation((j: any, s: any) => {
            const t = setInterval(() => {}, 1 << 30);
            (svc as any).__hbFlush = () => svc.heartbeatTick(j, s);
            return t;
        });
        const p = svc.processJob({ ...job, type: 'discard-test' });
        // dá tempo do handler rodar e força um tick de heartbeat antes do terminal write
        await new Promise(r => setTimeout(r, 200));
        await (svc as any).__hbFlush();
        await p;
        hbSpy.mockRestore();
        const after = await prisma.syncJob.findUnique({ where: { id: job.id } });
        // A não completou nem falhou; dono continua worker-B
        expect(after!.lockedBy).toBe('worker-B');
        expect(after!.status).toBe('RUNNING');
    });

    it('smoke: handlers slot-booked/booking-canceled/booking-moved executam via fila sem mudança de comportamento', async () => {
        await cleanup();
        const done: string[] = [];
        for (const t of ['slot-booked', 'booking-canceled', 'booking-moved']) {
            svc.registerHandler(t, async (payload: any, clinicId: string) => {
                done.push(`${t}:${payload.n}:${clinicId}`);
            });
        }
        const ks = ['slot-booked', 'booking-canceled', 'booking-moved'].map(t => ({ t, k: key(`smoke-${t}`) }));
        for (const { t, k } of ks) {
            await svc.enqueue(CLINIC, t, { n: 1 }, { dedupKey: k, priority: 9999 });
        }
        for (let i = 0; i < 3; i++) {
            const job = await svc.claimJob();
            expect(job).not.toBeNull();
            await svc.processJob(job);
        }
        expect(done.sort()).toEqual([
            `booking-canceled:1:${CLINIC}`,
            `booking-moved:1:${CLINIC}`,
            `slot-booked:1:${CLINIC}`,
        ]);
        for (const { k } of ks) {
            const j = await prisma.syncJob.findFirst({ where: { dedupKey: k } });
            expect(j!.status).toBe('COMPLETED');
        }
    });
});
