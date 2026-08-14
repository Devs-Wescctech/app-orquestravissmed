/**
 * Task 170 — Pacing de grants LOW no Request Coordinator (elimina a zona morta).
 *
 * Cobre: ativação por threshold de ocupação (25%), espaçamento a 1/750ms,
 * HIGH nunca paced (fura a espera via wakeup), anti-starvation 4:1 preservada,
 * budgets WRITE e ε intactos, semântica de QueueFull/QueueTimeout inalterada,
 * drenagem contínua da fila LOW e clamps/defaults de env.
 *
 * acquireRateSlot/pump NÃO são mockados — os testes exercem o pump real.
 * Para não esperar 750ms reais em todo teste, o intervalo é reduzido via
 * override do static (mesmo padrão de QUEUE_DEADLINE_* na suíte WP-08B).
 */

import { DocplannerClient } from './docplanner.service';
import { DoctoraliaCircuitBreaker } from './doctoralia-circuit-breaker';
import { DoctoraliaQueueFullError, DoctoraliaQueueTimeoutError } from './doctoralia-queue.errors';
import { DoctoraliaMetricsService } from '../metrics/doctoralia-metrics.service';

const C = DocplannerClient as any;
const fakeLogger = { warn: jest.fn(), log: jest.fn(), debug: jest.fn(), verbose: jest.fn(), error: jest.fn() } as any;

const DEFAULT_THRESHOLD = 0.25;
const DEFAULT_INTERVAL = 750;

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
    C.QUEUE_CAP_HIGH = 50;
    C.QUEUE_CAP_LOW = 100;
    C.QUEUE_DEADLINE_HIGH_MS = 15_000;
    C.QUEUE_DEADLINE_LOW_MS = 60_000 + C.REFILL_HEADROOM_MS + 700;
    // Task 170
    C.LOW_PACING_THRESHOLD = DEFAULT_THRESHOLD;
    C.LOW_PACING_INTERVAL_MS = DEFAULT_INTERVAL;
    C.lastLowGrantAt = 0;
    C.lastPacingLogAt = 0;
    DoctoraliaCircuitBreaker.resetAll();
}

/** Preenche a janela agregada a uma dada ocupação (fração) com entradas recentes. */
function fillAggregate(fraction: number) {
    const now = Date.now();
    const n = Math.round(400 * fraction);
    for (let i = 0; i < n; i++) C.rateTimestamps.push(now - 1000 - i);
    C.rateTimestamps.sort((a: number, b: number) => a - b);
}

function enqueue(priority: boolean, methodClass: 'GET' | 'WRITE' = 'GET'): Promise<any> {
    const call = () => C.acquireRateSlot(fakeLogger, methodClass);
    return priority ? DocplannerClient.runWithPriority(call) : call();
}

beforeEach(() => resetStatics());

afterEach(() => {
    DocplannerClient.shutdownRateQueue();
    resetStatics();
    jest.restoreAllMocks();
});

describe('Task 170 — pacing de grants LOW', () => {

    it('defaults e clamps de env: threshold 25% e intervalo 750ms; valores inválidos nunca desabilitam', () => {
        const th = C.resolveLowPacingThreshold.bind(C);
        expect(th(undefined)).toBe(0.25);
        expect(th('')).toBe(0.25);
        expect(th('abc')).toBe(0.25);
        expect(th('0.25')).toBe(0.25);
        expect(th('25')).toBe(0.25);      // percentual aceito
        expect(th('0')).toBe(0.05);       // clamp inferior (nunca pacing permanente em janela vazia)
        expect(th('-1')).toBe(0.05);
        expect(th('0.5')).toBe(0.5);
        expect(th('50')).toBe(0.5);
        expect(th('99')).toBe(0.95);      // clamp superior (<1: pacing sempre pode ativar)
        expect(th('200')).toBe(0.95);

        const iv = C.resolveLowPacingInterval.bind(C);
        expect(iv(undefined)).toBe(750);
        expect(iv('')).toBe(750);
        expect(iv('abc')).toBe(750);
        expect(iv('750')).toBe(750);
        expect(iv('0')).toBe(250);        // clamp inferior
        expect(iv('-5')).toBe(250);
        expect(iv('1000')).toBe(1000);
        expect(iv('60000')).toBe(5000);   // clamp superior (vazão nunca cai abaixo de ~60/5min)
    });

    it('abaixo do threshold: rajada LOW permitida (comportamento idêntico ao atual)', async () => {
        // Ocupação parte de 0 e chega a 20/400 = 5% < 25%: nenhum pacing.
        const t0 = Date.now();
        for (let i = 0; i < 20; i++) await enqueue(false);
        expect(Date.now() - t0).toBeLessThan(500); // 20 grants imediatos
        expect(C.rateTimestamps.length).toBe(20);
    });

    it('acima do threshold: grants LOW são espaçados em ~LOW_PACING_INTERVAL_MS (vazão ≈ teto sustentável)', async () => {
        C.LOW_PACING_INTERVAL_MS = 120; // intervalo curto p/ teste rápido; mesma lógica
        fillAggregate(0.5); // 200/400 = 50% ≥ 25%
        C.lastLowGrantAt = Date.now(); // último grant LOW "acabou de acontecer"

        const grants: number[] = [];
        const t0 = Date.now();
        for (let i = 0; i < 3; i++) {
            await enqueue(false);
            grants.push(Date.now() - t0);
        }
        // Cada grant espaçado ~120ms do anterior: 1º ≥ ~120, 2º ≥ ~240, 3º ≥ ~360
        expect(grants[0]).toBeGreaterThanOrEqual(100);
        expect(grants[1]).toBeGreaterThanOrEqual(220);
        expect(grants[2]).toBeGreaterThanOrEqual(340);
        // E não muito mais (sem espera parasita): 3 grants em <1,5s
        expect(grants[2]).toBeLessThan(1500);
        expect(C.rateTimestamps.length).toBe(200 + 3);
    }, 10_000);

    it('exatamente NO threshold (25%): pacing ativa (limite inclusivo)', async () => {
        C.LOW_PACING_INTERVAL_MS = 150;
        fillAggregate(0.25); // 100/400 = 25%
        C.lastLowGrantAt = Date.now();
        const t0 = Date.now();
        await enqueue(false);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(130);
    });

    it('HIGH nunca é paced: com ocupação alta, HIGH recebe grant imediato', async () => {
        fillAggregate(0.9); // 360/400 = 90%
        C.lastLowGrantAt = Date.now(); // pacing "carregado" p/ LOW
        const t0 = Date.now();
        await enqueue(true); // HIGH
        expect(Date.now() - t0).toBeLessThan(300); // sem esperar os 750ms do pacing
    });

    it('HIGH que chega DURANTE a espera de pacing fura a fila via wakeup e é atendido imediatamente', async () => {
        C.LOW_PACING_INTERVAL_MS = 2_000; // espera longa p/ evidenciar o furo
        fillAggregate(0.5);
        C.lastLowGrantAt = Date.now();

        const order: string[] = [];
        const pLow = enqueue(false).then(() => order.push('low'));
        await new Promise(r => setTimeout(r, 50)); // pump entra na espera de pacing

        const tHigh0 = Date.now();
        await enqueue(true).then(() => order.push('high'));
        const highElapsed = Date.now() - tHigh0;

        expect(order[0]).toBe('high');
        expect(highElapsed).toBeLessThan(500); // muito antes dos 2s do pacing
        await pLow; // LOW ainda recebe o grant depois (espera restante)
        expect(order).toEqual(['high', 'low']);
    }, 10_000);

    it('anti-starvation 4:1 preservada: o LOW cedido com HIGH presente NÃO é paced', async () => {
        // Janela cheia com 200 entradas prestes a expirar (~150ms) + 200 recentes:
        // ambos os waiters enfileiram ANTES do 1º grant; após a eviction a
        // ocupação fica em 200/400 = 50% (pacing ativo por ocupação).
        const now = Date.now();
        for (let i = 0; i < 200; i++) C.rateTimestamps.push(now - (5 * 60 * 1000) + 150 + i);
        for (let i = 0; i < 200; i++) C.rateTimestamps.push(now - 1000 - i);
        C.rateTimestamps.sort((a: number, b: number) => a - b);
        C.lastLowGrantAt = Date.now();
        C.consecutiveHighGrants = 4; // cota: próximo grant cede ao LOW

        const order: string[] = [];
        const pHigh = enqueue(true).then(() => order.push('high'));
        const pLow = enqueue(false).then(() => order.push('low'));
        await Promise.all([pHigh, pLow]);
        const elapsed = Date.now() - now;
        expect(order[0]).toBe('low'); // cota anti-inanição mantida, sem pacing (HIGH presente)
        expect(elapsed).toBeLessThan(2000); // janela liberou (~450ms) e grants saíram sem os 750ms de pacing
    }, 10_000);

    it('budgets WRITE e ε intactos: WRITE LOW paced ainda respeita 40/min e registra nas duas janelas', async () => {
        C.LOW_PACING_INTERVAL_MS = 100;
        fillAggregate(0.5);
        C.lastLowGrantAt = Date.now();

        // Budget WRITE/min cheio: nem o pacing nem a ocupação liberam o WRITE
        const now = Date.now();
        for (let i = 0; i < 40; i++) C.writeTimestamps.push(now - i * 10);
        let writeResolved = false;
        const pWrite = enqueue(false, 'WRITE').then(() => { writeResolved = true; });
        await new Promise(r => setTimeout(r, 300));
        expect(writeResolved).toBe(false); // WRITE segue aguardando budget (pacing não fura budget)

        // GET LOW paced ainda flui (fura WRITE inelegível, com espaçamento)
        await enqueue(false, 'GET');
        expect(writeResolved).toBe(false);

        DocplannerClient.shutdownRateQueue();
        await expect(pWrite).rejects.toBeInstanceOf(DoctoraliaQueueTimeoutError);
    }, 10_000);

    it('QueueFull mantém semântica: cap LOW rejeita antes do push mesmo com pacing ativo', async () => {
        fillAggregate(0.5);
        C.lastLowGrantAt = Date.now();
        C.QUEUE_CAP_LOW = 0;
        const before = C.rateTimestamps.length;
        await expect(enqueue(false)).rejects.toBeInstanceOf(DoctoraliaQueueFullError);
        expect(C.rateTimestamps.length).toBe(before);
    });

    it('QueueTimeout mantém semântica: waiter LOW que expira durante a espera de pacing não consome slot', async () => {
        C.LOW_PACING_INTERVAL_MS = 5_000; // pacing maior que o deadline reduzido
        C.QUEUE_DEADLINE_LOW_MS = 60;
        fillAggregate(0.5);
        C.lastLowGrantAt = Date.now();
        const before = C.rateTimestamps.length;
        await expect(enqueue(false)).rejects.toBeInstanceOf(DoctoraliaQueueTimeoutError);
        expect(C.rateTimestamps.length).toBe(before); // nenhum slot consumido
        expect(C.waitingLow.length).toBe(0);
    }, 10_000);

    it('fila LOW drena continuamente sem crescer (nenhum ciclo crescente sob pacing)', async () => {
        C.LOW_PACING_INTERVAL_MS = 60;
        fillAggregate(0.5);
        C.lastLowGrantAt = Date.now();

        const done: Promise<any>[] = [];
        for (let i = 0; i < 6; i++) done.push(enqueue(false));
        expect(C.waitingLow.length).toBeGreaterThan(0);
        await Promise.all(done);
        expect(C.waitingLow.length).toBe(0); // drenou tudo
        expect(C.rateTimestamps.length).toBe(200 + 6);
    }, 10_000);

    it('telemetria: recordLowPacingWait alimenta lowPacing no baseline e reset() zera', async () => {
        const metrics = new DoctoraliaMetricsService(); // registra o singleton global
        C.LOW_PACING_INTERVAL_MS = 100;
        fillAggregate(0.5);
        C.lastLowGrantAt = Date.now();
        await enqueue(false);

        const s = metrics.getLowPacingStats();
        expect(s.waitCount).toBeGreaterThanOrEqual(1);
        expect(s.maxWaitMs).toBeGreaterThan(0);
        expect(s.lastOccupancyPct).toBe(50);
        expect(s.lastAppliedAt).not.toBeNull();

        const baseline = metrics.getBaseline();
        expect(baseline.queue.lowPacing.waitCount).toBe(s.waitCount);

        metrics.reset();
        const z = metrics.getLowPacingStats();
        expect(z.waitCount).toBe(0);
        expect(z.maxWaitMs).toBe(0);
        expect(z.lastAppliedAt).toBeNull();
    });

    it('retry readquire slot normalmente: segundo acquire LOW também é paced (nenhum bypass)', async () => {
        C.LOW_PACING_INTERVAL_MS = 120;
        fillAggregate(0.5);
        C.lastLowGrantAt = Date.now();
        // "Tentativa 1"
        const t0 = Date.now();
        await enqueue(false);
        const first = Date.now() - t0;
        // "Retry" (nova aquisição, como no loop WP-07): também espaçado
        const t1 = Date.now();
        await enqueue(false);
        const second = Date.now() - t1;
        expect(first).toBeGreaterThanOrEqual(100);
        expect(second).toBeGreaterThanOrEqual(100);
    }, 10_000);
});
