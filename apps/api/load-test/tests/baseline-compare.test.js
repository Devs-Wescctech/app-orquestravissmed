'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compareWithBaseline, extractMetrics, avgGlobalSyncMs } = require('../lib/baseline-compare');

const fakeReport = (over = {}) => ({
    scenario: 'a', endedAt: '2026-08-12T00:00:00Z',
    durationMs: 50_000,
    mocks: { doctoralia: { reads: 100, writes: 40, totalCalls: 140 } },
    budgets: { peakAgg5min: 140, peakWrites1min: 30, peakWrites1h: 40 },
    queues: { series: [{ high: 3, low: 5 }, { high: 0, low: 0 }], waitMs: { p50: 1, p95: 2, max: 3 }, queueFull: 0, queueTimeouts: 0 },
    syncRuns: { perClinic: [{ clinicId: 'c1', runs: [{ status: 'completed', durationMs: 100 }, { status: 'completed', durationMs: 300 }] }, { clinicId: 'c2', runs: [] }] },
    process: { rss: { maxBytes: 100e6 }, heapUsed: { maxBytes: 30e6 }, eventLoopLagMs: { p95Max: 20 } },
    postgres: { maxConnections: 10, maxQps: 100 },
    baselineFinal: {},
    ...over,
});

test('extractMetrics extrai o conjunto plano de métricas', () => {
    const m = extractMetrics(fakeReport());
    assert.equal(m.clinics, 2);
    assert.equal(m.docGets, 100);
    assert.equal(m.queuePeakHigh, 3);
    assert.equal(m.finalBacklogHigh, 0);
    assert.equal(m.avgGlobalSyncMs, 200);
});

test('avgGlobalSyncMs ignora runs não-completed e retorna null sem dados', () => {
    assert.equal(avgGlobalSyncMs({ syncRuns: { perClinic: [] } }), null);
});

test('compareWithBaseline calcula fatores de crescimento', () => {
    const base = fakeReport();
    const cur = fakeReport({
        durationMs: 250_000,
        mocks: { doctoralia: { reads: 500, writes: 200, totalCalls: 700 } },
        syncRuns: { perClinic: Array.from({ length: 10 }, (_, i) => ({ clinicId: `c${i}`, runs: [{ status: 'completed', durationMs: 200 }] })) },
    });
    const cmp = compareWithBaseline(cur, base, '/x/scenario-a.json');
    assert.equal(cmp.clinicFactor, 5);
    assert.equal(cmp.growth.durationFactor, 5);
    assert.equal(cmp.growth.callsFactor, 5);
    assert.equal(cmp.baselinePath, 'scenario-a.json');
    const dur = cmp.metrics.find(m => m.name === 'Duração total (ms)');
    assert.equal(dur.factor, 5);
});

test('ratio com baseline 0: 0/0 → 1, n/0 → null (sem ×∞)', () => {
    const base = fakeReport({ queues: { series: [], waitMs: {}, queueFull: 0, queueTimeouts: 0 } });
    const cur = fakeReport({ queues: { series: [], waitMs: {}, queueFull: 5, queueTimeouts: 0 } });
    const cmp = compareWithBaseline(cur, base, null);
    const qf = cmp.metrics.find(m => m.name === 'QueueFull');
    assert.equal(qf.factor, null);
    const qt = cmp.metrics.find(m => m.name === 'QueueTimeout');
    assert.equal(qt.factor, 1);
});
