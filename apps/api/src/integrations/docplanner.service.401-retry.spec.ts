/**
 * WP-02 QA — Testes explícitos do retry 401 em DocplannerClient
 *
 * Cobre os branches de `isRetryableOperation()` e o bloco 401 de `request()`.
 * Nenhuma chamada real à Doctoralia é feita: `fetch` é inteiramente mockado via Jest.
 *
 * Cenários:
 *   1. GET retryável — retry após 401 → fetch chamado 2×
 *   2. POST ADD_BREAK — sem retry após 401 → fetch chamado 1×
 *   3. DELETE DELETE_BREAK — sem retry após 401 → fetch chamado 1×
 *   4. PATCH MOVE_BREAK — sem retry após 401 → fetch chamado 1×
 *   5. PUT REPLACE_SLOTS — retryável → fetch chamado 2×
 *   6. PUT não idempotente (PUT_INSURANCE) — sem retry → fetch chamado 1×
 *   7. Proteção contra retry infinito — GET com 401 em ambas as tentativas → fetch 2×, sem loop
 */

import { ConfigService } from '@nestjs/config';
import { DocplannerClient } from './docplanner.service';
import { DoctoraliaCircuitBreaker } from './doctoralia-circuit-breaker';

// ---------------------------------------------------------------------------
// Helpers de resposta mock
// ---------------------------------------------------------------------------

/** Monta uma resposta fetch simulada com status HTTP fornecido. */
function makeResponse(status: number, body = '{}'): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (_k: string) => null } as any,
        text: () => Promise.resolve(body),
        json: () => Promise.resolve(JSON.parse(body)),
    } as unknown as Response;
}

const OK_200   = () => makeResponse(200, '{"result":"ok"}');
const UNAUTH   = () => makeResponse(401, 'Unauthorized');

// ---------------------------------------------------------------------------
// Setup do cliente em modo unitário (sem NestJS / Prisma)
// ---------------------------------------------------------------------------

function buildClient(): { client: DocplannerClient; getTokenSpy: jest.SpyInstance } {
    const configService = { get: jest.fn() } as unknown as ConfigService;
    const client = new DocplannerClient(configService);

    client.setBaseUrl('https://www.doctoralia.com.br');
    client.setAccessToken('initial-token');

    // Injeta clientId/clientSecret diretamente para acionar o branch 401 em request()
    (client as any).clientId     = 'test-client-id';
    (client as any).clientSecret = 'test-secret';

    // Mock getToken: mantém o token e resolve imediatamente (sem OAuth real)
    const getTokenSpy = jest.spyOn(client as any, 'getToken').mockImplementation(
        async (_forceRefresh: boolean) => {
            (client as any).accessToken = 'mock-token';
            return 'mock-token';
        },
    );

    return { client, getTokenSpy };
}

// ---------------------------------------------------------------------------
// Setup/Teardown global
// ---------------------------------------------------------------------------

beforeEach(() => {
    // Limpa o estado estático compartilhado entre instâncias para evitar contaminação
    (DocplannerClient as any).tokenCache      = new Map();
    (DocplannerClient as any).inflightAuth    = new Map();
    (DocplannerClient as any).rateTimestamps  = [];
    (DocplannerClient as any).waitingHigh     = [];
    (DocplannerClient as any).waitingLow      = [];
    (DocplannerClient as any).pumping         = false;
    (DocplannerClient as any).consecutiveHighGrants = 0;
    (DocplannerClient as any).lastThrottleLogAt     = 0;

    // acquireRateSlot resolve imediatamente — não queremos esperar janela de 5 min
    jest.spyOn(DocplannerClient as any, 'acquireRateSlot').mockResolvedValue(undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('DocplannerClient — retry 401', () => {
    it('catalog guard consumes both actual GET attempts across a 401 retry', async () => {
        const { client } = buildClient();
        const guard = jest.fn().mockResolvedValue(undefined);
        client.setCatalogAttemptGuard(guard);
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(UNAUTH())
            .mockResolvedValueOnce(OK_200());
        global.fetch = fetchMock;

        await (client as any).request(
            'GET',
            '/api/v3/integration/facilities/1/doctors/2/addresses/3/bookings',
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(guard).toHaveBeenCalledTimes(2);
    });

    it('catalog guard rejection releases admission and never dispatches fetch', async () => {
        const { client } = buildClient();
        client.setCatalogAttemptGuard(jest.fn().mockRejectedValue(new Error('shared cap exhausted')));
        const fetchMock = jest.fn();
        global.fetch = fetchMock;
        const release = jest.spyOn(DocplannerClient as any, 'releaseRateSlotGrant');

        await expect((client as any).request(
            'GET',
            '/api/v3/integration/facilities/1/doctors',
        )).rejects.toThrow('shared cap exhausted');

        expect(release).toHaveBeenCalledTimes(1);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    // ─── Cenário 1 ──────────────────────────────────────────────────────────
    it('1. GET: retry após 401 — fetch chamado 2×, getToken(true) chamado, resolve com sucesso', async () => {
        const { client, getTokenSpy } = buildClient();

        const fetchMock = jest.fn()
            .mockResolvedValueOnce(UNAUTH())   // 1ª tentativa → 401
            .mockResolvedValueOnce(OK_200());  // 2ª tentativa (retry) → 200

        global.fetch = fetchMock;

        const result = await (client as any).request('GET', '/api/v3/integration/facilities/1/doctors/2/addresses/3/bookings');

        // fetch chamado exatamente 2 vezes (original + retry)
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // getToken(true) deve ter sido chamado ao menos uma vez (renovação forçada no 401)
        const forceRefreshCalls = getTokenSpy.mock.calls.filter(([arg]) => arg === true);
        expect(forceRefreshCalls.length).toBeGreaterThanOrEqual(1);

        // Promise resolveu com sucesso
        expect(result).toBeDefined();
    });

    // ─── Cenário 2 ──────────────────────────────────────────────────────────
    it('2. POST ADD_BREAK: sem retry após 401 — fetch chamado 1×, getToken(true) chamado, promise rejeita com 401', async () => {
        const { client, getTokenSpy } = buildClient();

        const fetchMock = jest.fn().mockResolvedValueOnce(UNAUTH());
        global.fetch = fetchMock;

        await expect(
            (client as any).request('POST', '/api/v3/integration/facilities/1/doctors/2/addresses/3/breaks', { since: '2026-08-10T09:00:00', till: '2026-08-10T09:30:00' }),
        ).rejects.toMatchObject({ status: 401 });

        // Sem retry: fetch chamado apenas 1 vez
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Token renovado mesmo sem repetir
        const forceRefreshCalls = getTokenSpy.mock.calls.filter(([arg]) => arg === true);
        expect(forceRefreshCalls.length).toBeGreaterThanOrEqual(1);
    });

    // ─── Cenário 3 ──────────────────────────────────────────────────────────
    it('3. DELETE DELETE_BREAK: sem retry após 401 — fetch chamado 1×, getToken(true) chamado, promise rejeita com 401', async () => {
        const { client, getTokenSpy } = buildClient();

        const fetchMock = jest.fn().mockResolvedValueOnce(UNAUTH());
        global.fetch = fetchMock;

        await expect(
            (client as any).request('DELETE', '/api/v3/integration/facilities/1/doctors/2/addresses/3/breaks/999'),
        ).rejects.toMatchObject({ status: 401 });

        expect(fetchMock).toHaveBeenCalledTimes(1);

        const forceRefreshCalls = getTokenSpy.mock.calls.filter(([arg]) => arg === true);
        expect(forceRefreshCalls.length).toBeGreaterThanOrEqual(1);
    });

    // ─── Cenário 4 ──────────────────────────────────────────────────────────
    it('4. PATCH MOVE_BREAK: sem retry após 401 — fetch chamado 1×, getToken(true) chamado, promise rejeita com 401', async () => {
        const { client, getTokenSpy } = buildClient();

        const fetchMock = jest.fn().mockResolvedValueOnce(UNAUTH());
        global.fetch = fetchMock;

        await expect(
            (client as any).request('PATCH', '/api/v3/integration/facilities/1/doctors/2/addresses/3/breaks/999', { since: '2026-08-10T10:00:00', till: '2026-08-10T10:30:00' }),
        ).rejects.toMatchObject({ status: 401 });

        expect(fetchMock).toHaveBeenCalledTimes(1);

        const forceRefreshCalls = getTokenSpy.mock.calls.filter(([arg]) => arg === true);
        expect(forceRefreshCalls.length).toBeGreaterThanOrEqual(1);
    });

    // ─── Cenário 5 ──────────────────────────────────────────────────────────
    it('5. PUT REPLACE_SLOTS: retry após 401 — fetch chamado 2×, getToken(true) chamado, resolve com sucesso', async () => {
        const { client, getTokenSpy } = buildClient();

        const fetchMock = jest.fn()
            .mockResolvedValueOnce(UNAUTH())
            .mockResolvedValueOnce(OK_200());

        global.fetch = fetchMock;

        const result = await (client as any).request('PUT', '/api/v3/integration/facilities/1/doctors/2/addresses/3/slots', { slots: [] });

        // Verifica que inferOperation classificou como REPLACE_SLOTS (caminho do código alvo)
        const inferOp = (client as any).inferOperation('PUT', '/api/v3/integration/facilities/1/doctors/2/addresses/3/slots');
        expect(inferOp).toBe('REPLACE_SLOTS');

        expect(fetchMock).toHaveBeenCalledTimes(2);

        const forceRefreshCalls = getTokenSpy.mock.calls.filter(([arg]) => arg === true);
        expect(forceRefreshCalls.length).toBeGreaterThanOrEqual(1);

        expect(result).toBeDefined();
    });

    // ─── Cenário 6 ──────────────────────────────────────────────────────────
    it('6. PUT não idempotente (PUT_INSURANCE): sem retry após 401 — mesmo método HTTP (PUT) mas operação diferente de REPLACE_SLOTS', async () => {
        const { client, getTokenSpy } = buildClient();

        const fetchMock = jest.fn().mockResolvedValueOnce(UNAUTH());
        global.fetch = fetchMock;

        // Path sem /addresses/ no meio, portanto inferOperation retorna PUT_INSURANCE
        const path = '/api/v3/integration/insurance-providers/4';

        // Confirma que inferOperation NÃO classifica como REPLACE_SLOTS para este path
        const inferOp = (client as any).inferOperation('PUT', path);
        expect(inferOp).not.toBe('REPLACE_SLOTS');

        // Confirma que isRetryableOperation retorna false para essa combinação
        expect((client as any).isRetryableOperation('PUT', inferOp)).toBe(false);

        await expect(
            (client as any).request('PUT', path, { insurance_provider_id: '4' }),
        ).rejects.toMatchObject({ status: 401 });

        // Sem retry — o mesmo método PUT, mas operação não é REPLACE_SLOTS
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const forceRefreshCalls = getTokenSpy.mock.calls.filter(([arg]) => arg === true);
        expect(forceRefreshCalls.length).toBeGreaterThanOrEqual(1);
    });

    // ─── Cenário 7 ──────────────────────────────────────────────────────────
    it('7. Proteção contra retry infinito: GET com 401 em ambas as tentativas — fetch 2× exatamente, sem loop infinito', async () => {
        const { client, getTokenSpy } = buildClient();

        // Ambas as respostas retornam 401
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(UNAUTH())   // 1ª tentativa → 401 (isRetry=false → retry permitido)
            .mockResolvedValueOnce(UNAUTH());  // 2ª tentativa → 401 (isRetry=true → sem novo retry)

        global.fetch = fetchMock;

        await expect(
            (client as any).request('GET', '/api/v3/integration/facilities/1/doctors/2/addresses/3/bookings'),
        ).rejects.toMatchObject({ status: 401 });

        // Exatamente 2 chamadas — o `isRetry=true` na chamada recursiva impede a terceira
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // getToken(true) chamado na 1ª ocorrência do 401 (não na 2ª, pois isRetry bloqueia antes)
        const forceRefreshCalls = getTokenSpy.mock.calls.filter(([arg]) => arg === true);
        expect(forceRefreshCalls.length).toBeGreaterThanOrEqual(1);
    });

    // ─── Testes auxiliares de isRetryableOperation ───────────────────────────

    describe('isRetryableOperation — tabela de classificação', () => {
        let client: DocplannerClient;

        beforeEach(() => {
            ({ client } = buildClient());
        });

        it('GET é sempre retryável independente da operação', () => {
            expect((client as any).isRetryableOperation('GET', 'GET_BOOKINGS')).toBe(true);
            expect((client as any).isRetryableOperation('GET', 'GET_BREAKS')).toBe(true);
            expect((client as any).isRetryableOperation('GET', 'GET_FACILITIES')).toBe(true);
        });

        it('PUT REPLACE_SLOTS é retryável', () => {
            expect((client as any).isRetryableOperation('PUT', 'REPLACE_SLOTS')).toBe(true);
        });

        it('POST, DELETE, PATCH e outros PUTs não são retryáveis', () => {
            expect((client as any).isRetryableOperation('POST', 'ADD_BREAK')).toBe(false);
            expect((client as any).isRetryableOperation('DELETE', 'DELETE_BREAK')).toBe(false);
            expect((client as any).isRetryableOperation('PATCH', 'MOVE_BREAK')).toBe(false);
            expect((client as any).isRetryableOperation('PUT', 'PUT_INSURANCE')).toBe(false);
            expect((client as any).isRetryableOperation('PUT', 'PUT_ADDRESSES')).toBe(false);
        });
    });
});
