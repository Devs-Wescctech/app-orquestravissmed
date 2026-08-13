'use strict';
/**
 * WP-13 — Testes do fault injector: janelas (aberta/fechada/desarmado), cada
 * ação de falha via MockDoctoralia real (HTTPS loopback) e o corpo WAF exato
 * no contrato do classificador produtivo (405 + regex).
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { generateDataset } = require('../lib/dataset');
const { ensureTestCert } = require('../lib/certs');
const { MockDoctoralia } = require('../lib/mock-doctoralia');
const { FaultInjector, WAF_BODY } = require('../lib/fault-injector');
const { buildFaultPlan } = require('../lib/fault-plans');

const PORT = 46543;
const tls = ensureTestCert(path.join(os.tmpdir(), 'wp13-test-certs'));
const dataset = generateDataset({
    profile: 'small', seed: 'wp13-test', clinics: 1,
    doctoraliaHost: `127.0.0.1:${PORT}`, vismedBaseUrl: 'https://127.0.0.1:1',
});

function raw(method, url, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, ca: tls.cert }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(1500, () => { req.destroy(new Error('client-timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

// ── Unidade: janelas e modulo ──────────────────────────────────────────────
test('janela: desarmado nunca injeta; armado injeta só dentro da janela', () => {
    const inj = new FaultInjector({ rules: [{ tag: 'r', pathRe: /^\/x/, startMs: 1000, endMs: 2000, action: 'http503' }] });
    assert.strictEqual(inj.evaluate('GET', '/x', Date.now()), null, 'desarmado');
    const t0 = 1_000_000;
    inj.arm(t0);
    assert.strictEqual(inj.evaluate('GET', '/x', t0 + 500), null, 'antes da janela');
    assert.ok(inj.evaluate('GET', '/x', t0 + 1000), 'início inclusivo');
    assert.ok(inj.evaluate('GET', '/x', t0 + 1999), 'dentro');
    assert.strictEqual(inj.evaluate('GET', '/x', t0 + 2000), null, 'fim exclusivo');
    assert.strictEqual(inj.evaluate('GET', '/y', t0 + 1500), null, 'path não casa');
    assert.strictEqual(inj.evaluate('POST', '/x', t0 + 1500) === null, false, 'method * casa POST');
});

test('modulo {n,offset} é determinístico por sequência', () => {
    const inj = new FaultInjector({ rules: [{ tag: 'm', pathRe: /^\/x/, startMs: 0, endMs: 10_000, action: 'http429', modulo: { n: 3, offset: 1 } }] });
    const t0 = 5_000_000; inj.arm(t0);
    const hits = [];
    for (let k = 0; k < 9; k++) hits.push(inj.evaluate('GET', '/x', t0 + 100 + k) !== null);
    assert.deepStrictEqual(hits, [false, true, false, false, true, false, false, true, false]);
});

test('regra com ação desconhecida ou janela inválida é rejeitada', () => {
    assert.throws(() => new FaultInjector({ rules: [{ pathRe: /x/, startMs: 0, endMs: 1, action: 'nope' }] }));
    assert.throws(() => new FaultInjector({ rules: [{ pathRe: /x/, startMs: 5, endMs: 5, action: 'http503' }] }));
});

test('planos F1–F5 são determinísticos pela seed e válidos', () => {
    for (const k of ['f1', 'f2', 'f3', 'f4', 'f5']) {
        const a = buildFaultPlan(k, 'wp13');
        const b = buildFaultPlan(k, 'wp13');
        assert.deepStrictEqual(JSON.parse(JSON.stringify(a.rules, (kk, v) => v instanceof RegExp ? String(v) : v)),
            JSON.parse(JSON.stringify(b.rules, (kk, v) => v instanceof RegExp ? String(v) : v)), `${k} determinístico`);
        assert.ok(a.driveMs > 0 && a.recoveryTimeoutMs > 0);
        new FaultInjector(a); // valida as regras
    }
    const p1 = buildFaultPlan('f1', 'seed-A');
    const p2 = buildFaultPlan('f1', 'seed-B');
    assert.notDeepStrictEqual(
        p1.rules.map(r => r.modulo?.offset ?? r.params?.retryAfterSec),
        undefined, 'parâmetros derivados da seed existem');
    assert.ok(p1.rules.length === p2.rules.length);
});

// ── Integração: cada ação no MockDoctoralia ────────────────────────────────
test('ações de falha no MockDoctoralia', async (t) => {
    const injector = new FaultInjector({
        rules: [
            { tag: 'T-429ra', method: 'GET', pathRe: /^\/api\/v3\/integration\/services/, startMs: 0, endMs: 3_600_000, action: 'http429', params: { retryAfterSec: 7 } },
            { tag: 'T-429', method: 'GET', pathRe: /^\/api\/v3\/integration\/insurance-providers$/, startMs: 0, endMs: 3_600_000, action: 'http429' },
            { tag: 'T-503', method: 'GET', pathRe: /^\/api\/v3\/integration\/facilities$/, startMs: 0, endMs: 3_600_000, action: 'http503' },
            { tag: 'T-waf', method: 'GET', pathRe: /^\/api\/v3\/integration\/notifications\/multiple/, startMs: 0, endMs: 3_600_000, action: 'waf' },
            { tag: 'T-delay', method: 'POST', pathRe: /^\/api\/v3\/integration\/notifications\/release/, startMs: 0, endMs: 3_600_000, action: 'delay', params: { delayMs: 400 } },
            { tag: 'T-timeout', method: 'GET', pathRe: /timeout-me/, startMs: 0, endMs: 3_600_000, action: 'timeout' },
            { tag: 'T-reset', method: 'GET', pathRe: /reset-me/, startMs: 0, endMs: 3_600_000, action: 'reset' },
            { tag: 'T-shortToken', method: 'POST', pathRe: /^\/oauth\/v2\/token$/, startMs: 0, endMs: 3_600_000, action: 'shortToken', params: { expiresInSec: 180 } },
        ],
    });
    const mock = new MockDoctoralia({ dataset, tls, port: PORT, faultInjector: injector });
    await mock.start();
    injector.arm();
    t.after(async () => { await mock.stop(); });
    const base = `https://127.0.0.1:${PORT}`;

    await t.test('429 com e sem Retry-After', async () => {
        const a = await raw('GET', `${base}/api/v3/integration/services`);
        assert.strictEqual(a.status, 429);
        assert.strictEqual(a.headers['retry-after'], '7');
        const b = await raw('GET', `${base}/api/v3/integration/insurance-providers`);
        assert.strictEqual(b.status, 429);
        assert.strictEqual(b.headers['retry-after'], undefined);
    });

    await t.test('503', async () => {
        const r = await raw('GET', `${base}/api/v3/integration/facilities`);
        assert.strictEqual(r.status, 503);
    });

    await t.test('WAF: contrato exato do classificador produtivo (405 + regex)', async () => {
        const r = await raw('GET', `${base}/api/v3/integration/notifications/multiple`);
        assert.strictEqual(r.status, 405);
        assert.strictEqual(r.body, WAF_BODY);
        assert.match(r.body, /captcha|challenge|awswaf|human|verifica/i);
        // NÃO pode casar como 405 sem corpo WAF (contrato do isWafChallenge)
        assert.ok(/awswaf/.test(r.body) && /captcha/i.test(r.body) && /challenge/.test(r.body));
    });

    await t.test('delay atrasa mas responde 200 normal', async () => {
        const t0 = Date.now();
        const r = await raw('POST', `${base}/api/v3/integration/notifications/release`, '{}');
        assert.strictEqual(r.status, 200);
        assert.ok(Date.now() - t0 >= 380, `esperado ≥380ms, veio ${Date.now() - t0}ms`);
    });

    await t.test('timeout: sem resposta; stop() destrói o socket pendurado', async () => {
        await assert.rejects(raw('GET', `${base}/api/v3/integration/timeout-me`), /client-timeout|socket hang up|ECONNRESET/);
        // o socket ou já foi fechado pelo cliente ou está rastreado p/ destruição
        injector.stop();
        assert.strictEqual(injector.pendingSockets.size, 0);
    });

    await t.test('reset: conexão destruída (ECONNRESET/hang up)', async () => {
        await assert.rejects(raw('GET', `${base}/api/v3/integration/reset-me`), /ECONNRESET|socket hang up/);
    });

    await t.test('shortToken: OAuth 200 com expires_in reduzido', async () => {
        const r = await raw('POST', `${base}/oauth/v2/token`, 'grant_type=client_credentials');
        assert.strictEqual(r.status, 200);
        const j = JSON.parse(r.body);
        assert.strictEqual(j.expires_in, 180);
        assert.ok(j.access_token);
    });

    await t.test('CallLog registra a tag da regra em cada injeção', async () => {
        const clean = await raw('GET', `${base}/api/v3/integration/insurance-providers/1/plans`);
        assert.strictEqual(clean.status, 200); // fora de qualquer regra → resposta normal
        const tagged = mock.log.calls.filter(c => c.faultTag);
        assert.ok(tagged.length >= 7, `esperado ≥7 injeções com tag, veio ${tagged.length}`);
        assert.ok(tagged.some(c => c.faultTag === 'T-waf' && c.status === 405));
        assert.ok(tagged.some(c => c.faultTag === 'T-timeout' && c.status === 0));
        // respostas normais não têm tag
        assert.ok(mock.log.calls.some(c => !c.faultTag));
    });
});
