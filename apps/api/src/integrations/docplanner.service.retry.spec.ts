/**
 * WP-07 — Retry HTTP com backoff exponencial e full jitter no DocplannerClient
 *
 * Nenhuma chamada real: `fetch` e `sleep` são mockados. Cobre os 21 casos
 * obrigatórios do plano.
 */

import { ConfigService } from '@nestjs/config';
import { DocplannerClient } from './docplanner.service';
import { DoctoraliaCircuitBreaker } from './doctoralia-circuit-breaker';
import {
    computeBackoffMs,
    parseRetryAfterMs,
    decideRetry,
    classifyFailure,
    BACKOFF_BASE_MS,
    BACKOFF_CAP_MS,
    RETRY_AFTER_MAX_MS,
    MAX_HTTP_ATTEMPTS,
} from './docplanner-retry.policy';

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

function netError(code: string): Error {
    const err = new Error(`fetch failed`);
    (err as any).cause = { code };
    return err;
}

function abortError(): Error {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    return err;
}

function buildClient(clientId = 'test-client-id'): DocplannerClient {
    const configService = { get: jest.fn() } as unknown as ConfigService;
    const client = new DocplannerClient(configService);
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
const SLOTS_PATH = '/api/v3/integration/facilities/1/doctors/2/addresses/3/slots';

let acquireSpy: jest.SpyInstance;
let sleepSpy: jest.SpyInstance;

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
    sleepSpy = jest.spyOn(DocplannerClient as any, 'sleep').mockResolvedValue(undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Política pura (unit)
// ---------------------------------------------------------------------------

describe('docplanner-retry.policy — funções puras', () => {

    it('full jitter: 0 <= delay <= min(cap, base·2^n) para n=0..5; random=1 encosta no teto', () => {
        for (let n = 0; n <= 5; n++) {
            const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, n));
            expect(computeBackoffMs(n, () => 0)).toBe(0);
            expect(computeBackoffMs(n, () => 1)).toBe(ceiling);
            const d = computeBackoffMs(n);
            expect(d).toBeGreaterThanOrEqual(0);
            expect(d).toBeLessThanOrEqual(ceiling);
        }
        // teto absoluto: n grande não passa de 30s
        expect(computeBackoffMs(10, () => 1)).toBe(BACKOFF_CAP_MS);
    });

    it('parseRetryAfterMs: segundos, HTTP-date, ausente e lixo', () => {
        expect(parseRetryAfterMs('7', 0)).toBe(7000);
        const now = Date.parse('2026-08-11T12:00:00Z');
        expect(parseRetryAfterMs('Tue, 11 Aug 2026 12:00:10 GMT', now)).toBe(10_000);
        // data no passado → 0 (nunca negativo)
        expect(parseRetryAfterMs('Tue, 11 Aug 2026 11:59:00 GMT', now)).toBe(0);
        expect(parseRetryAfterMs(null)).toBeNull();
        expect(parseRetryAfterMs('garbage')).toBeNull();
    });

    it('classifyFailure: transitórios vs não-transitórios', () => {
        for (const s of [408, 429, 500, 502, 503, 504]) {
            expect(classifyFailure({ status: s }).transient).toBe(true);
        }
        for (const s of [400, 401, 403, 404, 405, 409, 422]) {
            expect(classifyFailure({ status: s }).transient).toBe(false);
        }
        expect(classifyFailure(abortError()).transient).toBe(true);
        expect(classifyFailure(netError('ECONNRESET')).transient).toBe(true);
        expect(classifyFailure(netError('EAI_AGAIN')).transient).toBe(true);
        expect(classifyFailure(netError('ECONNREFUSED')).transient).toBe(false);
        expect(classifyFailure(new Error('random')).transient).toBe(false);
    });

    it('decideRetry: 429 com Retry-After > 120s propaga sem retry', () => {
        const err: any = new Error('429');
        err.status = 429;
        err.retryAfter = String((RETRY_AFTER_MAX_MS / 1000) + 1);
        const d = decideRetry({ error: err, retryEligible: true, attemptsUsed: 1, retryIndex: 0 });
        expect(d.retry).toBe(false);
        expect((d as any).reason).toBe('retry-after-acima-do-teto');
    });

    it('decideRetry: 429 usa o MAIOR entre Retry-After e backoff', () => {
        const err: any = new Error('429');
        err.status = 429;
        err.retryAfter = '60'; // 60s > backoff máximo do 1º retry (2s)
        const d = decideRetry({ error: err, retryEligible: true, attemptsUsed: 1, retryIndex: 0, random: () => 1 });
        expect(d.retry).toBe(true);
        expect((d as any).delayMs).toBe(60_000);
        expect((d as any).usedRetryAfter).toBe(true);
    });

    it('decideRetry: orçamento esgotado → exhausted', () => {
        const d = decideRetry({ error: { status: 503 }, retryEligible: true, attemptsUsed: MAX_HTTP_ATTEMPTS, retryIndex: 2 });
        expect(d.retry).toBe(false);
        expect((d as any).exhausted).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Integração no DocplannerClient
// ---------------------------------------------------------------------------

describe('DocplannerClient — retry transitório (WP-07)', () => {

    it('1. GET 503 → retry → sucesso (2 fetches, 1 espera)', async () => {
        const client = buildClient();
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(makeResponse(503, 'unavailable'))
            .mockResolvedValueOnce(OK());
        global.fetch = fetchMock;

        const r = await (client as any).request('GET', BOOKINGS_PATH);
        expect(r).toEqual({ result: 'ok' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(sleepSpy).toHaveBeenCalledTimes(1);
    });

    it('2. GET 503 persistente → esgota 3 tentativas e propaga o erro final', async () => {
        const client = buildClient();
        const fetchMock = jest.fn().mockResolvedValue(makeResponse(503, 'unavailable'));
        global.fetch = fetchMock;

        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toThrow('Docplanner API Error: 503');
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(sleepSpy).toHaveBeenCalledTimes(2);
    });

    it('3. 429 com Retry-After em segundos → espera >= o valor do header', async () => {
        const client = buildClient();
        global.fetch = jest.fn()
            .mockResolvedValueOnce(makeResponse(429, 'slow down', { 'Retry-After': '5' }))
            .mockResolvedValueOnce(OK());

        await (client as any).request('GET', BOOKINGS_PATH);
        expect(sleepSpy).toHaveBeenCalledTimes(1);
        expect(sleepSpy.mock.calls[0][0]).toBeGreaterThanOrEqual(5000);
        expect(sleepSpy.mock.calls[0][0]).toBeLessThanOrEqual(RETRY_AFTER_MAX_MS);
    });

    it('4. 429 com Retry-After em HTTP-date → espera aproximada até a data', async () => {
        const client = buildClient();
        const date = new Date(Date.now() + 10_000).toUTCString();
        global.fetch = jest.fn()
            .mockResolvedValueOnce(makeResponse(429, 'slow down', { 'Retry-After': date }))
            .mockResolvedValueOnce(OK());

        await (client as any).request('GET', BOOKINGS_PATH);
        expect(sleepSpy).toHaveBeenCalledTimes(1);
        // tolerância: parsing + relógio (data em resolução de segundos)
        expect(sleepSpy.mock.calls[0][0]).toBeGreaterThanOrEqual(8000);
        expect(sleepSpy.mock.calls[0][0]).toBeLessThanOrEqual(11_000);
    });

    it('5. 429 com Retry-After acima de 120s → propaga sem retry nem espera', async () => {
        const client = buildClient();
        const fetchMock = jest.fn().mockResolvedValue(makeResponse(429, 'slow down', { 'Retry-After': '300' }));
        global.fetch = fetchMock;

        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toThrow('429');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sleepSpy).not.toHaveBeenCalled();
    });

    it('6. timeout (AbortError) → retry', async () => {
        const client = buildClient();
        const fetchMock = jest.fn()
            .mockRejectedValueOnce(abortError())
            .mockResolvedValueOnce(OK());
        global.fetch = fetchMock;

        const r = await (client as any).request('GET', BOOKINGS_PATH);
        expect(r).toEqual({ result: 'ok' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('7. ECONNRESET e EAI_AGAIN → retry; ECONNREFUSED → zero retry', async () => {
        for (const code of ['ECONNRESET', 'EAI_AGAIN']) {
            const client = buildClient();
            const fetchMock = jest.fn()
                .mockRejectedValueOnce(netError(code))
                .mockResolvedValueOnce(OK());
            global.fetch = fetchMock;
            await expect((client as any).request('GET', BOOKINGS_PATH)).resolves.toEqual({ result: 'ok' });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        }
        const client = buildClient();
        const fetchMock = jest.fn().mockRejectedValue(netError('ECONNREFUSED'));
        global.fetch = fetchMock;
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toThrow('fetch failed');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('8. 400/403/404/409/422 → zero retry', async () => {
        for (const status of [400, 403, 404, 409, 422]) {
            const client = buildClient();
            const fetchMock = jest.fn().mockResolvedValue(makeResponse(status, 'nope'));
            global.fetch = fetchMock;
            await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toThrow(`Docplanner API Error: ${status}`);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        }
        expect(sleepSpy).not.toHaveBeenCalled();
    });

    it('9. challenge WAF (405 + captcha) → zero retry', async () => {
        const client = buildClient();
        const fetchMock = jest.fn().mockResolvedValue(makeResponse(405, '<html>captcha challenge</html>'));
        global.fetch = fetchMock;
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toThrow('405');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('10. POST + timeout e POST + 503 → zero retry', async () => {
        const breakPath = '/api/v3/integration/facilities/1/doctors/2/addresses/3/breaks';
        {
            const client = buildClient();
            const fetchMock = jest.fn().mockRejectedValue(abortError());
            global.fetch = fetchMock;
            await expect((client as any).request('POST', breakPath, { since: 'a', till: 'b' })).rejects.toMatchObject({ name: 'AbortError' });
            expect(fetchMock).toHaveBeenCalledTimes(1);
        }
        {
            const client = buildClient();
            const fetchMock = jest.fn().mockResolvedValue(makeResponse(503, 'unavailable'));
            global.fetch = fetchMock;
            await expect((client as any).request('POST', breakPath, { since: 'a', till: 'b' })).rejects.toThrow('503');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        }
        expect(sleepSpy).not.toHaveBeenCalled();
    });

    it('11. PATCH + 503 → zero retry', async () => {
        const client = buildClient();
        const fetchMock = jest.fn().mockResolvedValue(makeResponse(503, 'unavailable'));
        global.fetch = fetchMock;
        await expect((client as any).request('PATCH', '/api/v3/integration/facilities/1/doctors/2/addresses/3', { street: 'x' })).rejects.toThrow('503');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('12. PUT REPLACE_SLOTS + 503 → retry; PUT não-REPLACE_SLOTS + 503 → zero retry', async () => {
        {
            const client = buildClient();
            const fetchMock = jest.fn()
                .mockResolvedValueOnce(makeResponse(503, 'unavailable'))
                .mockResolvedValueOnce(OK());
            global.fetch = fetchMock;
            await expect((client as any).request('PUT', SLOTS_PATH, { slots: [] })).resolves.toEqual({ result: 'ok' });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        }
        {
            const client = buildClient();
            const fetchMock = jest.fn().mockResolvedValue(makeResponse(503, 'unavailable'));
            global.fetch = fetchMock;
            const insurancePath = '/api/v3/integration/facilities/1/doctors/2/addresses/3/insurance-providers';
            await expect((client as any).request('PUT', insurancePath, { insurance_provider_id: '9' })).rejects.toThrow('503');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        }
    });

    it('13. cada tentativa readquire slot no rate limiter', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(makeResponse(503, 'unavailable'));
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toThrow('503');
        expect(acquireSpy).toHaveBeenCalledTimes(3);
    });

    it('14. retry acontece DENTRO do mesmo voo WP-05 — awaiters compartilham a sequência', async () => {
        const client = buildClient();
        let resolveFirst!: (r: Response) => void;
        const first = new Promise<Response>(res => { resolveFirst = res; });
        const fetchMock = jest.fn()
            .mockReturnValueOnce(first)
            .mockResolvedValueOnce(OK());
        global.fetch = fetchMock;

        const p1 = (client as any).request('GET', BOOKINGS_PATH);
        const p2 = (client as any).request('GET', BOOKINGS_PATH);
        await new Promise(r => setImmediate(r));
        resolveFirst(makeResponse(503, 'unavailable'));

        const [r1, r2] = await Promise.all([p1, p2]);
        // 2 fetches no total (503 + retry) — NÃO 4
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(r1).toEqual({ result: 'ok' });
        expect(r2).toEqual({ result: 'ok' });
        expect(((DocplannerClient as any).inflightGets as Map<string, any>).size).toBe(0);
    });

    it('15. 401 → renovação + 1 repetição continua funcionando (comportamento preservado)', async () => {
        const client = buildClient();
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(makeResponse(401, 'Unauthorized'))
            .mockResolvedValueOnce(OK());
        global.fetch = fetchMock;

        const r = await (client as any).request('GET', BOOKINGS_PATH);
        expect(r).toEqual({ result: 'ok' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        // retry de 401 é imediato — sem backoff
        expect(sleepSpy).not.toHaveBeenCalled();
    });

    it('16. 401 repetido no retry NÃO gera loop transitório (401 não é transitório)', async () => {
        const client = buildClient();
        const fetchMock = jest.fn().mockResolvedValue(makeResponse(401, 'Unauthorized'));
        global.fetch = fetchMock;

        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toThrow('401');
        // 1ª tentativa + 1 repetição do mecanismo de 401 — e nada mais
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(sleepSpy).not.toHaveBeenCalled();
    });

    it('17. 503 → retry → 401: a repetição do 401 respeita o orçamento total de 3 tentativas', async () => {
        const client = buildClient();
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(makeResponse(503, 'unavailable'))  // tentativa 1
            .mockResolvedValueOnce(makeResponse(401, 'Unauthorized')) // tentativa 2 → 401
            .mockResolvedValueOnce(OK());                             // tentativa 3 (repetição do 401)
        global.fetch = fetchMock;

        const r = await (client as any).request('GET', BOOKINGS_PATH);
        expect(r).toEqual({ result: 'ok' });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('18. 503 → 401 → 503: nunca passa de 3 fetches (sem loop cruzado)', async () => {
        const client = buildClient();
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(makeResponse(503, 'unavailable'))
            .mockResolvedValueOnce(makeResponse(401, 'Unauthorized'))
            .mockResolvedValue(makeResponse(503, 'unavailable'));
        global.fetch = fetchMock;

        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('19. delays das esperas respeitam os bounds do full jitter', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(makeResponse(503, 'unavailable'));
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toThrow('503');
        expect(sleepSpy).toHaveBeenCalledTimes(2);
        // retry 0: 0..1000ms | retry 1: 0..2000ms
        expect(sleepSpy.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
        expect(sleepSpy.mock.calls[0][0]).toBeLessThanOrEqual(BACKOFF_BASE_MS);
        expect(sleepSpy.mock.calls[1][0]).toBeGreaterThanOrEqual(0);
        expect(sleepSpy.mock.calls[1][0]).toBeLessThanOrEqual(BACKOFF_BASE_MS * 2);
    });

    it('20. erro final propagado preserva status e detalhes', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(makeResponse(502, 'bad gateway'));
        await expect((client as any).request('GET', BOOKINGS_PATH)).rejects.toMatchObject({ status: 502 });
    });

    it('21. GET 408/500/502/504 também são retryados', async () => {
        for (const status of [408, 500, 502, 504]) {
            const client = buildClient();
            const fetchMock = jest.fn()
                .mockResolvedValueOnce(makeResponse(status, 'transient'))
                .mockResolvedValueOnce(OK());
            global.fetch = fetchMock;
            await expect((client as any).request('GET', BOOKINGS_PATH)).resolves.toEqual({ result: 'ok' });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        }
    });
});
