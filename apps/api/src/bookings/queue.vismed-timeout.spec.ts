/**
 * Integração fila × timeout VisMed: um handler que estoura
 * VismedTimeoutError deve levar o job ao fluxo normal de failJob
 * (FAILED com backoff/nextRunAt, DEAD após maxAttempts) — sem job
 * RUNNING eterno e sem dedupKey bloqueada para sempre.
 *
 * Testes contra banco REAL, mesmo padrão de queue.service.dedup-lease.spec.ts.
 */
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from './queue.service';
import { VismedTimeoutError } from '../integrations/vismed/vismed.service';

jest.setTimeout(60000);

const prisma = new PrismaService();
const svc: any = new QueueService(prisma as any);

const CLINIC = 'test-clinic-vismed-timeout';
const key = (s: string) => `vtimeout:${s}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

async function cleanup() {
    await prisma.syncJob.deleteMany({ where: { clinicId: CLINIC } });
}

beforeAll(async () => {
    await prisma.$connect();
    await cleanup();
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe('fila × VismedTimeoutError', () => {
    it('handler que estoura timeout → FAILED com backoff (nextRunAt futuro), dedupKey preservado', async () => {
        const k = key('failed');
        svc.registerHandler('vtimeout-fail', async () => {
            throw new VismedTimeoutError('https://app.vissmed.com.br/x', 30000);
        });
        await svc.enqueue(CLINIC, 'vtimeout-fail', {}, { dedupKey: k, maxAttempts: 5, priority: 9999 });
        const job = await svc.claimJob();
        expect(job).not.toBeNull();
        await svc.processJob(job);

        const after = await prisma.syncJob.findFirst({ where: { dedupKey: k } });
        expect(after!.status).toBe('FAILED');
        expect(after!.lastError).toMatch(/VisMed HTTP timeout/);
        expect(after!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
        expect(after!.dedupKey).toBe(k);
        // FAILED em retry continua bloqueando a chave (não fica órfã nem duplicada)
        const dup = await svc.enqueue(CLINIC, 'vtimeout-fail', {}, { dedupKey: k });
        expect(dup.id).toBe(after!.id);
    });

    it('timeout na última tentativa → DEAD (chave liberada)', async () => {
        const k = key('dead');
        svc.registerHandler('vtimeout-dead', async () => {
            throw new VismedTimeoutError('https://app.vissmed.com.br/x', 60000);
        });
        const job = await svc.enqueue(CLINIC, 'vtimeout-dead', {}, { dedupKey: k, maxAttempts: 1, priority: 9999 });
        const claimed = await svc.claimJob();
        expect(claimed.id).toBe(job.id);
        await svc.processJob(claimed);

        const after = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(after!.status).toBe('DEAD');
        // chave liberada para novo job
        const novo = await svc.enqueue(CLINIC, 'vtimeout-dead', {}, { dedupKey: k });
        expect(novo.id).not.toBe(job.id);
    });
});
