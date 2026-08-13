'use strict';
/**
 * WP-13 — Fault injector determinístico do MockDoctoralia.
 *
 * Avaliado ANTES dos handlers do mock: um plano de falhas com regras por
 * método/endpoint e janela temporal RELATIVA ao instante em que o injector é
 * ARMADO (arm()), nunca ao relógio absoluto — o runner arma o injector no
 * início da fase de falha, tornando as janelas determinísticas por execução.
 *
 * Ações suportadas:
 *  - http429    — HTTP 429 (Retry-After configurável ou ausente)
 *  - http503    — HTTP 503
 *  - delay      — atrasa delayMs e segue para o handler normal (resposta 200 lenta)
 *  - timeout    — NUNCA responde (socket fica pendurado até o abort do cliente
 *                 ou até stop() destruir; nenhum socket sobrevive ao teardown)
 *  - reset      — destrói o socket imediatamente (ECONNRESET no cliente)
 *  - waf        — HTTP 405 + body no CONTRATO EXATO do classificador produtivo
 *                 (isWafChallenge: status 405 + /captcha|challenge|awswaf|human|verifica/i)
 *  - shortToken — só p/ OAuth: responde 200 normal com expires_in reduzido
 *                 (força refreshes frequentes p/ janelas WAF no OAuth)
 *
 * Regras suportam `modulo: {n, offset}` (falha determinística a cada n-ésima
 * requisição casada, contador por regra) p/ falha intermitente (F1-A).
 * Cada falha injetada é registrada no CallLog com `faultTag` da regra.
 * Código produtivo permanece intacto: tudo vive no mock/harness.
 */

const WAF_BODY = '<html><head><title>Verification required</title></head><body>' +
    'awswaf challenge: verifique que voce e humano — captcha (human verification)' +
    '</body></html>';

const ACTIONS = new Set(['http429', 'http503', 'delay', 'timeout', 'reset', 'waf', 'shortToken']);

class FaultInjector {
    /** @param {{rules: Array}} plan */
    constructor(plan) {
        this.rules = (plan?.rules ?? []).map((r, i) => {
            if (!ACTIONS.has(r.action)) throw new Error(`FaultInjector: ação desconhecida "${r.action}" (regra ${i})`);
            if (!(r.startMs >= 0) || !(r.endMs > r.startMs)) throw new Error(`FaultInjector: janela inválida na regra ${r.tag ?? i}`);
            return {
                tag: r.tag ?? `rule-${i}`,
                method: r.method ?? '*',
                pathRe: r.pathRe instanceof RegExp ? r.pathRe : new RegExp(r.pathRe),
                startMs: r.startMs,
                endMs: r.endMs,
                action: r.action,
                params: r.params ?? {},
                modulo: r.modulo ?? null,
                _counter: 0,
                _hits: 0,
            };
        });
        this.armedAt = null;       // wall clock do arm() — base das janelas
        this.pendingSockets = new Set(); // sockets pendurados pela ação timeout
        this.injected = [];        // trilha de auditoria: {ts, elapsedMs, tag, action, method, path}
    }

    /** Arma o injector: as janelas passam a contar a partir de agora. */
    arm(now = Date.now()) { this.armedAt = now; return this.armedAt; }

    /** ms desde o arm (null se desarmado). */
    elapsed(now = Date.now()) { return this.armedAt === null ? null : now - this.armedAt; }

    /**
     * Avalia as regras para uma requisição. Retorna a regra aplicável (primeira
     * que casa método+path+janela+modulo) ou null. Contadores de modulo só
     * avançam quando método+path+janela casam (determinístico por sequência).
     */
    evaluate(method, path, now = Date.now()) {
        if (this.armedAt === null) return null;
        const el = now - this.armedAt;
        for (const r of this.rules) {
            if (r.method !== '*' && r.method !== method) continue;
            if (!r.pathRe.test(path)) continue;
            if (el < r.startMs || el >= r.endMs) continue;
            if (r.modulo) {
                const idx = r._counter++;
                if (idx % r.modulo.n !== r.modulo.offset) continue;
            }
            r._hits++;
            this.injected.push({ ts: now, elapsedMs: el, tag: r.tag, action: r.action, method, path });
            return r;
        }
        return null;
    }

    /** Segura o socket da ação timeout; removido quando o cliente aborta/fecha. */
    holdSocket(res) {
        const socket = res.socket;
        if (!socket) return;
        this.pendingSockets.add(socket);
        socket.once('close', () => this.pendingSockets.delete(socket));
    }

    /** Teardown: destrói qualquer socket ainda pendurado (nenhum sobrevive). */
    stop() {
        for (const s of this.pendingSockets) { try { s.destroy(); } catch { /* já fechado */ } }
        this.pendingSockets.clear();
    }

    summary() {
        return this.rules.map(r => ({ tag: r.tag, action: r.action, startMs: r.startMs, endMs: r.endMs, hits: r._hits }));
    }
}

module.exports = { FaultInjector, WAF_BODY };
