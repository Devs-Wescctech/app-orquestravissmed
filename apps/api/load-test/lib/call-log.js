'use strict';
/**
 * Registro de chamadas recebidas pelos mocks: cada GET/WRITE com timestamp,
 * para auditoria de budget (400/5min agregado, WRITE 40/min e 2.400/h) e
 * detecção de escrita duplicada (mesmo método+path+corpo em janela curta).
 */
const crypto = require('node:crypto');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DUP_WINDOW_MS = 120_000; // escrita idêntica em <120s = duplicata suspeita

class CallLog {
    constructor(name) {
        this.name = name;
        this.calls = [];
        this.unmatched = [];
    }

    record({ method, path, body, matched, status, authHeader, correlationId, arrivedAt, faultTag }) {
        // authHeader entra no hash: escritas idênticas de CREDENCIAIS diferentes
        // (ex.: OAuth de duas clínicas) não são duplicatas.
        const hashInput = `${body ?? ''}|auth:${authHeader ?? ''}`;
        const bodyHash = (body && body.length) || authHeader
            ? crypto.createHash('sha1').update(hashInput).digest('hex') : null;
        const entry = {
            // WP-12C: ts = CHEGADA no mock (arrival), não o momento da resposta.
            ts: arrivedAt ?? Date.now(),
            method,
            path,
            isWrite: WRITE_METHODS.has(method),
            bodyHash,
            matched: matched !== false,
            status,
            correlationId: correlationId ?? null,
            faultTag: faultTag ?? null, // WP-13: tag da regra de falha injetada (null = resposta normal)
        };
        this.calls.push(entry);
        if (matched === false) this.unmatched.push({ method, path });
        return entry;
    }

    summary() {
        const total = this.calls.length;
        const writes = this.calls.filter(c => c.isWrite);
        const reads = total - writes.length;
        const byPathClass = {};
        for (const c of this.calls) {
            const cls = `${c.method} ${c.path.replace(/\/(LT|lt)-[A-Za-z0-9-]+/g, '/{id}').replace(/\d{4,}/g, '{n}').split('?')[0]}`;
            byPathClass[cls] = (byPathClass[cls] ?? 0) + 1;
        }
        return {
            mock: this.name,
            totalCalls: total,
            reads,
            writes: writes.length,
            duplicateWrites: this.findDuplicateWrites(),
            unmatchedPaths: [...new Set(this.unmatched.map(u => `${u.method} ${u.path.split('?')[0]}`))],
            byPathClass,
        };
    }

    /** Escritas com método+path+corpo idênticos dentro de DUP_WINDOW_MS. */
    findDuplicateWrites() {
        const seen = new Map();
        const dups = [];
        for (const c of this.calls) {
            if (!c.isWrite) continue;
            const key = `${c.method}|${c.path}|${c.bodyHash}`;
            const prev = seen.get(key);
            if (prev !== undefined && c.ts - prev <= DUP_WINDOW_MS) {
                dups.push({ method: c.method, path: c.path, deltaMs: c.ts - prev });
            }
            seen.set(key, c.ts);
        }
        return dups;
    }

    /** Auditoria de budget por janelas deslizantes sobre as chamadas recebidas. */
    budgetAudit({ aggregatePer5Min = 400, writesPerMin = 40, writesPerHour = 2400 } = {}) {
        const sorted = [...this.calls].sort((a, b) => a.ts - b.ts);
        const writeTs = sorted.filter(c => c.isWrite).map(c => c.ts);
        const allTs = sorted.map(c => c.ts);
        const maxInWindow = (tss, windowMs) => {
            let max = 0, lo = 0;
            for (let hi = 0; hi < tss.length; hi++) {
                while (tss[hi] - tss[lo] > windowMs) lo++;
                max = Math.max(max, hi - lo + 1);
            }
            return max;
        };
        const peakAgg5min = maxInWindow(allTs, 5 * 60_000);
        const peakWrites1min = maxInWindow(writeTs, 60_000);
        const peakWrites1h = maxInWindow(writeTs, 3_600_000);
        return {
            peakAgg5min, limitAgg5min: aggregatePer5Min, aggOk: peakAgg5min <= aggregatePer5Min,
            peakWrites1min, limitWrites1min: writesPerMin, writesMinOk: peakWrites1min <= writesPerMin,
            peakWrites1h, limitWrites1h: writesPerHour, writesHourOk: peakWrites1h <= writesPerHour,
        };
    }
}

module.exports = { CallLog, WRITE_METHODS, DUP_WINDOW_MS };
