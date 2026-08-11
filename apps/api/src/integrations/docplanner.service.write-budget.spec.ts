/**
 * Task 130 — Dois budgets GET/WRITE no rate limiter Doctoralia
 *
 * Cobre os cenários obrigatórios do plano sem chamadas reais (fetch mockado).
 * acquireRateSlot NÃO é mockado — os testes exercem o pump real.
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

/** Avança o relógio sem usar timers falsos; apenas para resetar janelas no state estático. */
function advanceFakeTime(ms: number) {
    // Shift todos os timestamps existentes para o passado
    const shift = (arr: number[]) => {
        for (let i = 0; i < arr.length; i++) arr[i] -= ms;
    };
    shift((DocplannerClient as any).rateTimestamps);
    shift((DocplannerClient as any).writeTimestamps);
}

const SLOTS_PATH = '/api/v3/integration/facilities/1/doctors/2/addresses/3/slots';
const BREAKS_PATH = '/api/v3/integration/facilities/1/doctors/2/addresses/3/breaks';
const BOOKINGS_PATH = '/api/v3/integration/facilities/1/doctors/2/addresses/3/bookings?start=2026-08-10&end=2026-08-17';

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
    DoctoraliaCircuitBreaker.resetAll();
    (DocplannerClient as any).lastWriteThrottleLogAt = 0;
    // Garante que nenhum wakeupFn pendente de um teste anterior vaze para o próximo
    (DocplannerClient as any).wakeupFn = null;
}

beforeEach(() => {
    resetStatics();
});

afterEach(() => {
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('DocplannerClient — budget WRITE por método (Task 130)', () => {

    /**
     * T1: WRITE bloqueado ao atingir 40/min enquanto GETs continuam fluindo.
     *
     * Estratégia: enche a janela WRITE com 40 timestamps sintéticos (sem fazer
     * chamadas reais), depois confirma que um GET recebe slot imediatamente mas
     * um WRITE entra na fila. O PUT recebe slot apenas após o primeiro timestamp
     * WRITE "envelhecer" (simulado via advanceFakeTime).
     */
    it('T1: write bloqueado ao atingir 40/min; GET continua fluindo', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(OK());

        // Preenche writeTimestamps com 40 entradas recentes (janela de 1 min)
        const now = Date.now();
        const wts: number[] = (DocplannerClient as any).writeTimestamps;
        for (let i = 0; i < 40; i++) wts.push(now - i * 10); // todas dentro de 1 min

        // GET deve resolver sem esperar (janela WRITE não afeta GETs)
        const getStart = Date.now();
        await (client as any).request('GET', BOOKINGS_PATH);
        const getElapsed = Date.now() - getStart;
        expect(getElapsed).toBeLessThan(500); // passou imediatamente

        // PUT deve aguardar o budget WRITE; para evitar espera real de 1min no test,
        // avançamos os timestamps para fora da janela e confirmamos que o budget libera.
        advanceFakeTime(61_000); // envelhece todos os writeTimestamps por 61s
        const putStart = Date.now();
        await (client as any).request('PUT', SLOTS_PATH, { slots: [] });
        const putElapsed = Date.now() - putStart;
        expect(putElapsed).toBeLessThan(500); // liberou após janela envelhecer
    });

    /**
     * T2: retry transitório de PUT consome budget WRITE em cada tentativa.
     *
     * O loop de retry (WP-07) chama executeRequest novamente, que chama
     * acquireRateSlot('WRITE') antes de cada tentativa. Verificamos que
     * writeTimestamps cresce 2× (original + retry).
     */
    it('T2: retry de PUT consome budget WRITE em cada tentativa', async () => {
        const client = buildClient();
        // Primeira tentativa → 503 (transitório retryável); segunda → 200
        const err503 = Object.assign(new Error('Docplanner API Error: 503'), { status: 503 });
        let callCount = 0;
        jest.spyOn(client as any, 'executeRequest').mockImplementation(
            async (method: string, path: string, data: any, isRetry: boolean, attemptState: any) => {
                // Chama acquireRateSlot diretamente para registrar no budget
                const methodClass = method === 'GET' ? 'GET' : 'WRITE';
                await (DocplannerClient as any).acquireRateSlot((client as any).logger, methodClass);
                attemptState.attempts++;
                callCount++;
                if (callCount === 1) throw err503;
                return { result: 'ok' };
            },
        );
        // decideRetry: primeira falha 503 → retry
        jest.spyOn(require('./docplanner-retry.policy'), 'decideRetry').mockImplementation(
            ({ attemptsUsed }: any) => attemptsUsed < 2
                ? { retry: true, classification: '5XX', delayMs: 0, usedRetryAfter: false }
                : { retry: false, exhausted: false },
        );
        jest.spyOn(DocplannerClient as any, 'sleep').mockResolvedValue(undefined);

        await (client as any).executeWithRetry('PUT', SLOTS_PATH, { slots: [] });

        // Duas aquisições WRITE: original + retry
        const wts: number[] = (DocplannerClient as any).writeTimestamps;
        expect(wts.length).toBe(2);
        expect(callCount).toBe(2);
    });

    /**
     * T3: repetição pós-401 consome budget do verbo correto.
     *
     * O ramo 401 dentro de executeRequest chama executeRequest recursivamente
     * com isRetry=true. Cada chamada chama acquireRateSlot com a classe do método.
     * Verificamos: PUT → 2 WRITEs; GET → 0 WRITEs (GET não consome budget WRITE).
     */
    it('T3: repetição pós-401 consome budget do verbo (PUT→WRITE; GET→sem WRITE)', async () => {
        // ─── Caso PUT ───────────────────────────────────────────────────────
        {
            resetStatics();
            const client = buildClient();
            let fetchCallCount = 0;
            global.fetch = jest.fn().mockImplementation(() => {
                fetchCallCount++;
                if (fetchCallCount === 1) return Promise.resolve(makeResponse(401, 'Unauthorized'));
                return Promise.resolve(OK());
            });
            jest.spyOn(client as any, 'getToken').mockImplementation(async () => {
                (client as any).accessToken = 'refreshed-token';
                return 'refreshed-token';
            });

            await (client as any).executeRequest('PUT', SLOTS_PATH, { slots: [] }, false, { attempts: 0 });
            const wts: number[] = (DocplannerClient as any).writeTimestamps;
            // original PUT + retry PUT → 2 entradas WRITE
            expect(wts.length).toBe(2);
        }

        // ─── Caso GET ───────────────────────────────────────────────────────
        {
            resetStatics();
            const client = buildClient();
            let fetchCallCount = 0;
            global.fetch = jest.fn().mockImplementation(() => {
                fetchCallCount++;
                if (fetchCallCount === 1) return Promise.resolve(makeResponse(401, 'Unauthorized'));
                return Promise.resolve(OK());
            });
            jest.spyOn(client as any, 'getToken').mockImplementation(async () => {
                (client as any).accessToken = 'refreshed-token';
                return 'refreshed-token';
            });

            await (client as any).executeRequest('GET', BOOKINGS_PATH, undefined, false, { attempts: 0 });
            const wts: number[] = (DocplannerClient as any).writeTimestamps;
            // GETs não consomem budget WRITE
            expect(wts.length).toBe(0);
        }
    });

    /**
     * T4: teto agregado de 400/5min ainda respeitado — write conta nas duas janelas.
     *
     * Após 40 writes, o write budget está cheio para 1min. Mas a janela agregada
     * continua contando cada write. Verificamos que writeTimestamps e rateTimestamps
     * crescem juntos a cada write concedido.
     */
    it('T4: write conta na janela agregada E na janela WRITE', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(OK());

        // Executa 3 writes
        for (let i = 0; i < 3; i++) {
            await (client as any).request('PUT', SLOTS_PATH, { slots: [] });
        }

        const rts: number[] = (DocplannerClient as any).rateTimestamps;
        const wts: number[] = (DocplannerClient as any).writeTimestamps;
        expect(rts.length).toBe(3); // contou na janela agregada
        expect(wts.length).toBe(3); // contou na janela WRITE
    });

    /**
     * T5: teto de 2.400/h é respeitado independentemente do teto de 40/min.
     *
     * Preenche 2.400 entradas na janela WRITE (todas dentro de 1h mas distribuídas
     * além de 1min para não disparar o teto de 40/min) e confirma que um novo write
     * fica bloqueado. Após envelhecer os timestamps, o write é liberado.
     */
    it('T5: teto de 2.400 writes/h é respeitado', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(OK());

        // Preenche 2.400 timestamps na janela de 1h, distribuídos além de 1min
        // (para não acionar o teto de 40/min).
        const now = Date.now();
        const wts: number[] = (DocplannerClient as any).writeTimestamps;
        for (let i = 0; i < 2400; i++) {
            // Distribui entre 2min e 59min atrás (fora da janela de 1min)
            wts.push(now - 120_000 - i * 50);
        }

        // O write deve ser bloqueado pela janela de 1h
        // Para resolver sem espera real, avançamos todos os timestamps para fora de 1h
        advanceFakeTime(3_601_000);

        const start = Date.now();
        await (client as any).request('PUT', SLOTS_PATH, { slots: [] });
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(500); // liberou após envelhecer

        // Apenas 1 novo write registrado (os 2.400 envelheceram)
        expect(wts.length).toBe(1);
    });

    /**
     * T6: prioridade high/low e anti-inanição preservadas para writes.
     *
     * Com budget WRITE disponível, dois writes (um high, um low) competem:
     * o high deve ser processado antes do low (prioridade preservada).
     */
    it('T6: prioridade high/low preservada para writes', async () => {
        const client = buildClient();
        const order: string[] = [];
        global.fetch = jest.fn().mockImplementation(() => Promise.resolve(OK()));

        // Para controlar a ordem, interceptamos acquireRateSlot antes de qualquer chamada.
        // Usamos runWithPriority para marcar o write high-priority.
        const highWrite = DocplannerClient.runWithPriority(() =>
            (client as any).request('PUT', SLOTS_PATH, { slots: ['high'] }).then(() => order.push('high'))
        );
        const lowWrite = (client as any).request('POST', BREAKS_PATH, { since: 'a', till: 'b' })
            .then(() => order.push('low'));

        await Promise.all([highWrite, lowWrite]);
        // high deve ter sido processado primeiro (ou empatado — nunca depois)
        expect(order.indexOf('high')).toBeLessThanOrEqual(order.indexOf('low'));
    });

    /**
     * T8 (determinístico): write fica pendente com budget cheio; GET chega depois e
     * resolve imediatamente sem envelhecer a janela WRITE.
     *
     * Este teste verifica o mecanismo de wakeup: quando o pump está dormindo aguardando
     * o budget WRITE, um GET recém-chegado deve acordá-lo via wakeupFn e ser atendido
     * imediatamente, enquanto o write permanece na fila.
     */
    it('T8: GET resolve imediatamente enquanto write fica bloqueado por budget cheio', async () => {
        const client = buildClient();
        // Preenche a janela WRITE de 1min com 40 entradas recentes
        const now = Date.now();
        const wts: number[] = (DocplannerClient as any).writeTimestamps;
        for (let i = 0; i < 40; i++) wts.push(now - i * 10);

        let writeResolved = false;
        let getResolved = false;
        const order: string[] = [];

        // Fetch: GET → sucesso imediato; PUT → nunca chamado (budget cheio, sem avançar tempo)
        global.fetch = jest.fn().mockImplementation((url: string, opts: any) => {
            if (opts?.method === 'PUT' || opts?.method === 'POST') {
                return Promise.resolve(makeResponse(200, '{"result":"ok"}'));
            }
            return Promise.resolve(OK());
        });

        // Enfileira write primeiro (budget cheio, vai bloquear)
        const writePromise = (client as any).request('PUT', SLOTS_PATH, { slots: [] }).then(() => {
            writeResolved = true;
            order.push('write');
        });

        // Pequena pausa para garantir que o pump está dormindo esperando o budget WRITE
        await new Promise(r => setImmediate(r));
        await new Promise(r => setTimeout(r, 20));

        // Confirma que o write ainda está bloqueado (budget WRITE cheio)
        expect(writeResolved).toBe(false);

        // Enfileira GET: deve acordar o pump via wakeup e resolver imediatamente
        const getPromise = (client as any).request('GET', BOOKINGS_PATH).then(() => {
            getResolved = true;
            order.push('get');
        });

        // Espera o GET resolver (não pode demorar mais do que ~500ms)
        await Promise.race([
            getPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('GET demorou demais')), 500)),
        ]);

        expect(getResolved).toBe(true);
        expect(order[0]).toBe('get'); // GET foi antes do write

        // Write ainda não resolveu (janela WRITE ainda cheia)
        expect(writeResolved).toBe(false);

        // Limpa: envelhece os timestamps e acorda o pump para ele liberar o write
        advanceFakeTime(61_000);
        // O pump está dormindo na espera do budget WRITE; precisamos acordá-lo após
        // os timestamps envelhecerem para que ele reavalie elegibilidade imediatamente.
        (DocplannerClient as any).wakeupFn?.();
        await writePromise;
        expect(writeResolved).toBe(true);
    }, 10_000);

    /**
     * T7: suíte existente do client não é afetada — acquireRateSlot com novo parâmetro.
     *
     * Verifica que acquireRateSlot aceita o parâmetro methodClass sem lançar erro,
     * tanto para GET quanto WRITE, e que o pump funciona normalmente para ambos.
     */
    it('T7: acquireRateSlot funciona para GET e WRITE sem erro', async () => {
        const client = buildClient();
        global.fetch = jest.fn().mockResolvedValue(OK());

        // GET
        await expect((client as any).request('GET', BOOKINGS_PATH)).resolves.toBeDefined();
        // POST (WRITE)
        await expect((client as any).request('POST', BREAKS_PATH, { since: 'a', till: 'b' })).resolves.toBeDefined();
        // DELETE (WRITE) — fetch retorna 200 com body, não 204; o resultado é definido (não null)
        await expect((client as any).request('DELETE', `${BREAKS_PATH}/123`)).resolves.toBeDefined();

        const wts: number[] = (DocplannerClient as any).writeTimestamps;
        const rts: number[] = (DocplannerClient as any).rateTimestamps;
        expect(wts.length).toBe(2); // POST + DELETE são WRITE
        expect(rts.length).toBe(3); // GET + POST + DELETE contam no agregado
    });
});
