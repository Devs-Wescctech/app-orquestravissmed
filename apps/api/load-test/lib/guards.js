'use strict';
/**
 * Proteções anti-produção do harness (WP-12A). O runner RECUSA iniciar se
 * qualquer verificação falhar. Estas funções são testadas em tests/guards.test.js.
 */

/** Hosts proibidos: qualquer domínio real da Doctoralia/VisMed. */
const FORBIDDEN_HOST_RE = /(doctoralia\.(com|com\.br|es|de|it|mx)|znanylekarz|docplanner|vissmed\.com\.br|app\.vissmed)/i;

/** Allowlist de hosts de banco de teste. */
const ALLOWED_DB_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * DATABASE_URL do processo sob teste precisa: (a) apontar para host loopback,
 * (b) ter nome de banco contendo "loadtest" (marcação explícita de teste).
 */
function assertSafeDatabaseUrl(databaseUrl) {
    if (!databaseUrl) throw new Error('[GUARD] DATABASE_URL de teste ausente');
    let u;
    try { u = new URL(databaseUrl); } catch { throw new Error(`[GUARD] DATABASE_URL inválida: ${databaseUrl}`); }
    const host = u.hostname;
    if (!ALLOWED_DB_HOSTS.has(host)) {
        throw new Error(`[GUARD] DATABASE_URL aponta para host fora da allowlist local: ${host}`);
    }
    const dbName = (u.pathname || '').replace(/^\//, '');
    if (!/loadtest/i.test(dbName)) {
        throw new Error(`[GUARD] Nome do banco não contém "loadtest" (marcação de teste obrigatória): ${dbName}`);
    }
    return true;
}

/** Env do processo sob teste não pode conter variáveis de produção. */
function assertNoProdEnv(env) {
    const banned = ['PROD_DATABASE_URL'];
    for (const k of banned) {
        if (env[k] !== undefined) {
            throw new Error(`[GUARD] Variável de produção presente no env do processo sob teste: ${k}`);
        }
    }
    return true;
}

/** Nenhuma IntegrationConnection do banco de teste pode apontar para domínio real. */
function assertConnectionsAreSafe(connections) {
    for (const conn of connections) {
        const domain = conn.domain || '';
        if (FORBIDDEN_HOST_RE.test(domain)) {
            throw new Error(`[GUARD] Conexão ${conn.provider} (clinic ${conn.clinicId}) aponta para domínio real: ${domain}`);
        }
        let host = domain.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
        if (host && !ALLOWED_DB_HOSTS.has(host)) {
            throw new Error(`[GUARD] Conexão ${conn.provider} (clinic ${conn.clinicId}) não aponta para loopback: ${host}`);
        }
    }
    return true;
}

/** Valida todas as proteções de uma vez; usada pelo runner antes de subir a API. */
function assertAllGuards({ databaseUrl, childEnv, connections }) {
    assertSafeDatabaseUrl(databaseUrl);
    assertNoProdEnv(childEnv);
    assertConnectionsAreSafe(connections);
    return true;
}

module.exports = { FORBIDDEN_HOST_RE, ALLOWED_DB_HOSTS, assertSafeDatabaseUrl, assertNoProdEnv, assertConnectionsAreSafe, assertAllGuards };
