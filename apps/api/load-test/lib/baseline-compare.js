'use strict';
/**
 * Comparador de baseline (WP-12B): lê o relatório JSON versionado do Cenário A
 * e produz a comparação métrica-a-métrica + fatores de crescimento relativos
 * (razões, sem thresholds arbitrários de latência absoluta).
 */
const fs = require('node:fs');
const path = require('node:path');

/** Localiza o JSON de baseline (Cenário A) mais recente em reports/. */
function findBaselineReport(reportDir, { scenario = 'a', profile = 'medium' } = {}) {
    if (!fs.existsSync(reportDir)) return null;
    const files = fs.readdirSync(reportDir)
        .filter(f => f.startsWith(`scenario-${scenario}-${profile}-`) && f.endsWith('.json'))
        .sort();
    if (!files.length) return null;
    return path.join(reportDir, files[files.length - 1]);
}

function loadBaseline(jsonPath) {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    return JSON.parse(raw);
}

/** Duração média (ms) de global syncs completed em um relatório. */
function avgGlobalSyncMs(report) {
    const durs = [];
    for (const c of report.syncRuns?.perClinic ?? []) {
        for (const r of c.runs ?? []) {
            if (r.status === 'completed' && r.durationMs != null) durs.push(r.durationMs);
        }
    }
    if (!durs.length) return null;
    return Math.round(durs.reduce((a, b) => a + b, 0) / durs.length);
}

function maxQueuePeak(report, key) {
    let max = 0;
    for (const s of report.queues?.series ?? []) {
        const v = s[key];
        if (typeof v === 'number' && v > max) max = v;
    }
    return max;
}

function finalBacklog(report) {
    const s = report.queues?.series ?? [];
    const last = s[s.length - 1] ?? {};
    return { high: last.high ?? null, low: last.low ?? null };
}

function countGuardSkips(report) {
    const g = report.concurrencyGuard;
    if (!g || typeof g !== 'object') return 0;
    let total = 0;
    const walk = (o) => {
        for (const [k, v] of Object.entries(o)) {
            if (/skip/i.test(k) && typeof v === 'number') total += v;
            else if (v && typeof v === 'object') walk(v);
        }
    };
    walk(g);
    return total;
}

function countReservations(report) {
    const b = report.baselineFinal ?? {};
    let granted = 0, expired = 0;
    const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
            if (typeof v === 'number') {
                if (/reserv/i.test(k) && /expir/i.test(k)) expired += v;
                else if (/reserv/i.test(k)) granted += v;
            } else if (v && typeof v === 'object') walk(v);
        }
    };
    walk(b.priorityReservation ?? b.reservations ?? {});
    return { granted, expired };
}

/** Extrai o conjunto plano de métricas comparáveis de um relatório JSON. */
function extractMetrics(report) {
    const doc = report.mocks?.doctoralia ?? {};
    const backlog = finalBacklog(report);
    return {
        clinics: report.syncRuns?.perClinic?.length ?? null,
        durationMs: report.durationMs ?? null,
        avgGlobalSyncMs: avgGlobalSyncMs(report),
        docGets: doc.reads ?? null,
        docWrites: doc.writes ?? null,
        docTotalCalls: doc.totalCalls ?? null,
        peakAgg5min: report.budgets?.peakAgg5min ?? null,
        peakWrites1min: report.budgets?.peakWrites1min ?? null,
        peakWrites1h: report.budgets?.peakWrites1h ?? null,
        queuePeakHigh: maxQueuePeak(report, 'high'),
        queuePeakLow: maxQueuePeak(report, 'low'),
        waitP50Ms: report.queues?.waitMs?.p50 ?? null,
        waitP95Ms: report.queues?.waitMs?.p95 ?? null,
        waitMaxMs: report.queues?.waitMs?.max ?? null,
        queueFull: report.queues?.queueFull ?? null,
        queueTimeouts: report.queues?.queueTimeouts ?? null,
        guardSkips: countGuardSkips(report),
        reservations: countReservations(report),
        rssMaxBytes: report.process?.rss?.maxBytes ?? null,
        heapMaxBytes: report.process?.heapUsed?.maxBytes ?? null,
        elLagP95MaxMs: report.process?.eventLoopLagMs?.p95Max ?? null,
        pgMaxConnections: report.postgres?.maxConnections ?? null,
        pgMaxQps: report.postgres?.maxQps ?? null,
        finalBacklogHigh: backlog.high,
        finalBacklogLow: backlog.low,
        circuitBreaker: report.circuitBreaker ?? null,
    };
}

function ratio(cur, base) {
    if (cur == null || base == null) return null;
    if (base === 0) return cur === 0 ? 1 : null; // ×∞ não é informativo; reportado como absoluto
    return Math.round((cur / base) * 100) / 100;
}

/**
 * Compara o relatório atual com o baseline A.
 * Retorna { baselinePath, clinicFactor, metrics: [{name, baseline, current, factor}], growth }.
 */
function compareWithBaseline(currentReport, baselineReport, baselinePath) {
    const cur = extractMetrics(currentReport);
    const base = extractMetrics(baselineReport);
    const clinicFactor = ratio(cur.clinics, base.clinics);

    const rows = [
        ['Duração total (ms)', base.durationMs, cur.durationMs],
        ['Duração média Global Sync (ms)', base.avgGlobalSyncMs, cur.avgGlobalSyncMs],
        ['GETs Doctoralia (mock)', base.docGets, cur.docGets],
        ['WRITEs Doctoralia (mock)', base.docWrites, cur.docWrites],
        ['Pico agregado 5min', base.peakAgg5min, cur.peakAgg5min],
        ['Pico WRITE/min', base.peakWrites1min, cur.peakWrites1min],
        ['Pico WRITE/h', base.peakWrites1h, cur.peakWrites1h],
        ['Pico fila HIGH', base.queuePeakHigh, cur.queuePeakHigh],
        ['Pico fila LOW', base.queuePeakLow, cur.queuePeakLow],
        ['Espera p50 (ms)', base.waitP50Ms, cur.waitP50Ms],
        ['Espera p95 (ms)', base.waitP95Ms, cur.waitP95Ms],
        ['Espera max (ms)', base.waitMaxMs, cur.waitMaxMs],
        ['QueueFull', base.queueFull, cur.queueFull],
        ['QueueTimeout', base.queueTimeouts, cur.queueTimeouts],
        ['Skips do concurrency guard', base.guardSkips, cur.guardSkips],
        ['Reservas de prioridade expiradas', base.reservations?.expired, cur.reservations?.expired],
        ['RSS máx (bytes)', base.rssMaxBytes, cur.rssMaxBytes],
        ['Heap máx (bytes)', base.heapMaxBytes, cur.heapMaxBytes],
        ['Event-loop lag p95 máx (ms)', base.elLagP95MaxMs, cur.elLagP95MaxMs],
        ['Postgres conexões máx', base.pgMaxConnections, cur.pgMaxConnections],
        ['Postgres QPS máx', base.pgMaxQps, cur.pgMaxQps],
        ['Backlog final HIGH', base.finalBacklogHigh, cur.finalBacklogHigh],
        ['Backlog final LOW', base.finalBacklogLow, cur.finalBacklogLow],
    ].map(([name, b, c]) => ({ name, baseline: b, current: c, factor: ratio(c, b) }));

    const growth = {
        clinicFactor,
        durationFactor: ratio(cur.durationMs, base.durationMs),
        callsFactor: ratio(cur.docTotalCalls, base.docTotalCalls),
        memoryFactor: ratio(cur.rssMaxBytes, base.rssMaxBytes),
        queuePeakFactor: ratio(Math.max(cur.queuePeakHigh, cur.queuePeakLow), Math.max(base.queuePeakHigh, base.queuePeakLow)),
        waitP95Factor: ratio(cur.waitP95Ms, base.waitP95Ms),
        note: 'Fatores relativos ao baseline A (razão atual/baseline). clinicFactor é o crescimento esperado se a escala fosse perfeitamente linear.',
    };

    return {
        baselinePath: baselinePath ? path.basename(baselinePath) : null,
        baselineScenario: baselineReport.scenario,
        baselineEndedAt: baselineReport.endedAt,
        clinicFactor,
        metrics: rows,
        growth,
        circuitBreakerBaseline: base.circuitBreaker,
        circuitBreakerCurrent: cur.circuitBreaker,
    };
}

module.exports = { findBaselineReport, loadBaseline, compareWithBaseline, extractMetrics, avgGlobalSyncMs };
