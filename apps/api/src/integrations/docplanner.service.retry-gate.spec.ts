/**
 * Task 162 — Gate NÃO-ADMISSIONAL de retry WP-07 após breaker OPEN.
 *
 * Retry pendente de operação admitida ANTES do OPEN não dispara novo HTTP
 * quando o breaker está OPEN/HALF_OPEN; falha imediata com
 * DoctoraliaCircuitOpenError, sem consumir slot/budget, sem alimentar o
 * breaker e sem virar probe. Requests em voo NÃO são abortadas.
 *
 * Nenhuma chamada real: `fetch`, `sleep` e `acquireRateSlot` são mockados.
 */

import { ConfigService } from '@nestjs/config';
import { DocplannerClient } from './docplanner.service';
import {
    DoctoraliaCircuitBreaker,
    DoctoraliaCircuitOpenError,
} from './doctoralia-circuit-breaker';

function makeResponse(status: number, body = '{}', headers: Record<string, string> = {}): Response {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => lower[k.toLowerCase()] ?? null } as any,
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

function transientError(status = 503): Error {
    const err = new Error(`Docplanner API Error: ${status} oops`);
    (err as any).status = status;
    return err;
}

const BOOKINGS_PATH = '/api/v3/integration/facilities/1/doctors/2/addresses/3/bookings?start=2026-08-10&end=2026-08-17';

const breakerFor = () => DoctoraliaCircuitBreaker.forDomain('www.doctoralia.com.br');
function forceOpen(b: DoctoraliaCircuitBreaker) {
    for (let i = 0; i < 5; i++) b.recordFailure(transientError(503), { isProbe: false });
    expect(b.getState()).toBe('OPEN');
}

let acquireSpy: jest.SpyInstance;
let sleepSpy: jest.SpyInstance;

beforeEach(() => {
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
    DoctoraliaCircuitBreaker.resetAll();
    acquireSpy = jest.spyOn(DocplannerClient as any, 'acquireRateSlot').mockResolvedValue(undefined);
    sleepSpy = jest.spyOn(DocplannerClient as any, 'sleep').mockResolvedValue(undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
    DoctoraliaCircuitBreaker.resetAll();
});

describe('Task 162 — assertRetryAllowed (unit)', () => {
    it('CLOSED permite; OPEN e HALF_OPEN bloqueiam sem transicionar estado nem virar probe', () => {
        const clock = { t: 1_000_000 };
        const b = new DoctoraliaCircuitBreaker('www.doctoralia.com.br', { now: () => clock.t });
        expect(() => b.assertRetryAllowed()).not.toThrow();

        forceOpen(b);
        const snapBefore = b.snapshot();
        expect(() => b.assertRetryAllowed()).toThrow(DoctoraliaCircuitOpenError);
        expect(b.getState()).toBe('OPEN');
        expect(b.snapshot().probesExecuted).toBe(snapBefore.probesExecuted); // não virou probe
        expect(b.snapshot().retriesBlocked).toBe(1);

        // OPEN com cooldown EXPIRADO: retry antigo continua bloqueado e NÃO
        // converte OPEN→HALF_OPEN (probe autorizada vem só de beginRequest).
        clock.t += 10 * 60_000;
        expect(() => b.assertRetryAllowed()).toThrow(DoctoraliaCircuitOpenError);
        expect(b.getState()).toBe('OPEN');

        // HALF_OPEN (via admissão normal): retry antigo segue bloqueado.
        const gate = b.beginRequest();
        expect(gate.isProbe).toBe(true);
        expect(b.getState()).toBe('HALF_OPEN');
        const probesAfterAdmission = b.snapshot().probesExecuted;
        expect(() => b.assertRetryAllowed()).toThrow(DoctoraliaCircuitOpenError);
        expect(b.getState()).toBe('HALF_OPEN');
        expect(b.snapshot().probesExecuted).toBe(probesAfterAdmission);
    });

    it('(d) DoctoraliaCircuitOpenError NUNCA alimenta o breaker via recordFailure', () => {
        const b = new DoctoraliaCircuitBreaker('www.doctoralia.com.br');
        const err = new DoctoraliaCircuitOpenError('www.doctoralia.com.br', 'retry bloqueado', 1000);
        for (let i = 0; i < 10; i++) b.recordFailure(err, { isProbe: false });
        expect(b.getState()).toBe('CLOSED');
        expect(b.getConsecutiveFailures()).toBe(0);
        // Se era a probe: apenas libera probeInFlight, sem fechar nem reabrir.
        forceOpen(b);
        (b as any).openedUntil = Date.now() - 1;
        const gate = b.beginRequest();
        expect(gate.isProbe).toBe(true);
        b.recordFailure(err, gate);
        expect(b.getState()).toBe('HALF_OPEN');
        expect(b.beginRequest().isProbe).toBe(true); // sem deadlock de probe
    });
});

describe('Task 162 — gate no loop de retry WP-07 (integração, fetch mockado)', () => {
    it('(a)+(c) operação admitida em CLOSED, 1ª tentativa falha e breaker abre → retry NÃO envia 2º HTTP nem consome slot/budget', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(makeResponse(503, 'down')) as any;
        // O breaker abre DURANTE o backoff (entre a 1ª tentativa e o retry).
        sleepSpy.mockImplementation(async () => forceOpen(breakerFor()));

        acquireSpy.mockClear();
        const p = (client as any).request('GET', BOOKINGS_PATH);
        await expect(p).rejects.toBeInstanceOf(DoctoraliaCircuitOpenError);

        expect((global.fetch as jest.Mock).mock.calls.length).toBe(1); // só a 1ª tentativa
        expect(acquireSpy).toHaveBeenCalledTimes(1);                   // retry bloqueado não consumiu slot
        expect((DocplannerClient as any).writeTimestamps.length).toBe(0);
        expect((DocplannerClient as any).waitingHigh.length + (DocplannerClient as any).waitingLow.length).toBe(0);
    });

    it('(d) retry bloqueado NÃO alimenta o breaker (consecutiveFailures inalterado, estado OPEN mantido)', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(makeResponse(503, 'down')) as any;
        sleepSpy.mockImplementation(async () => forceOpen(breakerFor()));
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toBeInstanceOf(DoctoraliaCircuitOpenError);
        const b = breakerFor();
        expect(b.getState()).toBe('OPEN');
        expect(b.getConsecutiveFailures()).toBe(0); // open() zera; o retry bloqueado não incrementou
        expect(b.snapshot().retriesBlocked).toBe(1);
    });

    it('(b) request já em voo antes do OPEN NÃO é abortada — completa normalmente', async () => {
        const client = buildClient();
        let release!: (v: Response) => void;
        global.fetch = jest.fn().mockImplementation(() => new Promise<Response>(r => { release = r; })) as any;

        const p = (client as any).request('GET', BOOKINGS_PATH);
        await new Promise(r => setImmediate(r)); // fetch em voo
        forceOpen(breakerFor());                 // breaker abre com HTTP em voo
        release(OK());                           // resposta chega DEPOIS do OPEN
        await expect(p).resolves.toEqual({ result: 'ok' });
        expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
    });

    it('(e) retry antigo nunca vira probe em HALF_OPEN; probe autorizada mantém seus retries', async () => {
        const client = buildClient();
        const b = breakerFor();
        forceOpen(b);
        (b as any).openedUntil = Date.now() - 1; // cooldown expirado

        // Probe autorizada (beginRequest → isProbe): 1ª tentativa 503, retry PERMITIDO
        // (isenta do gate), 2ª tentativa 200 → circuito fecha.
        global.fetch = jest.fn()
            .mockResolvedValueOnce(makeResponse(503, 'down'))
            .mockResolvedValue(OK()) as any;
        await (client as any).request('GET', BOOKINGS_PATH);
        expect((global.fetch as jest.Mock).mock.calls.length).toBe(2);
        expect(b.getState()).toBe('CLOSED');
        expect(b.snapshot().probesExecuted).toBe(1); // exatamente UMA probe
    });

    it('(f) nova request continua fast-failando em OPEN sem fetch nem slot', async () => {
        const client = buildClient();
        forceOpen(breakerFor());
        global.fetch = jest.fn() as any;
        acquireSpy.mockClear();
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toBeInstanceOf(DoctoraliaCircuitOpenError);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(acquireSpy).not.toHaveBeenCalled();
    });

    it('(g) retries normais intactos com breaker CLOSED (503 → 200)', async () => {
        const client = buildClient();
        global.fetch = jest.fn()
            .mockResolvedValueOnce(makeResponse(503, 'down'))
            .mockResolvedValue(OK()) as any;
        await expect((client as any).request('GET', BOOKINGS_PATH)).resolves.toEqual({ result: 'ok' });
        expect((global.fetch as jest.Mock).mock.calls.length).toBe(2);
        expect(breakerFor().getState()).toBe('CLOSED');
        expect(breakerFor().getConsecutiveFailures()).toBe(0);
    });

    it('(race-token) breaker abre DURANTE o getToken do retry → bloqueia antes do slot e do fetch', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(makeResponse(503, 'down')) as any;
        // 1ª tentativa passa; no getToken da 2ª tentativa (retry), o breaker abre.
        let tokenCalls = 0;
        (client as any).getToken.mockImplementation(async () => {
            tokenCalls++;
            if (tokenCalls === 2) forceOpen(breakerFor());
            (client as any).accessToken = 'mock-token';
            return 'mock-token';
        });
        acquireSpy.mockClear();
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toBeInstanceOf(DoctoraliaCircuitOpenError);
        expect((global.fetch as jest.Mock).mock.calls.length).toBe(1); // retry não disparou
        expect(acquireSpy).toHaveBeenCalledTimes(1);                   // retry não consumiu slot
    });

    it('(race-queue) breaker abre ENQUANTO o retry espera na fila → grant devolvido por identidade, sem fetch', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(makeResponse(503, 'down')) as any;
        // 2º acquire (o do retry) concede o slot, mas o breaker abriu durante a espera.
        let acquires = 0;
        acquireSpy.mockImplementation(async () => {
            acquires++;
            const aggTs = 1_000_000 + acquires; // timestamps distintos e rastreáveis
            (DocplannerClient as any).rateTimestamps.push(aggTs); // simula grant real
            if (acquires === 2) forceOpen(breakerFor());
            return { aggTs };
        });
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toBeInstanceOf(DoctoraliaCircuitOpenError);
        expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);          // sem 2º HTTP
        // Só a reserva EXATA do retry bloqueado foi removida (a da 1ª tentativa fica).
        expect((DocplannerClient as any).rateTimestamps).toEqual([1_000_001]);
    });

    it('(race-queue-concorrente) grants GET/WRITE mistos: só a reserva do retry bloqueado é devolvida', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(makeResponse(503, 'down')) as any;
        // Simula o pump concedendo VÁRIOS slots (GET e WRITE de outras requisições)
        // depois do grant do retry, antes de o retry retomar a execução.
        let acquires = 0;
        acquireSpy.mockImplementation(async (_logger: any, methodClass: 'GET' | 'WRITE') => {
            acquires++;
            const aggTs = 2_000_000 + acquires;
            (DocplannerClient as any).rateTimestamps.push(aggTs);
            const grant: any = { aggTs };
            if (methodClass === 'WRITE') {
                (DocplannerClient as any).writeTimestamps.push(aggTs);
                grant.writeTs = aggTs;
            }
            if (acquires === 2) {
                // Entre o grant do retry e a retomada, OUTRAS requisições (1 GET +
                // 1 WRITE) recebem slots MAIS NOVOS e ainda vão despachar.
                (DocplannerClient as any).rateTimestamps.push(9_000_001); // GET concorrente
                (DocplannerClient as any).rateTimestamps.push(9_000_002); // WRITE concorrente
                (DocplannerClient as any).writeTimestamps.push(9_000_002);
                forceOpen(breakerFor());
            }
            return grant;
        });
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toBeInstanceOf(DoctoraliaCircuitOpenError);
        // Devolvida SOMENTE a reserva do retry bloqueado (2_000_002); as reservas
        // das requisições concorrentes permanecem contadas nas duas janelas.
        expect((DocplannerClient as any).rateTimestamps).toEqual([2_000_001, 9_000_001, 9_000_002]);
        expect((DocplannerClient as any).writeTimestamps).toEqual([9_000_002]);
    });

    it('(race-401) retry pós-401 idempotente não dispara 2º HTTP se o breaker abriu na renovação do token', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(makeResponse(401, 'Unauthorized')) as any;
        // getToken(force=true) da renovação pós-401 coincide com o OPEN.
        (client as any).getToken.mockImplementation(async (force: boolean) => {
            if (force) forceOpen(breakerFor());
            (client as any).accessToken = 'mock-token';
            return 'mock-token';
        });
        acquireSpy.mockClear();
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toBeInstanceOf(DoctoraliaCircuitOpenError);
        expect((global.fetch as jest.Mock).mock.calls.length).toBe(1); // repetição do 401 bloqueada
        expect(acquireSpy).toHaveBeenCalledTimes(1);
        expect(breakerFor().getState()).toBe('OPEN'); // bloqueio não alimentou/alterou o breaker
    });

    it('(h) Retry-After segue funcionando em CLOSED (429 → espera → 200)', async () => {
        const client = buildClient();
        global.fetch = jest.fn()
            .mockResolvedValueOnce(makeResponse(429, 'slow down', { 'Retry-After': '2' }))
            .mockResolvedValue(OK()) as any;
        await expect((client as any).request('GET', BOOKINGS_PATH)).resolves.toEqual({ result: 'ok' });
        expect((global.fetch as jest.Mock).mock.calls.length).toBe(2);
        // O backoff honrou o Retry-After (>= 2000ms)
        const delays = sleepSpy.mock.calls.map((c: any[]) => c[0]);
        expect(Math.max(...delays)).toBeGreaterThanOrEqual(2000);
    });
});
