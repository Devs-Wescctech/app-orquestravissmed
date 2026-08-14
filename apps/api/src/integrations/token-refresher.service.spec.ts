/**
 * Task 169 — Kill switch test-only DISABLE_TOKEN_REFRESHER.
 *
 * Garante que:
 *   1. Com a flag, refreshAll() vira no-op: nenhuma leitura de conexões,
 *      nenhum cliente criado, nenhum OAuth disparado.
 *   2. Sem a flag (ou 'false'), comportamento atual preservado: tokens dentro
 *      da margem de renovação são renovados (forceRefresh se ainda válido,
 *      authenticate se expirado) e tokens saudáveis são pulados.
 *
 * A autenticação sob demanda (getToken/single-flight/401) NÃO passa por este
 * serviço — está coberta em docplanner.service.auth-single-flight.spec.ts.
 */

import { TokenRefresherService } from './token-refresher.service';

function buildDeps(conns: any[]) {
    const prisma = {
        integrationConnection: { findMany: jest.fn().mockResolvedValue(conns) },
    } as any;
    const client = {
        authenticate: jest.fn().mockResolvedValue('tok'),
        forceTokenRefresh: jest.fn().mockResolvedValue('tok'),
    };
    const docplanner = { createClient: jest.fn().mockReturnValue(client) } as any;
    return { prisma, docplanner, client };
}

const HOUR = 60 * 60 * 1000;

describe('TokenRefresherService — DISABLE_TOKEN_REFRESHER', () => {
    const origEnv = process.env.DISABLE_TOKEN_REFRESHER;
    afterEach(() => {
        if (origEnv === undefined) delete process.env.DISABLE_TOKEN_REFRESHER;
        else process.env.DISABLE_TOKEN_REFRESHER = origEnv;
    });

    it('com a flag: refreshAll é no-op (nenhuma query, nenhum OAuth)', async () => {
        process.env.DISABLE_TOKEN_REFRESHER = 'true';
        const { prisma, docplanner, client } = buildDeps([
            { id: '1', clientId: 'cid', clientSecret: 's', domain: null, tokenExpiresAt: new Date(Date.now() + HOUR) },
        ]);
        const svc = new TokenRefresherService(prisma, docplanner);
        svc.onModuleInit(); // não deve lançar
        await svc.refreshAll();
        expect(prisma.integrationConnection.findMany).not.toHaveBeenCalled();
        expect(docplanner.createClient).not.toHaveBeenCalled();
        expect(client.authenticate).not.toHaveBeenCalled();
        expect(client.forceTokenRefresh).not.toHaveBeenCalled();
    });

    it("flag 'false' equivale a ausente: comportamento atual preservado", async () => {
        process.env.DISABLE_TOKEN_REFRESHER = 'false';
        const { prisma, docplanner, client } = buildDeps([
            // Dentro da margem de 2h, ainda válido → forceTokenRefresh
            { id: '1', clientId: 'cid1', clientSecret: 's', domain: null, tokenExpiresAt: new Date(Date.now() + HOUR) },
        ]);
        const svc = new TokenRefresherService(prisma, docplanner);
        await svc.refreshAll();
        expect(prisma.integrationConnection.findMany).toHaveBeenCalledTimes(1);
        expect(client.forceTokenRefresh).toHaveBeenCalledTimes(1);
        expect(client.authenticate).not.toHaveBeenCalled();
    });

    it('sem a flag: expirado → authenticate; saudável → pulado; dedup por clientId', async () => {
        delete process.env.DISABLE_TOKEN_REFRESHER;
        const { prisma, docplanner, client } = buildDeps([
            // Expirado → authenticate
            { id: '1', clientId: 'cid1', clientSecret: 's', domain: null, tokenExpiresAt: new Date(Date.now() - HOUR) },
            // Mesmo clientId → deduplicado (nenhuma chamada extra)
            { id: '2', clientId: 'cid1', clientSecret: 's', domain: null, tokenExpiresAt: new Date(Date.now() - HOUR) },
            // Saudável (>2h de margem) → pulado
            { id: '3', clientId: 'cid2', clientSecret: 's', domain: null, tokenExpiresAt: new Date(Date.now() + 5 * HOUR) },
        ]);
        const svc = new TokenRefresherService(prisma, docplanner);
        await svc.refreshAll();
        expect(client.authenticate).toHaveBeenCalledTimes(1);
        expect(client.forceTokenRefresh).not.toHaveBeenCalled();
        expect(docplanner.createClient).toHaveBeenCalledTimes(1);
    });
});
