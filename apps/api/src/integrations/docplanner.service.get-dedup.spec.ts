/**
 * WP-05 — Deduplicação de GETs Doctoralia simultâneos idênticos (in-flight)
 *
 * Nenhuma chamada real: `fetch` é mockado via Jest. Cobre os 13 cenários
 * obrigatórios do plano.
 */

import { ConfigService } from '@nestjs/config';
import { DocplannerClient } from './docplanner.service';
import { DoctoraliaCircuitBreaker } from './doctoralia-circuit-breaker';

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
const UNAUTH = () => makeResponse(401, 'Unauthorized');

/** fetch mock cuja resolução é controlada manualmente (para simular voo em andamento). */
function deferredFetch() {
    let resolve!: (r: Response) => void;
    let reject!: (e: any) => void;
    const promise = new Promise<Response>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
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
});

afterEach(() => {
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('DocplannerClient — dedup de GETs in-flight (WP-05)', () => {

    it('1+2. dois GETs idênticos simultâneos → exatamente 1 fetch; ambos recebem o resultado correto', async () => {
        const client = buildClient();
        const d = deferredFetch();
        const fetchMock = jest.fn().mockReturnValue(d.promise);
        global.fetch = fetchMock;

        const p1 = (client as any).request('GET', BOOKINGS_PATH);
        const p2 = (client as any).request('GET', BOOKINGS_PATH);
        // deixa o primeiro voo chegar ao fetch antes de resolver
        await new Promise(r => setImmediate(r));
        d.resolve(OK('{"items":[{"id":1}]}'));

        const [r1, r2] = await Promise.all([p1, p2]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(r1).toEqual({ items: [{ id: 1 }] });
        expect(r2).toEqual({ items: [{ id: 1 }] });
    });

    it('3. resultados independentes — mutação de um consumidor não afeta o outro', async () => {
        const client = buildClient();
        const d = deferredFetch();
        global.fetch = jest.fn().mockReturnValue(d.promise);

        const p1 = (client as any).request('GET', BOOKINGS_PATH);
        const p2 = (client as any).request('GET', BOOKINGS_PATH);
        await new Promise(r => setImmediate(r));
        d.resolve(OK('{"items":[{"id":1}]}'));

        const [r1, r2] = await Promise.all([p1, p2]);
        r1.items[0].id = 999;
        r1.extra = 'mutated';
        expect(r2.items[0].id).toBe(1);
        expect(r2.extra).toBeUndefined();
    });

    it('4. paths/queries diferentes → fetches separados', async () => {
        const client = buildClient();
        const fetchMock = jest.fn().mockResolvedValue(OK());
        global.fetch = fetchMock;

        await Promise.all([
            (client as any).request('GET', BOOKINGS_PATH),
            (client as any).request('GET', BOOKINGS_PATH.replace('end=2026-08-17', 'end=2026-08-24')),
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('5. clientIds diferentes → fetches separados (nunca compartilham voo)', async () => {
        const clientA = buildClient('client-A');
        const clientB = buildClient('client-B');
        const dA = deferredFetch();
        const dB = deferredFetch();
        const fetchMock = jest.fn()
            .mockReturnValueOnce(dA.promise)
            .mockReturnValueOnce(dB.promise);
        global.fetch = fetchMock;

        const pA = (clientA as any).request('GET', BOOKINGS_PATH);
        const pB = (clientB as any).request('GET', BOOKINGS_PATH);
        await new Promise(r => setImmediate(r));
        expect(fetchMock).toHaveBeenCalledTimes(2);
        dA.resolve(OK());
        dB.resolve(OK());
        await Promise.all([pA, pB]);
    });

    it('6+7. erro propagado aos dois awaiters; após o erro, nova chamada faz novo fetch (erro não fica cacheado)', async () => {
        const client = buildClient();
        const d = deferredFetch();
        const fetchMock = jest.fn()
            .mockReturnValueOnce(d.promise)
            .mockResolvedValueOnce(OK());
        global.fetch = fetchMock;

        const p1 = (client as any).request('GET', BOOKINGS_PATH);
        const p2 = (client as any).request('GET', BOOKINGS_PATH);
        await new Promise(r => setImmediate(r));
        // WP-07: 500 agora é retryado (transitório); usamos 404 — não-retryável —
        // para continuar testando a propagação de erro do dedup sem retry.
        d.resolve(makeResponse(404, 'boom'));

        await expect(p1).rejects.toThrow('Docplanner API Error: 404');
        await expect(p2).rejects.toThrow('Docplanner API Error: 404');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(((DocplannerClient as any).inflightGets as Map<string, any>).size).toBe(0);

        // nova chamada após o erro → novo fetch
        const r3 = await (client as any).request('GET', BOOKINGS_PATH);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(r3).toEqual({ result: 'ok' });
    });

    it('8. timeout (AbortError) propaga aos awaiters e remove a entrada do mapa', async () => {
        const client = buildClient();
        const d = deferredFetch();
        global.fetch = jest.fn().mockReturnValue(d.promise);

        const p1 = (client as any).request('GET', BOOKINGS_PATH);
        const p2 = (client as any).request('GET', BOOKINGS_PATH);
        await new Promise(r => setImmediate(r));

        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        d.reject(abortErr);

        await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
        await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
        expect(((DocplannerClient as any).inflightGets as Map<string, any>).size).toBe(0);
    });

    it('9. mutações (POST/PUT/PATCH/DELETE) nunca são deduplicadas', async () => {
        const client = buildClient();
        const fetchMock = jest.fn().mockResolvedValue(OK());
        global.fetch = fetchMock;

        const breakPath = '/api/v3/integration/facilities/1/doctors/2/addresses/3/breaks';
        await Promise.all([
            (client as any).request('POST', breakPath, { since: 'a', till: 'b' }),
            (client as any).request('POST', breakPath, { since: 'a', till: 'b' }),
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(((DocplannerClient as any).inflightGets as Map<string, any>).size).toBe(0);

        fetchMock.mockClear();
        const slotsPath = '/api/v3/integration/facilities/1/doctors/2/addresses/3/slots';
        await Promise.all([
            (client as any).request('PUT', slotsPath, { slots: [] }),
            (client as any).request('PUT', slotsPath, { slots: [] }),
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('10. GET_NOTIFICATIONS nunca é deduplicado', async () => {
        const client = buildClient();
        const fetchMock = jest.fn().mockResolvedValue(OK());
        global.fetch = fetchMock;

        const notifPath = '/api/v3/integration/notifications';
        await Promise.all([
            (client as any).request('GET', notifPath),
            (client as any).request('GET', notifPath),
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(((DocplannerClient as any).inflightGets as Map<string, any>).size).toBe(0);
    });

    it('11. o segundo chamador junta-se ANTES de acquireRateSlot — não consome slot de vazão', async () => {
        const client = buildClient();
        const d = deferredFetch();
        global.fetch = jest.fn().mockReturnValue(d.promise);

        const p1 = (client as any).request('GET', BOOKINGS_PATH);
        await new Promise(r => setImmediate(r));
        const p2 = (client as any).request('GET', BOOKINGS_PATH);
        await new Promise(r => setImmediate(r));
        d.resolve(OK());
        await Promise.all([p1, p2]);

        // apenas o voo original adquiriu slot
        expect(acquireSpy).toHaveBeenCalledTimes(1);
    });

    it('12. 401→retry acontece DENTRO do voo único — 2 fetches, 1 slot extra pelo retry, ambos awaiters recebem sucesso', async () => {
        const client = buildClient();
        const d = deferredFetch();
        const fetchMock = jest.fn()
            .mockReturnValueOnce(d.promise)      // 1ª tentativa → 401
            .mockResolvedValueOnce(OK());        // retry → 200
        global.fetch = fetchMock;

        const p1 = (client as any).request('GET', BOOKINGS_PATH);
        const p2 = (client as any).request('GET', BOOKINGS_PATH);
        await new Promise(r => setImmediate(r));
        d.resolve(UNAUTH());

        const [r1, r2] = await Promise.all([p1, p2]);
        // 2 fetches no total (original + retry) — NÃO 4 (2 por awaiter)
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(r1).toEqual({ result: 'ok' });
        expect(r2).toEqual({ result: 'ok' });
        expect(((DocplannerClient as any).inflightGets as Map<string, any>).size).toBe(0);
    });

    it('13. entrada sai do mapa após sucesso — chamada subsequente faz nova requisição', async () => {
        const client = buildClient();
        const fetchMock = jest.fn().mockResolvedValue(OK());
        global.fetch = fetchMock;

        await (client as any).request('GET', BOOKINGS_PATH);
        expect(((DocplannerClient as any).inflightGets as Map<string, any>).size).toBe(0);
        await (client as any).request('GET', BOOKINGS_PATH);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
