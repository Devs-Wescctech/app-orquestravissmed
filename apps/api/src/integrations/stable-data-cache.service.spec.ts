/**
 * WP-06 — Cache TTL em memória para dados estáveis Doctoralia.
 *
 * Nenhuma chamada real. Cobre os cenários unitários do plano:
 * popular/hit/expirar, isolamento por chave (clientId/domain/recurso),
 * erro não cacheado, invalidação por chave/prefixo, cap + sweep,
 * instância nova vazia, clone defensivo e convivência com o dedup do WP-05.
 */

import { ConfigService } from '@nestjs/config';
import { DocplannerClient } from './docplanner.service';
import { StableDataCacheService, STABLE_DATA_TTLS } from './stable-data-cache.service';

describe('StableDataCacheService (WP-06)', () => {
    let cache: StableDataCacheService;

    beforeEach(() => {
        cache = new StableDataCacheService();
        jest.useRealTimers();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it('1. primeiro acesso (MISS) chama o fetch e popula o cache', async () => {
        const fetchFn = jest.fn().mockResolvedValue({ _items: [{ id: 1 }] });
        const r = await cache.getOrFetch('d|c|addresses|f|doc', 60_000, fetchFn);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(r).toEqual({ _items: [{ id: 1 }] });
        expect(cache.size()).toBe(1);
    });

    it('2. segundo acesso dentro do TTL é HIT — não chama a API', async () => {
        const fetchFn = jest.fn().mockResolvedValue({ _items: [{ id: 1 }] });
        await cache.getOrFetch('k', 60_000, fetchFn);
        const r2 = await cache.getOrFetch('k', 60_000, fetchFn);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(r2).toEqual({ _items: [{ id: 1 }] });
    });

    it('3. após expirar o TTL, refaz a chamada', async () => {
        jest.useFakeTimers();
        const fetchFn = jest.fn()
            .mockResolvedValueOnce({ v: 'old' })
            .mockResolvedValueOnce({ v: 'new' });
        await cache.getOrFetch('k', 1000, fetchFn);
        jest.advanceTimersByTime(1001);
        const r = await cache.getOrFetch('k', 1000, fetchFn);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(r).toEqual({ v: 'new' });
    });

    it('4. clientIds/domains diferentes não compartilham entradas', async () => {
        const fetchA = jest.fn().mockResolvedValue({ who: 'A' });
        const fetchB = jest.fn().mockResolvedValue({ who: 'B' });
        const rA = await cache.getOrFetch('www.doctoralia.com.br|client-A|addresses|f|d', 60_000, fetchA);
        const rB = await cache.getOrFetch('www.doctoralia.com.br|client-B|addresses|f|d', 60_000, fetchB);
        expect(fetchA).toHaveBeenCalledTimes(1);
        expect(fetchB).toHaveBeenCalledTimes(1);
        expect(rA.who).toBe('A');
        expect(rB.who).toBe('B');
    });

    it('5. recursos diferentes da mesma identidade não colidem', async () => {
        const fetchAddr = jest.fn().mockResolvedValue({ r: 'addresses' });
        const fetchSvc = jest.fn().mockResolvedValue({ r: 'services' });
        await cache.getOrFetch('d|c|addresses|f|doc', 60_000, fetchAddr);
        await cache.getOrFetch('d|c|services|f|doc|addr', 60_000, fetchSvc);
        expect(fetchAddr).toHaveBeenCalledTimes(1);
        expect(fetchSvc).toHaveBeenCalledTimes(1);
        expect(cache.size()).toBe(2);
    });

    it('7. erro do fetch não fica cacheado — próxima chamada tenta de novo', async () => {
        const fetchFn = jest.fn()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce({ ok: true });
        await expect(cache.getOrFetch('k', 60_000, fetchFn)).rejects.toThrow('boom');
        expect(cache.size()).toBe(0);
        const r = await cache.getOrFetch('k', 60_000, fetchFn);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(r).toEqual({ ok: true });
    });

    it('8. invalidação por chave exata remove só o dado correto', async () => {
        const f = jest.fn().mockResolvedValue({ ok: 1 });
        await cache.getOrFetch('d|c|services|f|doc|addr1', 60_000, f);
        await cache.getOrFetch('d|c|services|f|doc|addr2', 60_000, f);
        cache.invalidate('d|c|services|f|doc|addr1');
        expect(cache.size()).toBe(1);
        await cache.getOrFetch('d|c|services|f|doc|addr1', 60_000, f); // refetch
        await cache.getOrFetch('d|c|services|f|doc|addr2', 60_000, f); // hit
        expect(f).toHaveBeenCalledTimes(3);
    });

    it('8b. invalidação por prefixo remove todas as chaves derivadas', async () => {
        const f = jest.fn().mockResolvedValue({ ok: 1 });
        await cache.getOrFetch('d|c|services|f|doc|addr1', 60_000, f);
        await cache.getOrFetch('d|c|services|f|doc|addr2', 60_000, f);
        await cache.getOrFetch('d|c|addresses|f|doc', 60_000, f);
        cache.invalidate('d|c|services|f|doc');
        expect(cache.size()).toBe(1); // só addresses sobrou
    });

    it('11. cap de tamanho evita crescimento ilimitado (evict do mais antigo)', async () => {
        const f = jest.fn().mockResolvedValue({ ok: 1 });
        for (let i = 0; i < StableDataCacheService.MAX_ENTRIES + 10; i++) {
            await cache.getOrFetch(`k${i}`, 60_000, f);
        }
        expect(cache.size()).toBe(StableDataCacheService.MAX_ENTRIES);
        // as primeiras 10 chaves foram evictadas
        await cache.getOrFetch('k0', 60_000, f);
        expect(f).toHaveBeenCalledTimes(StableDataCacheService.MAX_ENTRIES + 11);
    });

    it('11b. sweep oportunista remove entradas expiradas', async () => {
        jest.useFakeTimers();
        const f = jest.fn().mockResolvedValue({ ok: 1 });
        await cache.getOrFetch('short', 1000, f);
        await cache.getOrFetch('long', 10 * 60_000, f);
        jest.advanceTimersByTime(2 * 60_000); // expira 'short' e libera o sweep
        await cache.getOrFetch('other', 60_000, f); // dispara sweepIfDue
        expect(cache.size()).toBe(2); // 'long' + 'other'; 'short' varrida
    });

    it('12. instância nova começa vazia', () => {
        expect(new StableDataCacheService().size()).toBe(0);
    });

    it('clone defensivo: mutação de um consumidor não afeta o cache nem outro consumidor', async () => {
        const f = jest.fn().mockResolvedValue({ _items: [{ id: 1 }] });
        const r1 = await cache.getOrFetch('k', 60_000, f);
        r1._items[0].id = 999;
        (r1 as any).extra = 'mutated';
        const r2 = await cache.getOrFetch('k', 60_000, f);
        expect(r2._items[0].id).toBe(1);
        expect((r2 as any).extra).toBeUndefined();
        expect(f).toHaveBeenCalledTimes(1);
    });

    it('TTLs padrão têm os valores do plano', () => {
        expect(STABLE_DATA_TTLS.addresses).toBe(20 * 60 * 1000);
        expect(STABLE_DATA_TTLS.services).toBe(20 * 60 * 1000);
        expect(STABLE_DATA_TTLS.facilityServicesCatalog).toBe(2 * 60 * 60 * 1000);
        expect(STABLE_DATA_TTLS.insurancePlans).toBe(2 * 60 * 60 * 1000);
        expect(STABLE_DATA_TTLS.servicesDictionary).toBe(12 * 60 * 60 * 1000);
        expect(STABLE_DATA_TTLS.insuranceProviders).toBe(12 * 60 * 60 * 1000);
        expect(STABLE_DATA_TTLS.facilities).toBe(2 * 60 * 60 * 1000);
        expect(STABLE_DATA_TTLS.doctors).toBe(30 * 60 * 1000);
    });
});

// ---------------------------------------------------------------------------
// 6. Convivência com o WP-05 (dedup in-flight) sob concorrência
// ---------------------------------------------------------------------------

describe('StableDataCache × dedup WP-05 sob concorrência', () => {
    function makeResponse(status: number, body = '{}'): Response {
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (_k: string) => null } as any,
            text: () => Promise.resolve(body),
            json: () => Promise.resolve(JSON.parse(body)),
        } as unknown as Response;
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
        jest.spyOn(DocplannerClient as any, 'acquireRateSlot').mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('6. dois MISS simultâneos da mesma chave são colapsados pelo dedup do client — 1 fetch de rede', async () => {
        const cache = new StableDataCacheService();
        const client = buildClient();
        let resolveFetch!: (r: Response) => void;
        const pending = new Promise<Response>(res => { resolveFetch = res; });
        const fetchMock = jest.fn().mockReturnValue(pending);
        global.fetch = fetchMock as any;

        const key = `${client.getCacheIdentity()}|addresses|1|2`;
        const p1 = cache.getOrFetch(key, 60_000, () => client.getAddresses('1', '2'));
        const p2 = cache.getOrFetch(key, 60_000, () => client.getAddresses('1', '2'));
        await new Promise(r => setImmediate(r));
        resolveFetch(makeResponse(200, '{"_items":[{"id":7}]}'));

        const [r1, r2] = await Promise.all([p1, p2]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(r1._items[0].id).toBe(7);
        expect(r2._items[0].id).toBe(7);

        // Terceiro acesso: HIT no cache TTL — nenhum fetch novo.
        const r3 = await cache.getOrFetch(key, 60_000, () => client.getAddresses('1', '2'));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(r3._items[0].id).toBe(7);
    });

    it('getCacheIdentity retorna domain|clientId', () => {
        const client = buildClient('client-X');
        expect(client.getCacheIdentity()).toBe('www.doctoralia.com.br|client-X');
    });
});
