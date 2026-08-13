/**
 * Task 155 (WP-12C, correção mínima) — Headroom ε no refill do limiter.
 *
 * Com a janela cheia, o próximo grant só pode ocorrer após `janela + ε`
 * (ε = 300ms, REFILL_HEADROOM_MS) desde o evento mais antigo — e não
 * exatamente na fronteira da janela, onde o jitter de transporte (máx medido
 * 44ms no WP-12C) comprimia as chegadas para dentro de uma janela real <60s.
 *
 * acquireRateSlot/pump NÃO são mockados — os testes exercem o pump real,
 * como na suíte write-budget.
 */

import { ConfigService } from '@nestjs/config';
import { DocplannerClient } from './docplanner.service';
import { DoctoraliaCircuitBreaker } from './doctoralia-circuit-breaker';

function makeResponse(status: number, body = '{}'): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (_k: string) => null } as any,
        text: () => Promise.resolve(body),
        json: () => Promise.resolve(JSON.parse(body)),
    } as unknown as Response;
}

const OK = () => makeResponse(200, '{"result":"ok"}');

function buildClient(): DocplannerClient {
    const cs = { get: jest.fn() } as unknown as ConfigService;
    const client = new DocplannerClient(cs);
    client.setBaseUrl('https://www.doctoralia.com.br');
    client.setAccessToken('initial-token');
    (client as any).clientId = 'test-client-id';
    (client as any).clientSecret = 'test-secret';
    jest.spyOn(client as any, 'getToken').mockImplementation(async () => {
        (client as any).accessToken = 'mock-token';
        return 'mock-token';
    });
    return client;
}

/** Envelhece os timestamps existentes (equivalente a avançar o relógio). */
function advanceFakeTime(ms: number) {
    const shift = (arr: number[]) => {
        for (let i = 0; i < arr.length; i++) arr[i] -= ms;
    };
    shift((DocplannerClient as any).rateTimestamps);
    shift((DocplannerClient as any).writeTimestamps);
}

function resetStatics() {
    (DocplannerClient as any).tokenCache = new Map();
    (DocplannerClient as any).inflightAuth = new Map();
    (DocplannerClient as any).inflightGets = new Map();
    (DocplannerClient as any).rateTimestamps = [];
    (DocplannerClient as any).writeTimestamps = [];
    (DocplannerClient as any).waitingHigh = [];
    (DocplannerClient as any).waitingLow = [];
    (DocplannerClient as any).pumping = false;
    (DocplannerClient as any).consecutiveHighGrants = 0;
    (DocplannerClient as any).lastThrottleLogAt = 0;
    (DocplannerClient as any).lastWriteThrottleLogAt = 0;
    (DocplannerClient as any).wakeupFn = null;
    DoctoraliaCircuitBreaker.resetAll();
}

const EPS = (DocplannerClient as any).REFILL_HEADROOM_MS as number;
const SLOTS_PATH = '/api/v3/integration/facilities/1/doctors/2/addresses/3/slots';
const BOOKINGS_PATH = '/api/v3/integration/facilities/1/doctors/2/addresses/3/bookings?start=2026-08-10&end=2026-08-17';

beforeEach(() => resetStatics());
afterEach(() => jest.restoreAllMocks());

describe('DocplannerClient — headroom ε no refill (Task 155)', () => {

    it('ε está no intervalo recomendado (250–500ms) e acima do jitter máx medido (44ms)', () => {
        expect(EPS).toBeGreaterThanOrEqual(250);
        expect(EPS).toBeLessThanOrEqual(500);
        expect(EPS).toBeGreaterThan(44);
    });

    it('janela WRITE/min cheia: NENHUM grant antes de janela+ε do evento mais antigo', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(OK());

        // 40 writes cujo mais antigo já passou da fronteira ESTRITA (60s) mas
        // ainda está DENTRO do headroom ε: sem a correção, o grant sairia já.
        const now = Date.now();
        const wts: number[] = (DocplannerClient as any).writeTimestamps;
        for (let i = 0; i < 40; i++) {
            wts.push(now - 60_000 - Math.floor(EPS / 3) + i); // idade ≈ 60s+ε/3
        }
        wts.sort((a, b) => a - b);

        let resolved = false;
        const putPromise = (client as any).request('PUT', SLOTS_PATH, { slots: [] })
            .then(() => { resolved = true; });

        // Dentro do headroom: ainda bloqueado
        await new Promise(r => setTimeout(r, 50));
        expect(resolved).toBe(false);

        // O pump libera sozinho após janela+ε (espera natural, sem wakeup manual)
        const t0 = Date.now();
        await putPromise;
        expect(resolved).toBe(true);
        // Deve ter esperado pelo menos o restante do ε (≈2ε/3 - 50ms já passados)
        expect(Date.now() - t0).toBeLessThan(2_000); // e liberou logo depois
    }, 10_000);

    it('janela agregada/5min cheia: eviction só após janela+ε (GET também respeita ε)', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(OK());

        // 400 entradas agregadas cujo mais antigo está entre janela e janela+ε
        const now = Date.now();
        const rts: number[] = (DocplannerClient as any).rateTimestamps;
        for (let i = 0; i < 400; i++) {
            rts.push(now - 300_000 - Math.floor(EPS / 3) + i);
        }
        rts.sort((a, b) => a - b);

        let resolved = false;
        const getPromise = (client as any).request('GET', BOOKINGS_PATH)
            .then(() => { resolved = true; });

        await new Promise(r => setTimeout(r, 50));
        expect(resolved).toBe(false); // dentro do headroom: segurado

        await getPromise; // liberado naturalmente após janela+ε
        expect(resolved).toBe(true);
    }, 10_000);

    it('fora da fronteira: grants continuam ocorrendo normalmente (sem espera)', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(OK());

        const t0 = Date.now();
        await (client as any).request('GET', BOOKINGS_PATH);
        await (client as any).request('PUT', SLOTS_PATH, { slots: [] });
        expect(Date.now() - t0).toBeLessThan(500);
    });

    it('override do ε é clampado ao intervalo seguro [250,500]ms — 0/negativo/inválido nunca desabilita a proteção', () => {
        const resolve = (DocplannerClient as any).resolveRefillHeadroom.bind(DocplannerClient);
        expect(resolve(undefined)).toBe(300); // default
        expect(resolve('')).toBe(300);
        expect(resolve('abc')).toBe(300);
        expect(resolve('0')).toBe(250);      // nunca zera o headroom
        expect(resolve('-100')).toBe(250);
        expect(resolve('50')).toBe(250);     // abaixo do mínimo seguro
        expect(resolve('400')).toBe(400);    // dentro do intervalo: respeitado
        expect(resolve('10000')).toBe(500);  // acima do máximo recomendado
    });

    it('deadline da fila LOW acomoda o refill com ε: um WRITE nunca expira antes de janela+ε', () => {
        const deadlineLow = (DocplannerClient as any).QUEUE_DEADLINE_LOW_MS as number;
        const windowMin = (DocplannerClient as any).WRITE_WINDOW_MIN_MS as number;
        // Margem estritamente positiva além de janela+ε (scheduling do event loop)
        expect(deadlineLow).toBeGreaterThan(windowMin + EPS);
    });

    it('41º WRITE LOW com janela cheia: grant ocorre após janela+ε e ANTES do deadline LOW (sem QueueTimeout)', async () => {
        // Determinístico via envelhecimento: 40 writes cujo mais antigo tem idade
        // (60s - 200ms) — o 41º WRITE só pode ser liberado dali a 200ms + ε.
        // Se o deadline LOW fosse exatamente 60s, este cenário (proporcional ao
        // caso real de espera de 60.3s) rejeitaria o write em vez de enviá-lo.
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(OK());

        const now = Date.now();
        const wts: number[] = (DocplannerClient as any).writeTimestamps;
        for (let i = 0; i < 40; i++) wts.push(now - 59_800 + i); // mais antigo: idade 59.8s
        wts.sort((a, b) => a - b);

        const t0 = Date.now();
        // Fila LOW (sem runWithPriority). Deve RESOLVER (não QueueTimeout).
        await (client as any).request('PUT', SLOTS_PATH, { slots: [] });
        const elapsed = Date.now() - t0;
        // Só depois do restante da janela (~200ms) + ε — nunca antes do headroom
        expect(elapsed).toBeGreaterThanOrEqual(200 + EPS - 50); // tolerância de timing
        expect(elapsed).toBeLessThan((DocplannerClient as any).QUEUE_DEADLINE_LOW_MS);
    }, 15_000);

    it('evento mais velho que janela+ε é evictado e libera o grant imediatamente', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(OK());

        const now = Date.now();
        const wts: number[] = (DocplannerClient as any).writeTimestamps;
        for (let i = 0; i < 40; i++) wts.push(now - i * 10); // janela cheia

        advanceFakeTime(60_000 + EPS + 50); // todos além de janela+ε

        const t0 = Date.now();
        await (client as any).request('PUT', SLOTS_PATH, { slots: [] });
        expect(Date.now() - t0).toBeLessThan(500);
    });
});
