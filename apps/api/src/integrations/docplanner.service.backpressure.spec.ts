/**
 * WP-08B — Backpressure explícito no Request Coordinator Doctoralia.
 *
 * Cobre caps HIGH/LOW, deadlines de espera na fila, rejeições tipadas,
 * isolamento do breaker e do retry, corrida grant × timeout, shutdown limpo,
 * métricas aditivas e o gate de status da integração.
 *
 * Nenhuma chamada real: `fetch` é mockado onde necessário.
 */

import { ConfigService } from '@nestjs/config';
import { DocplannerClient } from './docplanner.service';
import { DoctoraliaCircuitBreaker, DoctoraliaCircuitOpenError } from './doctoralia-circuit-breaker';
import {
    DoctoraliaQueueFullError,
    DoctoraliaQueueTimeoutError,
    isDoctoraliaQueueError,
    isDoctoraliaQueueFullError,
    isDoctoraliaQueueTimeoutError,
} from './doctoralia-queue.errors';
import { classifyFailure, decideRetry } from './docplanner-retry.policy';
import { DoctoraliaMetricsService } from '../metrics/doctoralia-metrics.service';
import { ClinicsService } from '../clinics/clinics.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(status: number, body = '{}'): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (_k: string) => null } as any,
        text: () => Promise.resolve(body),
        json: () => Promise.resolve(JSON.parse(body)),
    } as unknown as Response;
}

const OK = (body = '{"result":"ok"}') => makeResponse(200, body);

function buildClient(clientId = 'test-client-id'): DocplannerClient {
    const cs = { get: jest.fn() } as unknown as ConfigService;
    const client = new DocplannerClient(cs);
    client.setBaseUrl('https://www.doctoralia.com.br');
    client.setAccessToken('initial-token');
    (client as any).clientId = clientId;
    (client as any).clientSecret = 'test-secret';
    jest.spyOn(client as any, 'getToken').mockImplementation(async () => {
        (client as any).accessToken = 'mock-token';
        return 'mock-token';
    });
    return client;
}

const BOOKINGS_PATH = '/api/v3/integration/facilities/1/doctors/2/addresses/3/bookings?start=2026-08-10&end=2026-08-17';

const C = DocplannerClient as any;
const fakeLogger = { warn: jest.fn(), log: jest.fn(), debug: jest.fn(), verbose: jest.fn(), error: jest.fn() } as any;

function resetStatics() {
    C.tokenCache = new Map();
    C.inflightAuth = new Map();
    C.inflightGets = new Map();
    C.rateTimestamps = [];
    C.writeTimestamps = [];
    C.waitingHigh = [];
    C.waitingLow = [];
    C.pumping = false;
    C.consecutiveHighGrants = 0;
    C.lastThrottleLogAt = 0;
    C.lastWriteThrottleLogAt = 0;
    C.lastQueueRejectLogAt = 0;
    C.wakeupFn = null;
    C.shuttingDown = false;
    // restaura defaults (podem ter sido reduzidos em testes de deadline)
    C.QUEUE_CAP_HIGH = 50;
    C.QUEUE_CAP_LOW = 100;
    C.QUEUE_DEADLINE_HIGH_MS = 15_000;
    C.QUEUE_DEADLINE_LOW_MS = 60_000;
    // Task 170: pacing LOW não deve vazar estado entre testes
    C.lastLowGrantAt = 0;
    C.lastPacingLogAt = 0;
    DoctoraliaCircuitBreaker.resetAll();
}

/** Enche a janela agregada para que NENHUM waiter receba grant. */
function fillAggregateWindow() {
    const now = Date.now();
    for (let i = 0; i < 400; i++) C.rateTimestamps.push(now - i);
}

/** Enfileira via acquireRateSlot dentro/fora de runWithPriority. */
function enqueue(priority: boolean, methodClass: 'GET' | 'WRITE' = 'GET'): Promise<void> {
    const call = () => C.acquireRateSlot(fakeLogger, methodClass);
    return priority ? DocplannerClient.runWithPriority(call) : call();
}

const swallow = (p: Promise<any>) => p.catch(() => undefined);

beforeEach(() => {
    resetStatics();
});

afterEach(() => {
    DocplannerClient.shutdownRateQueue();
    resetStatics();
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Caps (testes 1–4, 9)
// ---------------------------------------------------------------------------

describe('WP-08B — caps de fila', () => {
    it('1+2. HIGH aceita até 50 waiters; o 51º rejeita imediatamente com DoctoraliaQueueFullError', async () => {
        fillAggregateWindow();
        const pending: Promise<any>[] = [];
        for (let i = 0; i < 50; i++) pending.push(swallow(enqueue(true)));
        expect(C.waitingHigh.length).toBe(50);

        await expect(enqueue(true)).rejects.toMatchObject({
            name: 'DoctoraliaQueueFullError',
            code: 'DOCTORALIA_QUEUE_FULL',
            priority: 'HIGH',
            queueSize: 50,
        });
        expect(C.waitingHigh.length).toBe(50); // rejeição ANTES do push
        DocplannerClient.shutdownRateQueue();
        await Promise.all(pending);
    });

    it('3+4. LOW aceita até 100 waiters; o 101º rejeita imediatamente', async () => {
        fillAggregateWindow();
        const pending: Promise<any>[] = [];
        for (let i = 0; i < 100; i++) pending.push(swallow(enqueue(false)));
        expect(C.waitingLow.length).toBe(100);

        await expect(enqueue(false)).rejects.toMatchObject({
            code: 'DOCTORALIA_QUEUE_FULL',
            priority: 'LOW',
            queueSize: 100,
        });
        expect(C.waitingLow.length).toBe(100);
        DocplannerClient.shutdownRateQueue();
        await Promise.all(pending);
    });

    it('9. QueueFull não consome rate slot nem budget WRITE', async () => {
        fillAggregateWindow();
        const before = C.rateTimestamps.length;
        C.QUEUE_CAP_LOW = 0;
        await expect(enqueue(false, 'WRITE')).rejects.toBeInstanceOf(DoctoraliaQueueFullError);
        expect(C.rateTimestamps.length).toBe(before);
        expect(C.writeTimestamps.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Deadlines (testes 5–8, 20)
// ---------------------------------------------------------------------------

describe('WP-08B — deadlines de espera na fila', () => {
    it('5+7+8. HIGH expira após o deadline; waiter é removido e não consome slot', async () => {
        fillAggregateWindow();
        C.QUEUE_DEADLINE_HIGH_MS = 30;
        const before = C.rateTimestamps.length;
        const p = enqueue(true);
        expect(C.waitingHigh.length).toBe(1);
        await expect(p).rejects.toMatchObject({
            name: 'DoctoraliaQueueTimeoutError',
            code: 'DOCTORALIA_QUEUE_TIMEOUT',
            priority: 'HIGH',
            deadlineMs: 30,
        });
        expect(C.waitingHigh.length).toBe(0);          // removido
        expect(C.rateTimestamps.length).toBe(before);  // nenhum slot consumido
    });

    it('6. LOW expira após o deadline com erro tipado', async () => {
        fillAggregateWindow();
        C.QUEUE_DEADLINE_LOW_MS = 30;
        await expect(enqueue(false)).rejects.toMatchObject({
            code: 'DOCTORALIA_QUEUE_TIMEOUT',
            priority: 'LOW',
        });
        expect(C.waitingLow.length).toBe(0);
    });

    it('20. waiter expirado nunca é concedido depois que a janela libera', async () => {
        // Janela cheia com timestamps prestes a expirar (~100ms)
        const now = Date.now();
        for (let i = 0; i < 400; i++) C.rateTimestamps.push(now - (5 * 60 * 1000) + 100);
        C.QUEUE_DEADLINE_LOW_MS = 30;
        let resolved = false;
        const p = enqueue(false).then(() => { resolved = true; });
        await expect(p).rejects.toBeInstanceOf(DoctoraliaQueueTimeoutError);
        // Janela agregada libera (~100ms + sleep mínimo do pump 250ms)
        await new Promise(r => setTimeout(r, 500));
        expect(resolved).toBe(false);
        expect(C.waitingLow.length).toBe(0);
        // Nenhum slot ficou consumido por um waiter fantasma
        const cutoff = Date.now() - 5 * 60 * 1000;
        expect(C.rateTimestamps.filter((t: number) => t > cutoff).length).toBe(0);
    }, 10_000);

    it('21. corrida grant × timeout: settled resolve deterministicamente — nunca resolve/rejeita duas vezes', async () => {
        // Deadline 0ms com janela LIVRE: timer e pump disparam praticamente juntos.
        C.QUEUE_DEADLINE_LOW_MS = 0;
        let resolves = 0;
        let rejects = 0;
        for (let i = 0; i < 20; i++) {
            await enqueue(false).then(() => { resolves++; }, () => { rejects++; });
        }
        await new Promise(r => setTimeout(r, 50));
        expect(resolves + rejects).toBe(20); // cada waiter settles exatamente 1 vez
        // Invariante: slots consumidos == grants efetivos (expirado devolve o slot)
        expect(C.rateTimestamps.length).toBe(resolves);
        expect(C.waitingLow.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Isolamento do breaker (testes 10, 11, 14) e do retry (12, 13)
// ---------------------------------------------------------------------------

describe('WP-08B — isolamento do breaker e do retry', () => {
    it('10+11. QueueFull e QueueTimeout NÃO alimentam o breaker (nem abrem, nem incrementam)', () => {
        const b = new DoctoraliaCircuitBreaker('www.doctoralia.com.br');
        for (let i = 0; i < 20; i++) {
            b.recordFailure(new DoctoraliaQueueFullError('LOW', 100), b.beginRequest());
            b.recordFailure(new DoctoraliaQueueTimeoutError('HIGH', 10, 15000, 15000), b.beginRequest());
        }
        expect(b.getState()).toBe('CLOSED');
        expect(b.getConsecutiveFailures()).toBe(0);
    });

    it('probe que morre na fila libera o probeInFlight sem mudar estado', () => {
        const clock = { t: 1_000_000 };
        const b = new DoctoraliaCircuitBreaker('www.doctoralia.com.br', { now: () => clock.t });
        for (let i = 0; i < 5; i++) b.recordFailure({ status: 503 } as any, b.beginRequest());
        expect(b.getState()).toBe('OPEN');
        clock.t += 61_000;
        const gate = b.beginRequest();
        expect(gate.isProbe).toBe(true);
        b.recordFailure(new DoctoraliaQueueTimeoutError('LOW', 5, 60000, 60000), gate);
        expect(b.getState()).toBe('HALF_OPEN'); // não reabriu nem fechou
        // Próxima request volta a atuar como probe (não há deadlock)
        expect(b.beginRequest().isProbe).toBe(true);
    });

    it('12+13. QueueFull e QueueTimeout são NON-RETRYABLE na política WP-07', () => {
        for (const err of [
            new DoctoraliaQueueFullError('LOW', 100),
            new DoctoraliaQueueTimeoutError('HIGH', 10, 15000, 15000),
        ]) {
            expect(classifyFailure(err).transient).toBe(false);
            const d = decideRetry({ error: err, retryEligible: true, attemptsUsed: 1, retryIndex: 0 });
            expect(d.retry).toBe(false);
        }
    });

    it('14. circuito OPEN rejeita ANTES da fila — request bloqueada não vira waiter', async () => {
        const client = buildClient();
        const breaker = DoctoraliaCircuitBreaker.forDomain('www.doctoralia.com.br');
        for (let i = 0; i < 5; i++) breaker.recordFailure({ status: 503 } as any, breaker.beginRequest());
        expect(breaker.getState()).toBe('OPEN');
        const acquireSpy = jest.spyOn(C, 'acquireRateSlot');
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toBeInstanceOf(DoctoraliaCircuitOpenError);
        expect(acquireSpy).not.toHaveBeenCalled();
        expect(C.waitingHigh.length + C.waitingLow.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Integração com dedup WP-05 (testes 15, 16)
// ---------------------------------------------------------------------------

describe('WP-08B — interação com dedup WP-05', () => {
    it('15+16. GETs deduplicados criam UM waiter/UM deadline; todos os awaiters recebem o MESMO QueueTimeout', async () => {
        fillAggregateWindow();
        C.QUEUE_DEADLINE_LOW_MS = 60;
        const client = buildClient();
        global.fetch = jest.fn(); // jamais chamado

        const p1 = (client as any).request('GET', BOOKINGS_PATH);
        await new Promise(r => setImmediate(r));
        const p2 = (client as any).request('GET', BOOKINGS_PATH);
        await new Promise(r => setImmediate(r));

        expect(C.waitingLow.length).toBe(1); // UM único waiter para o voo

        const [r1, r2] = await Promise.allSettled([p1, p2]);
        expect(r1.status).toBe('rejected');
        expect(r2.status).toBe('rejected');
        const e1 = (r1 as PromiseRejectedResult).reason;
        const e2 = (r2 as PromiseRejectedResult).reason;
        expect(isDoctoraliaQueueTimeoutError(e1)).toBe(true);
        expect(e2.message).toBe(e1.message); // mesmo erro compartilhado
        expect(global.fetch).not.toHaveBeenCalled();
        expect((C.inflightGets as Map<string, any>).size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Prioridade / anti-starvation / GET fura WRITE (testes 17–19)
// ---------------------------------------------------------------------------

describe('WP-08B — prioridade e pump preservados', () => {
    it('17. HIGH continua prioritário sobre LOW', async () => {
        // Janela cheia com liberação rápida (~100ms) para enfileirar ambos antes do grant
        const now = Date.now();
        for (let i = 0; i < 400; i++) C.rateTimestamps.push(now - (5 * 60 * 1000) + 150);
        const order: string[] = [];
        const pLow = enqueue(false).then(() => order.push('low'));
        const pHigh = enqueue(true).then(() => order.push('high'));
        await Promise.all([pLow, pHigh]);
        expect(order[0]).toBe('high');
    }, 10_000);

    it('18. anti-starvation 4:1 continua funcionando', async () => {
        const now = Date.now();
        for (let i = 0; i < 400; i++) C.rateTimestamps.push(now - (5 * 60 * 1000) + 150);
        C.consecutiveHighGrants = 4; // já concedeu 4 HIGH seguidos
        const order: string[] = [];
        const pHigh = enqueue(true).then(() => order.push('high'));
        const pLow = enqueue(false).then(() => order.push('low'));
        await Promise.all([pHigh, pLow]);
        expect(order[0]).toBe('low'); // cota anti-inanição cede 1 ao LOW
    }, 10_000);

    it('19. GET continua furando WRITE inelegível (janela WRITE cheia)', async () => {
        const now = Date.now();
        for (let i = 0; i < 40; i++) C.writeTimestamps.push(now - i * 10);
        let writeResolved = false;
        const pWrite = enqueue(false, 'WRITE').then(() => { writeResolved = true; });
        await new Promise(r => setTimeout(r, 30));
        expect(writeResolved).toBe(false);

        const pGet = enqueue(false, 'GET');
        await Promise.race([
            pGet,
            new Promise((_, rej) => setTimeout(() => rej(new Error('GET preso atrás do WRITE')), 500)),
        ]);
        expect(writeResolved).toBe(false); // WRITE segue aguardando budget
        // Encerramento limpo do waiter WRITE pendente
        DocplannerClient.shutdownRateQueue();
        await expect(pWrite).rejects.toBeInstanceOf(DoctoraliaQueueTimeoutError);
    }, 10_000);
});

// ---------------------------------------------------------------------------
// Shutdown (testes 22–24)
// ---------------------------------------------------------------------------

describe('WP-08B — shutdown limpo', () => {
    it('22+23. shutdown cancela timers e rejeita todas as Promises pendentes', async () => {
        fillAggregateWindow();
        const pending = [enqueue(true), enqueue(false), enqueue(false, 'WRITE')];
        expect(C.waitingHigh.length).toBe(1);
        expect(C.waitingLow.length).toBe(2);

        DocplannerClient.shutdownRateQueue();

        for (const p of pending) {
            await expect(p).rejects.toBeInstanceOf(DoctoraliaQueueTimeoutError);
        }
        expect(C.waitingHigh.length).toBe(0);
        expect(C.waitingLow.length).toBe(0);
        expect(C.wakeupFn).toBeNull();
    });

    it('24. nenhum callback roda após shutdown: novos waiters são recusados imediatamente', async () => {
        DocplannerClient.shutdownRateQueue();
        const before = C.rateTimestamps.length;
        await expect(enqueue(false)).rejects.toBeInstanceOf(DoctoraliaQueueTimeoutError);
        await expect(enqueue(true)).rejects.toBeInstanceOf(DoctoraliaQueueTimeoutError);
        expect(C.waitingHigh.length + C.waitingLow.length).toBe(0);
        expect(C.rateTimestamps.length).toBe(before);
    });

    it('lifecycle Nest: DocplannerService.onModuleDestroy encerra o coordinator com o pump dormindo na janela agregada', async () => {
        // Janela agregada cheia por ~5min: o pump entra na espera longa.
        fillAggregateWindow();
        const p = enqueue(false);
        await new Promise(r => setTimeout(r, 20)); // pump chega ao sleep da janela

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DocplannerService } = require('./docplanner.service');
        const service = new DocplannerService({ get: jest.fn() } as any, {} as any);
        service.onModuleDestroy();

        await expect(p).rejects.toBeInstanceOf(DoctoraliaQueueTimeoutError);
        expect(C.shuttingDown).toBe(true);
        expect(C.waitingHigh.length + C.waitingLow.length).toBe(0);
        // O pump acorda via wakeup e encerra sem conceder nada pós-shutdown.
        await new Promise(r => setTimeout(r, 50));
        expect(C.pumping).toBe(false);
        expect(C.wakeupFn).toBeNull();
    });

    it('onModuleDestroy dispara o shutdown do coordinator', async () => {
        fillAggregateWindow();
        const p = enqueue(false);
        const client = buildClient();
        client.onModuleDestroy();
        await expect(p).rejects.toBeInstanceOf(DoctoraliaQueueTimeoutError);
        expect(C.shuttingDown).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Métricas (teste 25)
// ---------------------------------------------------------------------------

describe('WP-08B — métricas aditivas', () => {
    it('25. contadores/gauges incrementam corretamente (rejectedFull, expired, waits, picos)', async () => {
        const metrics = new DoctoraliaMetricsService(); // registra o singleton global

        // Rejeição por fila cheia
        fillAggregateWindow();
        C.QUEUE_CAP_LOW = 1;
        C.QUEUE_DEADLINE_LOW_MS = 40;
        const p1 = enqueue(false);
        await expect(enqueue(false)).rejects.toBeInstanceOf(DoctoraliaQueueFullError);
        // Expiração por deadline
        await expect(p1).rejects.toBeInstanceOf(DoctoraliaQueueTimeoutError);

        // Grant com espera (janela livre)
        C.rateTimestamps = [];
        await enqueue(true);

        const s = metrics.getQueueBackpressureStats();
        expect(s.queueLowRejectedFull).toBe(1);
        expect(s.queueLowExpired).toBe(1);
        expect(s.queueHighRejectedFull).toBe(0);
        expect(s.peakLow).toBeGreaterThanOrEqual(1);
        expect(s.waitHigh.grantedCount).toBe(1);
        expect(s.waitHigh.avgWaitMs).toBeGreaterThanOrEqual(0);
        expect(s.waitHigh.p95WaitMs).toBeGreaterThanOrEqual(0);
        expect(s.queueHighCurrent).toBe(0);
        expect(s.queueLowCurrent).toBe(0);

        // reset() limpa tudo
        metrics.reset();
        const z = metrics.getQueueBackpressureStats();
        expect(z.queueLowRejectedFull).toBe(0);
        expect(z.queueLowExpired).toBe(0);
        expect(z.peakLow).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Gate de status da integração (teste 26)
// ---------------------------------------------------------------------------

describe('WP-08B — erros de fila nunca alteram o status da integração', () => {
    function makeService(conn: any, err: any) {
        const prisma: any = {
            integrationConnection: {
                findFirst: jest.fn().mockResolvedValue(conn),
                update: jest.fn().mockResolvedValue(conn),
            },
        };
        const docplanner: any = {
            createClient: jest.fn().mockReturnValue({
                getFacilities: jest.fn().mockRejectedValue(err),
            }),
        };
        const vismed: any = {};
        return { service: new ClinicsService(prisma, docplanner, vismed), prisma };
    }

    it('26. QueueFull/QueueTimeout no teste de conexão não gravam status error/disconnected', async () => {
        for (const err of [
            new DoctoraliaQueueFullError('HIGH', 50),
            new DoctoraliaQueueTimeoutError('HIGH', 10, 15000, 15000),
        ]) {
            for (const status of ['connected', 'error', 'disconnected']) {
                const { service, prisma } = makeService(
                    { id: 'c1', clinicId: 'cl1', status, clientId: 'id', clientSecret: 's', domain: null },
                    err,
                );
                const res = await service.testIntegration('cl1');
                expect(res.success).toBe(false);
                const data = prisma.integrationConnection.update.mock.calls[0][0].data;
                expect(data.status).toBeUndefined(); // nunca rebaixa por backpressure
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Type-guards
// ---------------------------------------------------------------------------

describe('WP-08B — type-guards distinguem os erros', () => {
    it('guards reconhecem os erros de fila e rejeitam os demais', () => {
        const full = new DoctoraliaQueueFullError('LOW', 100);
        const timeout = new DoctoraliaQueueTimeoutError('HIGH', 5, 15000, 15000);
        const circuit = new DoctoraliaCircuitOpenError('www.doctoralia.com.br', 'x', 1000);
        const http = Object.assign(new Error('Docplanner API Error: 503'), { status: 503 });
        const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });

        expect(isDoctoraliaQueueFullError(full)).toBe(true);
        expect(isDoctoraliaQueueTimeoutError(timeout)).toBe(true);
        expect(isDoctoraliaQueueError(full)).toBe(true);
        expect(isDoctoraliaQueueError(timeout)).toBe(true);
        for (const other of [circuit, http, abort, new Error('negócio'), null, undefined]) {
            expect(isDoctoraliaQueueError(other)).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// Fluxo fim-a-fim: erro de fila propaga sem HTTP e sem retry (integração)
// ---------------------------------------------------------------------------

describe('WP-08B — fluxo completo com fila saturada', () => {
    it('request() propaga QueueFull sem fetch, sem retry e com breaker intacto', async () => {
        fillAggregateWindow();
        C.QUEUE_CAP_LOW = 0;
        const client = buildClient();
        const fetchMock = jest.fn();
        global.fetch = fetchMock;

        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toBeInstanceOf(DoctoraliaQueueFullError);
        expect(fetchMock).not.toHaveBeenCalled();

        const breaker = DoctoraliaCircuitBreaker.forDomain('www.doctoralia.com.br');
        expect(breaker.getState()).toBe('CLOSED');
        expect(breaker.getConsecutiveFailures()).toBe(0);
        expect((C.inflightGets as Map<string, any>).size).toBe(0);
    });
});
