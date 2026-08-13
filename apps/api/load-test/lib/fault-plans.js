'use strict';
/**
 * WP-13 — Planos de falha determinísticos F1–F5.
 *
 * Todos os tempos são RELATIVOS ao arm() do FaultInjector (o runner arma após
 * a janela saudável T0). Valores paramétricos (Retry-After, offsets do modulo)
 * são derivados da seed via mulberry32 — mesma seed ⇒ mesmo plano.
 *
 * Constantes produtivas relevantes (NUNCA alteradas — só referenciadas):
 *  - WP-07: 3 tentativas HTTP/operação, backoff full-jitter base 1s cap 30s,
 *    Retry-After respeitado (429), timeout AbortController 30s.
 *  - WP-08A: threshold 5 operações lógicas, cooldown inicial 60s (progressivo
 *    ×2, teto 10min), WAF (405+captcha) abre em 1 resposta com cooldown ≥5min.
 *  - WP-08B: fila HIGH cap 50/deadline 15s, LOW deadline ~61s; QueueFull/
 *    QueueTimeout non-retryable e não alimentam o breaker.
 */
const { makeRng } = require('./rng');

const API_RE = /^\/api\/v3\/integration\//;
const API_GET_RE = API_RE; // usado com method:'GET'
const OAUTH_RE = /^\/oauth\/v2\/token$/;

function rngFor(seed, salt) {
    const r = makeRng(`${seed}|wp13|${salt}`);
    return r.float;
}

/** @returns plano { key, title, rules, driveMs, recoveryTimeoutMs, expected, notes } */
function buildFaultPlan(key, seed) {
    const rnd = rngFor(seed, key);
    switch (key) {
        case 'f1': {
            // F1-A (0–60s): 429 intermitente ~1/3 das reqs (metade com Retry-After,
            // metade sem) — abaixo do threshold: com 3 tentativas/op, a operação
            // sucede no retry ⇒ breaker permanece CLOSED (valida WP-07 e budgets).
            // Gap saudável 60–90s. F1-B (90–210s): 429 sustentado em TODAS as reqs
            // ⇒ 5 operações exauridas ⇒ breaker abre legitimamente.
            const offA = Math.floor(rnd() * 3);          // offset determinístico da seed
            const retryAfterA = 1 + Math.floor(rnd() * 2); // 1–2s
            return {
                key, title: 'F1 — 429 intermitente (A) e sustentado (B)',
                rules: [
                    { tag: 'F1A-429-com-retry-after', method: '*', pathRe: API_RE, startMs: 0, endMs: 60_000, action: 'http429', modulo: { n: 6, offset: offA }, params: { retryAfterSec: retryAfterA } },
                    { tag: 'F1A-429-sem-retry-after', method: '*', pathRe: API_RE, startMs: 0, endMs: 60_000, action: 'http429', modulo: { n: 6, offset: (offA + 3) % 6 }, params: {} },
                    { tag: 'F1B-429-sustentado', method: '*', pathRe: API_RE, startMs: 90_000, endMs: 210_000, action: 'http429', params: { retryAfterSec: 1 } },
                ],
                subWindows: { f1a: { startMs: 0, endMs: 60_000 }, f1b: { startMs: 90_000, endMs: 210_000 } },
                driveMs: 240_000,
                recoveryTimeoutMs: 6 * 60_000,
                expected: {
                    breakerOpens: true,
                    // Nenhuma abertura antes do início do F1-B (com folga de amostragem)
                    noOpenBeforeMs: 88_000,
                    reopenDoubled: false,
                    queuePressureExpected: false,
                },
            };
        }
        case 'f2': {
            // 503 sustentado 0–150s: breaker abre (~5 ops exauridas), cooldown 60s,
            // 1ª probe (~open+60s) ainda dentro da janela ⇒ FALHA ⇒ reabre com
            // cooldown DOBRADO (120s); 2ª probe já com mock saudável ⇒ CLOSED.
            return {
                key, title: 'F2 — 503 sustentado com falha da 1ª probe (cooldown progressivo)',
                rules: [
                    { tag: 'F2-503', method: '*', pathRe: API_RE, startMs: 0, endMs: 150_000, action: 'http503', params: {} },
                ],
                driveMs: 160_000,
                recoveryTimeoutMs: 8 * 60_000,
                expected: { breakerOpens: true, reopenDoubled: true, queuePressureExpected: false },
            };
        }
        case 'f3': {
            // Timeout (>30s, sem resposta) 0–180s: AbortController dispara a 30s,
            // op = 3 tentativas (~95s) ⇒ 5 ops exauridas abrem o breaker; janela
            // termina antes da probe ⇒ recuperação. Sockets pendurados morrem com
            // o abort do cliente (nenhum sobrevive ao teardown).
            return {
                key, title: 'F3 — timeout >30s (sem resposta)',
                rules: [
                    { tag: 'F3-timeout', method: 'GET', pathRe: API_GET_RE, startMs: 0, endMs: 180_000, action: 'timeout', params: {} },
                ],
                driveMs: 200_000,
                recoveryTimeoutMs: 10 * 60_000,
                // Retries WP-07 de operações admitidas ANTES do OPEN podem despachar
                // por até ~35s (timeout 30s + backoff) após a abertura.
                inflightGraceMs: 40_000,
                expected: { breakerOpens: true, reopenDoubled: false, queuePressureExpected: false },
            };
        }
        case 'f4': {
            // Duas janelas WAF no MESMO cenário:
            //  - F4-A (0–20s): WAF em GET comum ⇒ abre em 1 resposta, cooldown ≥5min.
            //  - F4-B (480–660s): WAF no OAuth (tokens com TTL curto via shortToken
            //    forçam refresh dentro da janela) ⇒ tripWafChallenge ⇒ abre de novo.
            // Probe pós-cooldown fecha em ambos os casos.
            return {
                key, title: 'F4 — WAF (405+captcha) em GET comum e no OAuth',
                rules: [
                    { tag: 'F4B-waf-oauth', method: 'POST', pathRe: OAUTH_RE, startMs: 480_000, endMs: 660_000, action: 'waf', params: {} },
                    { tag: 'F4-short-token', method: 'POST', pathRe: OAUTH_RE, startMs: 0, endMs: 3_600_000, action: 'shortToken', params: { expiresInSec: 180 } },
                    { tag: 'F4A-waf-get', method: 'GET', pathRe: API_GET_RE, startMs: 0, endMs: 20_000, action: 'waf', params: {} },
                ],
                wafWindows: [
                    { tag: 'F4A-waf-get', startMs: 0, endMs: 20_000 },
                    { tag: 'F4B-waf-oauth', startMs: 480_000, endMs: 660_000 },
                ],
                driveMs: 700_000,
                recoveryTimeoutMs: 12 * 60_000,
                expected: {
                    breakerOpens: true, isWaf: true, minOpens: 2,
                    wafCooldownMinMs: 290_000, // ≥5min (folga de amostragem)
                    reopenDoubled: false, queuePressureExpected: false,
                },
            };
        }
        case 'f5': {
            // API lenta SEM erro: delay 12s (<30s ⇒ sem abort) em todos os GETs por
            // 120s ⇒ vazão despenca, filas HIGH/LOW crescem, deadlines disparam
            // QueueFull/QueueTimeout (WP-08B) — que NÃO alimentam o breaker, não
            // são retryable e não marcam a integração como error. Depois drena.
            const delayMs = 11_000 + Math.floor(rnd() * 2_000); // 11–13s determinístico
            return {
                key, title: 'F5 — API lenta sem erro (backpressure WP-08B)',
                rules: [
                    { tag: 'F5-lenta', method: 'GET', pathRe: API_GET_RE, startMs: 0, endMs: 120_000, action: 'delay', params: { delayMs } },
                ],
                driveMs: 150_000,
                recoveryTimeoutMs: 8 * 60_000,
                expected: { breakerOpens: false, queuePressureExpected: true },
            };
        }
        default:
            throw new Error(`Plano de falha desconhecido: ${key}`);
    }
}

module.exports = { buildFaultPlan, API_RE, OAUTH_RE };
