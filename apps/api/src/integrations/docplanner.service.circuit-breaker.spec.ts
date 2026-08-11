/**
 * WP-08A — Circuit Breaker Doctoralia (CLOSED/OPEN/HALF_OPEN, chave por domain).
 *
 * Nenhuma chamada real: `fetch`, `sleep` e `acquireRateSlot` são mockados.
 */

import { ConfigService } from '@nestjs/config';
import { DocplannerClient } from './docplanner.service';
import {
    DoctoraliaCircuitBreaker,
    DoctoraliaCircuitOpenError,
    isDoctoraliaCircuitOpenError,
    isWafChallenge,
    CIRCUIT_FAILURE_THRESHOLD,
    CIRCUIT_INITIAL_COOLDOWN_MS,
    CIRCUIT_MAX_COOLDOWN_MS,
    CIRCUIT_WAF_MIN_COOLDOWN_MS,
} from './doctoralia-circuit-breaker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function buildClient(clientId = 'test-client-id', domain = 'https://www.doctoralia.com.br'): DocplannerClient {
    const configService = { get: jest.fn() } as unknown as ConfigService;
    const client = new DocplannerClient(configService);
    client.setBaseUrl(domain);
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

let acquireSpy: jest.SpyInstance;

beforeEach(() => {
    (DocplannerClient as any).tokenCache = new Map();
    (DocplannerClient as any).inflightAuth = new Map();
    (DocplannerClient as any).inflightGets = new Map();
    (DocplannerClient as any).rateTimestamps = [];
    (DocplannerClient as any).waitingHigh = [];
    (DocplannerClient as any).waitingLow = [];
    (DocplannerClient as any).pumping = false;
    (DocplannerClient as any).consecutiveHighGrants = 0;
    (DocplannerClient as any).lastThrottleLogAt = 0;
    DoctoraliaCircuitBreaker.resetAll();

    acquireSpy = jest.spyOn(DocplannerClient as any, 'acquireRateSlot').mockResolvedValue(undefined);
    jest.spyOn(DocplannerClient as any, 'sleep').mockResolvedValue(undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
    DoctoraliaCircuitBreaker.resetAll();
});

// ---------------------------------------------------------------------------
// Máquina de estados (unit, com relógio injetado)
// ---------------------------------------------------------------------------

describe('DoctoraliaCircuitBreaker — máquina de estados', () => {
    let clock: { t: number };
    const now = () => clock.t;

    function makeBreaker(opts: any = {}) {
        clock = { t: 1_000_000 };
        return new DoctoraliaCircuitBreaker('www.doctoralia.com.br', { now, ...opts });
    }

    it('começa CLOSED com 0 falhas consecutivas', () => {
        const b = makeBreaker();
        expect(b.getState()).toBe('CLOSED');
        expect(b.getConsecutiveFailures()).toBe(0);
    });

    it('falhas transitórias incrementam; sucesso zera o contador', () => {
        const b = makeBreaker();
        for (let i = 0; i < 3; i++) {
            const gate = b.beginRequest();
            b.recordFailure(transientError(503), gate);
        }
        expect(b.getConsecutiveFailures()).toBe(3);
        const gate = b.beginRequest();
        b.recordSuccess(gate);
        expect(b.getConsecutiveFailures()).toBe(0);
        expect(b.getState()).toBe('CLOSED');
    });

    it('threshold de 5 falhas consecutivas abre o circuito com cooldown de 60s', () => {
        const b = makeBreaker();
        for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
            b.recordFailure(transientError(502), b.beginRequest());
        }
        expect(b.getState()).toBe('OPEN');
        const snap = b.snapshot();
        expect(snap.openReason).toBe('CONSECUTIVE_TRANSIENT_FAILURES');
        expect(snap.cooldownMs).toBe(CIRCUIT_INITIAL_COOLDOWN_MS);
        expect(snap.cooldownRemainingMs).toBe(CIRCUIT_INITIAL_COOLDOWN_MS);
    });

    it('400/401/403/404/409/422 e erros de negócio NÃO alimentam o breaker', () => {
        const b = makeBreaker();
        for (const status of [400, 401, 403, 404, 409, 422]) {
            for (let i = 0; i < 10; i++) {
                b.recordFailure(transientError(status), b.beginRequest());
            }
        }
        const business = new Error('Docplanner API Error: 403 This address does not belong to this doctor');
        (business as any).status = 403;
        for (let i = 0; i < 10; i++) b.recordFailure(business, b.beginRequest());
        expect(b.getState()).toBe('CLOSED');
        expect(b.getConsecutiveFailures()).toBe(0);
    });

    it('WAF/challenge (405+captcha) abre IMEDIATAMENTE com cooldown mínimo de 5min', () => {
        const b = makeBreaker();
        const waf = new Error('Docplanner API Error: 405');
        (waf as any).status = 405;
        (waf as any).details = '<html>AWS WAF captcha challenge</html>';
        b.recordFailure(waf, b.beginRequest());
        expect(b.getState()).toBe('OPEN');
        const snap = b.snapshot();
        expect(snap.openReason).toBe('WAF_CHALLENGE');
        expect(snap.cooldownMs).toBeGreaterThanOrEqual(CIRCUIT_WAF_MIN_COOLDOWN_MS);
    });

    it('tripWafChallenge() (fluxo OAuth) abre imediatamente', () => {
        const b = makeBreaker();
        b.tripWafChallenge();
        expect(b.getState()).toBe('OPEN');
        expect(b.snapshot().openReason).toBe('WAF_CHALLENGE');
    });

    it('OPEN faz fast-fail com erro tipado (motivo + cooldown restante) e conta fastFails', () => {
        const b = makeBreaker();
        for (let i = 0; i < 5; i++) b.recordFailure(transientError(503), b.beginRequest());
        clock.t += 10_000;
        try {
            b.beginRequest();
            fail('deveria ter lançado');
        } catch (err: any) {
            expect(isDoctoraliaCircuitOpenError(err)).toBe(true);
            expect(err).toBeInstanceOf(DoctoraliaCircuitOpenError);
            expect(err.reason).toBe('CONSECUTIVE_TRANSIENT_FAILURES');
            expect(err.cooldownRemainingMs).toBe(CIRCUIT_INITIAL_COOLDOWN_MS - 10_000);
        }
        expect(b.snapshot().fastFails).toBe(1);
    });

    it('cooldown expirado → HALF_OPEN com exatamente UMA probe; demais fast-fail', () => {
        const b = makeBreaker();
        for (let i = 0; i < 5; i++) b.recordFailure(transientError(503), b.beginRequest());
        clock.t += CIRCUIT_INITIAL_COOLDOWN_MS + 1;
        const gate = b.beginRequest();
        expect(gate.isProbe).toBe(true);
        expect(b.getState()).toBe('HALF_OPEN');
        expect(() => b.beginRequest()).toThrow(DoctoraliaCircuitOpenError);
        // probe com sucesso → CLOSED e cooldown resetado
        b.recordSuccess(gate);
        expect(b.getState()).toBe('CLOSED');
        expect(b.snapshot().cooldownMs).toBe(CIRCUIT_INITIAL_COOLDOWN_MS);
        expect(b.snapshot().probesSucceeded).toBe(1);
    });

    it('probe falha → OPEN com cooldown progressivo (dobra) até o teto de 10min', () => {
        const b = makeBreaker();
        for (let i = 0; i < 5; i++) b.recordFailure(transientError(503), b.beginRequest());
        let expected = CIRCUIT_INITIAL_COOLDOWN_MS;
        for (let round = 0; round < 8; round++) {
            clock.t += expected + 1;
            const gate = b.beginRequest();
            expect(gate.isProbe).toBe(true);
            b.recordFailure(transientError(504), gate);
            expect(b.getState()).toBe('OPEN');
            expected = Math.min(expected * 2, CIRCUIT_MAX_COOLDOWN_MS);
            expect(b.snapshot().cooldownMs).toBe(expected);
        }
        expect(b.snapshot().cooldownMs).toBe(CIRCUIT_MAX_COOLDOWN_MS);
    });

    it('probe com erro NÃO-transitório (serviço respondeu) fecha o circuito', () => {
        const b = makeBreaker();
        for (let i = 0; i < 5; i++) b.recordFailure(transientError(503), b.beginRequest());
        clock.t += CIRCUIT_INITIAL_COOLDOWN_MS + 1;
        const gate = b.beginRequest();
        b.recordFailure(transientError(401), gate);
        expect(b.getState()).toBe('CLOSED');
    });

    it('chave por domain: circuitos de hosts diferentes são independentes', () => {
        const a = DoctoraliaCircuitBreaker.forDomain('www.doctoralia.com.br');
        const z = DoctoraliaCircuitBreaker.forDomain('www.znanylekarz.pl');
        for (let i = 0; i < 5; i++) a.recordFailure(transientError(503), a.beginRequest());
        expect(a.getState()).toBe('OPEN');
        expect(z.getState()).toBe('CLOSED');
        expect(() => z.beginRequest()).not.toThrow();
        // normalização: protocolo e caixa não fragmentam a chave
        expect(DoctoraliaCircuitBreaker.forDomain('https://WWW.DOCTORALIA.COM.BR')).toBe(a);
    });

    it('isWafChallenge: só 405 + página de challenge', () => {
        expect(isWafChallenge(405, 'aws waf captcha')).toBe(true);
        expect(isWafChallenge(405, '{"error":"method not allowed"}')).toBe(false);
        expect(isWafChallenge(503, 'captcha')).toBe(false);
        expect(isWafChallenge(undefined, 'captcha')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Integração com o DocplannerClient (fetch mockado)
// ---------------------------------------------------------------------------

describe('DocplannerClient + circuit breaker', () => {
    it('503 × 3 tentativas WP-07 = UM único incremento no breaker', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(makeResponse(503, 'oops')) as any;
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toThrow('503');
        expect((global.fetch as jest.Mock).mock.calls.length).toBe(3);
        const breaker = DoctoraliaCircuitBreaker.forDomain('www.doctoralia.com.br');
        expect(breaker.getConsecutiveFailures()).toBe(1);
        expect(breaker.getState()).toBe('CLOSED');
    });

    it('sucesso zera o contador do breaker', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(makeResponse(503, 'oops')) as any;
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toThrow();
        (global.fetch as jest.Mock).mockResolvedValue(OK());
        await (client as any).request('GET', BOOKINGS_PATH);
        expect(DoctoraliaCircuitBreaker.forDomain('www.doctoralia.com.br').getConsecutiveFailures()).toBe(0);
    });

    it('5 operações lógicas esgotadas abrem o circuito; a próxima chamada faz fast-fail SEM consumir rate slot, criar voo ou executar fetch', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(makeResponse(503, 'oops')) as any;
        for (let i = 0; i < 5; i++) {
            await expect((client as any).request('GET', `${BOOKINGS_PATH}&i=${i}`)).rejects.toThrow('503');
        }
        const breaker = DoctoraliaCircuitBreaker.forDomain('www.doctoralia.com.br');
        expect(breaker.getState()).toBe('OPEN');

        acquireSpy.mockClear();
        (global.fetch as jest.Mock).mockClear();
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toBeInstanceOf(DoctoraliaCircuitOpenError);
        await expect((client as any).request('POST', '/api/v3/integration/facilities/1/doctors/2/addresses/3/breaks', { since: 'a', till: 'b' }))
            .rejects.toBeInstanceOf(DoctoraliaCircuitOpenError);
        expect(acquireSpy).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
        expect(((DocplannerClient as any).inflightGets as Map<string, any>).size).toBe(0);
    });

    it('erros 401/403 (credencial de uma clínica) nunca abrem o circuito', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(makeResponse(403, 'forbidden')) as any;
        for (let i = 0; i < 8; i++) {
            await expect((client as any).request('GET', `${BOOKINGS_PATH}&i=${i}`)).rejects.toThrow('403');
        }
        const breaker = DoctoraliaCircuitBreaker.forDomain('www.doctoralia.com.br');
        expect(breaker.getState()).toBe('CLOSED');
        expect(breaker.getConsecutiveFailures()).toBe(0);
    });

    it('WAF 405+captcha em request normal abre o circuito imediatamente', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(makeResponse(405, '<html>AWS WAF challenge captcha</html>')) as any;
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toThrow('405');
        expect(DoctoraliaCircuitBreaker.forDomain('www.doctoralia.com.br').getState()).toBe('OPEN');
    });

    it('awaiters WP-05 do mesmo voo compartilham UM incremento e o MESMO erro', async () => {
        const client = buildClient();
        let release!: (v: Response) => void;
        const gatePromise = new Promise<Response>(r => { release = r; });
        global.fetch = jest.fn().mockImplementation(() => gatePromise) as any;

        const p1 = (client as any).request('GET', BOOKINGS_PATH);
        // aguarda o voo entrar no mapa antes do segundo awaiter
        await new Promise(r => setImmediate(r));
        const p2 = (client as any).request('GET', BOOKINGS_PATH);
        await new Promise(r => setImmediate(r));
        // as próximas 2 tentativas do retry também falham
        (global.fetch as jest.Mock).mockResolvedValue(makeResponse(503, 'down'));
        release(makeResponse(503, 'down'));

        const [r1, r2] = await Promise.allSettled([p1, p2]);
        expect(r1.status).toBe('rejected');
        expect(r2.status).toBe('rejected');
        expect((r2 as PromiseRejectedResult).reason.message).toBe((r1 as PromiseRejectedResult).reason.message);
        expect(DoctoraliaCircuitBreaker.forDomain('www.doctoralia.com.br').getConsecutiveFailures()).toBe(1);
    });

    it('em HALF_OPEN a primeira request real atua como probe: sucesso fecha o circuito', async () => {
        const client = buildClient();
        const breaker = DoctoraliaCircuitBreaker.forDomain('www.doctoralia.com.br');
        global.fetch = jest.fn().mockResolvedValue(makeResponse(503, 'down')) as any;
        for (let i = 0; i < 5; i++) {
            await expect((client as any).request('GET', `${BOOKINGS_PATH}&i=${i}`)).rejects.toThrow();
        }
        expect(breaker.getState()).toBe('OPEN');
        // simula fim do cooldown
        (breaker as any).openedUntil = Date.now() - 1;
        (global.fetch as jest.Mock).mockResolvedValue(OK());
        await (client as any).request('GET', BOOKINGS_PATH);
        expect(breaker.getState()).toBe('CLOSED');
    });

    it('authenticate registra a probe getFacilities como runner do breaker', async () => {
        const client = buildClient();
        const breaker = DoctoraliaCircuitBreaker.forDomain('www.doctoralia.com.br');
        await client.authenticate('test-client-id', 'test-secret');
        expect((breaker as any).probeRunner).toBeTruthy();
    });
});
