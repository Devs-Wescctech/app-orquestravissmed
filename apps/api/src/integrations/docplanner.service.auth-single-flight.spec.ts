/**
 * Task 157 (WP-12B follow-up) — Single-flight do token OAuth Doctoralia.
 *
 * Garante exatamente 1 POST /oauth/v2/token por credencial sob qualquer
 * concorrência. Cobre a janela de corrida original: o await do token persistido
 * (banco) acontecia ANTES do registro do in-flight, deixando um gap entre o miss
 * do cache e o set da promessa compartilhada.
 *
 * Cenários:
 *   1. Duas autenticações simultâneas → 1 POST OAuth.
 *   2. Corrida via persistLoad lento (a janela original) → 1 POST OAuth.
 *   3. Dois forceRefresh simultâneos → 1 POST OAuth.
 *   4. Duas respostas 401 simultâneas (getToken(true)) → 1 refresh compartilhado.
 *   5. forceRefresh NÃO adere a in-flight não-fresh (persistLoad) — espera e faz POST novo.
 *   6. Erro no refresh limpa o single-flight; tentativa seguinte autentica normalmente.
 *   7. ClientIds/domínios diferentes permanecem isolados (chave domain|clientId).
 *   8. Sem deadlock: erro + retry concorrente resolvem.
 */

import { ConfigService } from '@nestjs/config';
import { DocplannerClient } from './docplanner.service';

const OAUTH_BODY = JSON.stringify({ access_token: 'fresh-token', expires_in: 3600 });

function oauthResponse(status = 200, body = OAUTH_BODY): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (_k: string) => null } as any,
        text: () => Promise.resolve(body),
        json: () => Promise.resolve(JSON.parse(body)),
    } as unknown as Response;
}

function buildClient(baseUrl = 'https://www.doctoralia.com.br'): DocplannerClient {
    const configService = { get: jest.fn() } as unknown as ConfigService;
    const client = new DocplannerClient(configService);
    client.setBaseUrl(baseUrl);
    return client;
}

/** Conta apenas os POSTs OAuth no mock de fetch. */
function countOauthPosts(fetchMock: jest.Mock): number {
    return fetchMock.mock.calls.filter(([url]) => String(url).includes('/oauth/v2/token')).length;
}

beforeEach(() => {
    (DocplannerClient as any).tokenCache = new Map();
    (DocplannerClient as any).inflightAuth = new Map();
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

describe('DocplannerClient — single-flight OAuth', () => {

    it('1. duas autenticações simultâneas para a mesma credencial → 1 POST OAuth', async () => {
        const a = buildClient();
        const b = buildClient();
        const fetchMock = jest.fn().mockResolvedValue(oauthResponse());
        global.fetch = fetchMock;

        const [t1, t2] = await Promise.all([
            a.authenticate('cid', 'secret'),
            b.authenticate('cid', 'secret'),
        ]);

        expect(countOauthPosts(fetchMock)).toBe(1);
        expect(t1).toBe('fresh-token');
        expect(t2).toBe('fresh-token');
    });

    it('2. janela original: persistLoad lento não abre gap — 1 POST OAuth', async () => {
        const a = buildClient();
        const b = buildClient();
        // persistLoad demora e não devolve token válido — era aqui que o segundo
        // chamador escapava do single-flight antes da correção.
        const slowLoad = jest.fn().mockImplementation(
            () => new Promise(resolve => setTimeout(() => resolve(null), 20)),
        );
        a.setPersistence(slowLoad, async () => { });
        b.setPersistence(slowLoad, async () => { });
        const fetchMock = jest.fn().mockResolvedValue(oauthResponse());
        global.fetch = fetchMock;

        const p1 = a.authenticate('cid', 'secret');
        // segundo chamador entra ENQUANTO o primeiro ainda espera o persistLoad
        await new Promise(r => setTimeout(r, 5));
        const p2 = b.authenticate('cid', 'secret');
        await Promise.all([p1, p2]);

        expect(countOauthPosts(fetchMock)).toBe(1);
        // persistLoad só precisa rodar uma vez (dentro do single-flight)
        expect(slowLoad).toHaveBeenCalledTimes(1);
    });

    it('3. dois forceRefresh simultâneos → 1 POST OAuth', async () => {
        const a = buildClient();
        const b = buildClient();
        const fetchMock = jest.fn().mockResolvedValue(oauthResponse());
        global.fetch = fetchMock;

        const [t1, t2] = await Promise.all([
            a.forceTokenRefresh('cid', 'secret'),
            b.forceTokenRefresh('cid', 'secret'),
        ]);

        expect(countOauthPosts(fetchMock)).toBe(1);
        expect(t1).toBe('fresh-token');
        expect(t2).toBe('fresh-token');
    });

    it('4. dois 401 simultâneos (getToken(true) direto) → 1 refresh compartilhado', async () => {
        const client = buildClient();
        (client as any).clientId = 'cid';
        (client as any).clientSecret = 'secret';
        // Simula token velho em cache (o que causou os 401)
        (DocplannerClient as any).tokenCache.set('www.doctoralia.com.br|cid', {
            token: 'stale', expiresAt: Date.now() + 60_000,
        });
        const fetchMock = jest.fn().mockResolvedValue(oauthResponse());
        global.fetch = fetchMock;

        const [t1, t2] = await Promise.all([
            (client as any).getToken(true),
            (client as any).getToken(true),
        ]);

        expect(countOauthPosts(fetchMock)).toBe(1);
        expect(t1).toBe('fresh-token');
        expect(t2).toBe('fresh-token');
    });

    it('5. forceRefresh não adere a in-flight não-fresh (persistLoad): espera e dispara POST novo', async () => {
        const a = buildClient();
        const b = buildClient();
        let releaseLoad: (v: any) => void = () => { };
        // persistLoad devolve um token persistido AINDA válido (o stale que causaria 401)
        a.setPersistence(
            () => new Promise(resolve => { releaseLoad = resolve; }),
            async () => { },
        );
        const fetchMock = jest.fn().mockResolvedValue(oauthResponse());
        global.fetch = fetchMock;

        // 1º chamador: auth normal, fica pendurado no persistLoad (in-flight não-fresh)
        const p1 = a.authenticate('cid', 'secret');
        await new Promise(r => setTimeout(r, 5));
        // 2º chamador: forceRefresh (ex.: pós-401) — NÃO pode aceitar o token persistido
        (b as any).clientId = 'cid';
        (b as any).clientSecret = 'secret';
        const p2 = (b as any).getToken(true);
        await new Promise(r => setTimeout(r, 5));
        releaseLoad({ token: 'stale-persisted', expiresAt: Date.now() + 60_000 });

        const [t1, t2] = await Promise.all([p1, p2]);
        expect(t1).toBe('stale-persisted');  // auth normal aceita o persistido
        expect(t2).toBe('fresh-token');       // forceRefresh obtém token NOVO
        expect(countOauthPosts(fetchMock)).toBe(1); // e apenas 1 POST no total
    });

    it('6. erro no refresh limpa o single-flight; tentativa seguinte autentica normalmente', async () => {
        const client = buildClient();
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(oauthResponse(500, 'boom'))
            .mockResolvedValue(oauthResponse());
        global.fetch = fetchMock;

        await expect(client.authenticate('cid', 'secret')).rejects.toThrow(/Failed to authenticate/);
        expect((DocplannerClient as any).inflightAuth.size).toBe(0);

        const token = await client.authenticate('cid', 'secret');
        expect(token).toBe('fresh-token');
        expect(countOauthPosts(fetchMock)).toBe(2);
    });

    it('7. credenciais distintas permanecem isoladas — 1 POST por chave domain|clientId', async () => {
        const a = buildClient();
        const b = buildClient();
        const fetchMock = jest.fn().mockResolvedValue(oauthResponse());
        global.fetch = fetchMock;

        await Promise.all([
            a.authenticate('cid-1', 'secret'),
            b.authenticate('cid-2', 'secret'),
        ]);

        expect(countOauthPosts(fetchMock)).toBe(2);
    });

    it('8. sem deadlock: erro no fetch + retries concorrentes resolvem', async () => {
        const a = buildClient();
        const b = buildClient();
        const fetchMock = jest.fn()
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValue(oauthResponse());
        global.fetch = fetchMock;

        // Ambos aderem ao mesmo in-flight que falha
        const r1 = await Promise.allSettled([
            a.authenticate('cid', 'secret'),
            b.authenticate('cid', 'secret'),
        ]);
        expect(r1.every(r => r.status === 'rejected')).toBe(true);
        expect(countOauthPosts(fetchMock)).toBe(1);

        // Recuperação: retries concorrentes compartilham 1 novo POST
        const [t1, t2] = await Promise.all([
            a.authenticate('cid', 'secret'),
            b.forceTokenRefresh('cid', 'secret'),
        ]);
        expect(t1).toBe('fresh-token');
        expect(t2).toBe('fresh-token');
        expect(countOauthPosts(fetchMock)).toBe(2);
        expect((DocplannerClient as any).inflightAuth.size).toBe(0);
    });
});
