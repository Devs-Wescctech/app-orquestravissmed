'use strict';
/**
 * WP-12C — Análise grant × dispatch × arrival.
 *
 * Correlaciona os eventos internos da API (releasedAt = grant do limiter,
 * sentAt = dispatch imediatamente antes do fetch) com as chegadas no mock
 * Doctoralia (arrival), via header x-loadtest-correlation-id.
 *
 * Calcula, com o MESMO algoritmo de janela deslizante da auditoria do mock
 * (call-log.budgetAudit), os máximos por série:
 *   - WRITE/60s:  maxGrantsInRollingMinute / maxDispatchesInRollingMinute / maxArrivalsInRollingMinute
 *   - agregado/5min: maxGrantsInRolling5Min / maxDispatchesInRolling5Min / maxArrivalsInRolling5Min
 * e as distribuições dos deltas grant→dispatch e dispatch→arrival.
 *
 * Estritamente aditivo/informativo: não altera critérios PASS/FAIL nem budgets.
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function dist(values) {
    if (!values.length) return { count: 0, min: null, p50: null, p95: null, p99: null, max: null };
    const s = [...values].sort((a, b) => a - b);
    const pct = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
    return { count: s.length, min: s[0], p50: pct(50), p95: pct(95), p99: pct(99), max: s[s.length - 1] };
}

/**
 * Janela deslizante com semântica de fronteira EXPLÍCITA:
 *
 *  - boundary='inclusive' — MESMO algoritmo do call-log.budgetAudit do mock:
 *    eviction quando delta > windowMs, ou seja, dois eventos separados por
 *    EXATAMENTE windowMs contam na mesma janela (intervalo fechado).
 *  - boundary='strict' — semântica do limiter produtivo (eviction `<= now-window`,
 *    contagem `t > cutoff`): eviction quando delta >= windowMs, ou seja, um
 *    evento exatamente windowMs mais velho já está FORA da janela.
 *
 * A divergência importa: um pico "inclusivo" pode conter eventos exatamente na
 * fronteira que o limiter, corretamente pela sua própria definição, já expirou.
 * `items` deve estar ordenado por .ts ascendente.
 */
function maxInRollingWindow(items, windowMs, boundary = 'inclusive') {
    const evict = boundary === 'strict'
        ? (delta) => delta >= windowMs
        : (delta) => delta > windowMs;
    let max = 0, lo = 0, bestLo = 0, bestHi = -1;
    for (let hi = 0; hi < items.length; hi++) {
        while (evict(items[hi].ts - items[lo].ts)) lo++;
        const size = hi - lo + 1;
        if (size > max) { max = size; bestLo = lo; bestHi = hi; }
    }
    const windowItems = bestHi >= 0 ? items.slice(bestLo, bestHi + 1) : [];
    return {
        max,
        windowStart: windowItems[0]?.ts ?? null,
        windowEnd: windowItems[windowItems.length - 1]?.ts ?? null,
        requests: windowItems,
    };
}

function describe(r) {
    return {
        ts: r.ts,
        iso: new Date(r.ts).toISOString(),
        method: r.method,
        operation: r.operation ?? null,
        path: r.path ?? r.endpoint ?? null,
        correlationId: r.correlationId ?? null,
    };
}

/**
 * @param {object} args
 * @param {Array} args.internalEvents — eventos brutos da API (DoctoraliaRequestEvent[])
 * @param {Array} args.mockCalls — entradas do CallLog do mock Doctoralia (com correlationId)
 * @param {object} [args.limits]
 */
function analyzeGrantDispatchArrival({ internalEvents, mockCalls, limits = {} }) {
    const { writesPerMin = 40, aggregatePer5Min = 400 } = limits;

    // ── Séries por evento interno (grant/dispatch) ──────────────────────────
    const internal = internalEvents.map(e => ({
        correlationId: e.doctoraliaRequestId,
        method: e.method,
        operation: e.operation,
        endpoint: e.endpoint,
        isWrite: WRITE_METHODS.has(e.method),
        grantTs: e.releasedAt,
        dispatchTs: e.sentAt,
    }));

    // ── Chegadas do mock (arrival) ───────────────────────────────────────────
    const arrivals = mockCalls.map(c => ({
        correlationId: c.correlationId,
        method: c.method,
        path: c.path,
        isWrite: WRITE_METHODS.has(c.method),
        ts: c.ts,
    }));

    // ── Correlação por id ────────────────────────────────────────────────────
    const byCorrelation = new Map();
    for (const a of arrivals) if (a.correlationId) byCorrelation.set(a.correlationId, a);
    const correlated = [];
    const internalWithoutArrival = [];
    for (const i of internal) {
        const a = byCorrelation.get(i.correlationId);
        if (a) {
            correlated.push({
                correlationId: i.correlationId,
                method: i.method,
                operation: i.operation,
                path: a.path,
                isWrite: i.isWrite,
                grantTs: i.grantTs,
                dispatchTs: i.dispatchTs,
                arrivalTs: a.ts,
                grantToDispatchMs: i.dispatchTs - i.grantTs,
                dispatchToArrivalMs: a.ts - i.dispatchTs,
            });
            byCorrelation.delete(i.correlationId);
        } else {
            internalWithoutArrival.push(i);
        }
    }
    const arrivalsWithoutInternal = [...byCorrelation.values()]
        .concat(arrivals.filter(a => !a.correlationId));

    // ── Máximos por série (mesmo algoritmo do mock) ─────────────────────────
    const sortBy = (arr, key) => [...arr].sort((x, y) => x[key] - y[key]);
    const seriesOf = (arr, key, filter) => sortBy(arr.filter(filter), key)
        .map(r => ({ ...describe({ ...r, ts: r[key] }), ts: r[key] }));

    const grantWrites = seriesOf(internal.map(i => ({ ...i, path: i.endpoint })), 'grantTs', r => r.isWrite);
    const dispatchWrites = seriesOf(internal.map(i => ({ ...i, path: i.endpoint })), 'dispatchTs', r => r.isWrite);
    const arrivalWrites = seriesOf(arrivals, 'ts', r => r.isWrite);
    const grantAll = seriesOf(internal.map(i => ({ ...i, path: i.endpoint })), 'grantTs', () => true);
    const dispatchAll = seriesOf(internal.map(i => ({ ...i, path: i.endpoint })), 'dispatchTs', () => true);
    const arrivalAll = seriesOf(arrivals, 'ts', () => true);

    const win = (items, ms) => {
        const r = maxInRollingWindow(items, ms, 'inclusive'); // semântica do mock/auditoria
        const s = maxInRollingWindow(items, ms, 'strict');    // semântica do limiter
        return {
            max: r.max,               // inclusivo (mesma da auditoria do mock)
            maxStrict: s.max,         // estrito (mesma do limiter produtivo)
            windowStartIso: r.windowStart ? new Date(r.windowStart).toISOString() : null,
            windowEndIso: r.windowEnd ? new Date(r.windowEnd).toISOString() : null,
            windowSpanMs: r.windowStart != null ? r.windowEnd - r.windowStart : null,
            strictWindowStartIso: s.windowStart ? new Date(s.windowStart).toISOString() : null,
            strictWindowEndIso: s.windowEnd ? new Date(s.windowEnd).toISOString() : null,
            strictWindowSpanMs: s.windowStart != null ? s.windowEnd - s.windowStart : null,
            requests: r.requests.map(describe),
            strictRequests: s.requests.map(describe),
        };
    };

    const MIN = 60_000, FIVE = 5 * 60_000;
    const writeMinute = {
        maxGrantsInRollingMinute: win(grantWrites, MIN),
        maxDispatchesInRollingMinute: win(dispatchWrites, MIN),
        maxArrivalsInRollingMinute: win(arrivalWrites, MIN),
        limit: writesPerMin,
    };
    const aggregate5Min = {
        maxGrantsInRolling5Min: win(grantAll, FIVE),
        maxDispatchesInRolling5Min: win(dispatchAll, FIVE),
        maxArrivalsInRolling5Min: win(arrivalAll, FIVE),
        limit: aggregatePer5Min,
    };

    // ── Deltas ───────────────────────────────────────────────────────────────
    const deltas = {
        grantToDispatchMs: dist(correlated.map(c => c.grantToDispatchMs)),
        dispatchToArrivalMs: dist(correlated.map(c => c.dispatchToArrivalMs)),
        writeOnly: {
            grantToDispatchMs: dist(correlated.filter(c => c.isWrite).map(c => c.grantToDispatchMs)),
            dispatchToArrivalMs: dist(correlated.filter(c => c.isWrite).map(c => c.dispatchToArrivalMs)),
        },
    };

    // ── Hipótese de compressão temporal ─────────────────────────────────────
    // Avaliada nas DUAS semânticas de fronteira. A avaliação "strict" é a mais
    // fiel à hipótese da #151: usa a mesma definição de janela do limiter para
    // grants/dispatches (o limiter não pode ser acusado de exceder um limite
    // medido com semântica diferente da dele) e a mesma para arrivals.
    const gMax = writeMinute.maxGrantsInRollingMinute.max;
    const dMax = writeMinute.maxDispatchesInRollingMinute.max;
    const aMax = writeMinute.maxArrivalsInRollingMinute.max;
    const compressionConfirmedWrite = gMax <= writesPerMin && dMax <= writesPerMin && aMax > writesPerMin;
    const gMax5 = aggregate5Min.maxGrantsInRolling5Min.max;
    const dMax5 = aggregate5Min.maxDispatchesInRolling5Min.max;
    const aMax5 = aggregate5Min.maxArrivalsInRolling5Min.max;
    const compressionConfirmedAggregate = gMax5 <= aggregatePer5Min && dMax5 <= aggregatePer5Min && aMax5 > aggregatePer5Min;
    const gS = writeMinute.maxGrantsInRollingMinute.maxStrict;
    const dS = writeMinute.maxDispatchesInRollingMinute.maxStrict;
    const aS = writeMinute.maxArrivalsInRollingMinute.maxStrict;
    const compressionConfirmedWriteStrict = gS <= writesPerMin && dS <= writesPerMin && aS > writesPerMin;
    const gS5 = aggregate5Min.maxGrantsInRolling5Min.maxStrict;
    const dS5 = aggregate5Min.maxDispatchesInRolling5Min.maxStrict;
    const aS5 = aggregate5Min.maxArrivalsInRolling5Min.maxStrict;
    const compressionConfirmedAggregateStrict = gS5 <= aggregatePer5Min && dS5 <= aggregatePer5Min && aS5 > aggregatePer5Min;

    return {
        correlation: {
            internalEvents: internal.length,
            mockArrivals: arrivals.length,
            correlated: correlated.length,
            internalWithoutArrival: internalWithoutArrival.length,
            arrivalsWithoutCorrelationId: arrivals.filter(a => !a.correlationId).length,
            arrivalsWithoutInternal: arrivalsWithoutInternal.length,
        },
        writeMinute,
        aggregate5Min,
        deltas,
        hypothesis: {
            // Semântica inclusiva (auditoria do mock): delta == janela conta na mesma janela
            compressionConfirmedWrite,
            compressionConfirmedAggregate,
            // Semântica estrita (limiter produtivo): delta == janela já está fora
            compressionConfirmedWriteStrict,
            compressionConfirmedAggregateStrict,
            boundarySemanticsNote: 'inclusive = algoritmo da auditoria do mock (delta > janela expira); strict = semântica do limiter produtivo (delta >= janela expira). Divergem apenas em eventos exatamente na fronteira da janela.',
            summary: {
                writePerMinute: { grants: gMax, dispatches: dMax, arrivals: aMax, grantsStrict: gS, dispatchesStrict: dS, arrivalsStrict: aS, limit: writesPerMin },
                aggregatePer5Min: { grants: gMax5, dispatches: dMax5, arrivals: aMax5, grantsStrict: gS5, dispatchesStrict: dS5, arrivalsStrict: aS5, limit: aggregatePer5Min },
            },
        },
        correlatedRequests: correlated, // dump completo p/ NDJSON
    };
}

module.exports = { analyzeGrantDispatchArrival, maxInRollingWindow, dist };
