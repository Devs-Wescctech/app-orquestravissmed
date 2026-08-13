'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { analyzeGrantDispatchArrival, maxInRollingWindow, dist } = require('../lib/grant-dispatch');

// ── maxInRollingWindow: semânticas de fronteira ─────────────────────────────

const items = (tss) => tss.map(ts => ({ ts, method: 'PUT', path: '/x' }));

test('fronteira EXATA de 60.000ms: inclusiva conta os dois extremos, estrita não', () => {
    // t0, t0+60000: exatamente 60s de distância
    const arr = items([1_000_000, 1_060_000]);
    assert.strictEqual(maxInRollingWindow(arr, 60_000, 'inclusive').max, 2, 'auditoria do mock (delta > janela expira) mantém delta == 60000');
    assert.strictEqual(maxInRollingWindow(arr, 60_000, 'strict').max, 1, 'limiter (delta >= janela expira) exclui delta == 60000');
});

test('fronteira EXATA de 300.000ms: mesma divergência no agregado 5min', () => {
    const arr = items([0, 150_000, 300_000]);
    assert.strictEqual(maxInRollingWindow(arr, 300_000, 'inclusive').max, 3);
    assert.strictEqual(maxInRollingWindow(arr, 300_000, 'strict').max, 2);
});

test('delta 1ms abaixo da janela: as duas semânticas coincidem', () => {
    const arr = items([0, 59_999]);
    assert.strictEqual(maxInRollingWindow(arr, 60_000, 'inclusive').max, 2);
    assert.strictEqual(maxInRollingWindow(arr, 60_000, 'strict').max, 2);
});

test('timestamps idênticos contam todos nas duas semânticas', () => {
    const arr = items([5, 5, 5]);
    assert.strictEqual(maxInRollingWindow(arr, 60_000, 'inclusive').max, 3);
    assert.strictEqual(maxInRollingWindow(arr, 60_000, 'strict').max, 3);
});

test('devolve a janela ofensora (start/end/requests) do pico', () => {
    const arr = items([0, 10, 100_000, 100_020, 100_040]);
    const r = maxInRollingWindow(arr, 60_000, 'strict');
    assert.strictEqual(r.max, 3);
    assert.strictEqual(r.windowStart, 100_000);
    assert.strictEqual(r.windowEnd, 100_040);
    assert.strictEqual(r.requests.length, 3);
});

test('série vazia: max 0, janela nula', () => {
    const r = maxInRollingWindow([], 60_000, 'inclusive');
    assert.strictEqual(r.max, 0);
    assert.strictEqual(r.windowStart, null);
});

// ── dist ─────────────────────────────────────────────────────────────────────

test('dist calcula min/p50/p95/p99/max', () => {
    const d = dist([5, 1, 3, 2, 4]);
    assert.strictEqual(d.min, 1);
    assert.strictEqual(d.p50, 3);
    assert.strictEqual(d.max, 5);
    assert.strictEqual(d.count, 5);
    assert.deepStrictEqual(dist([]), { count: 0, min: null, p50: null, p95: null, p99: null, max: null });
});

// ── analyzeGrantDispatchArrival: correlação e hipótese ───────────────────────

const ev = (id, method, releasedAt, sentAt) => ({
    doctoraliaRequestId: id, method, operation: 'OP', endpoint: '/e',
    releasedAt, sentAt,
});
const call = (id, method, ts) => ({ correlationId: id, method, path: '/e', ts, isWrite: method !== 'GET' });

test('correlação 1:1 por correlationId e deltas por requisição', () => {
    const internalEvents = [ev('a', 'PUT', 100, 101), ev('b', 'GET', 200, 200)];
    const mockCalls = [call('a', 'PUT', 105), call('b', 'GET', 203)];
    const r = analyzeGrantDispatchArrival({ internalEvents, mockCalls });
    assert.strictEqual(r.correlation.correlated, 2);
    assert.strictEqual(r.correlation.internalWithoutArrival, 0);
    assert.strictEqual(r.correlation.arrivalsWithoutInternal, 0);
    assert.strictEqual(r.deltas.grantToDispatchMs.max, 1);
    assert.strictEqual(r.deltas.dispatchToArrivalMs.max, 4);
    assert.strictEqual(r.deltas.writeOnly.dispatchToArrivalMs.count, 1);
});

test('eventos sem par são contabilizados sem quebrar a análise', () => {
    const r = analyzeGrantDispatchArrival({
        internalEvents: [ev('a', 'PUT', 100, 101), ev('orfao', 'PUT', 110, 111)],
        mockCalls: [call('a', 'PUT', 105), call(undefined, 'GET', 300)],
    });
    assert.strictEqual(r.correlation.correlated, 1);
    assert.strictEqual(r.correlation.internalWithoutArrival, 1);
    assert.strictEqual(r.correlation.arrivalsWithoutCorrelationId, 1);
    assert.strictEqual(r.correlation.arrivalsWithoutInternal, 1);
});

test('compressão temporal: grants estritamente ≤ limite e arrivals > limite → CONFIRMADA (strict)', () => {
    // 3 WRITEs com grants espaçados exatamente na fronteira (0, 30s, 60s):
    // pelo limiter (strict) nunca há 3 na mesma janela; jitter de +50ms no
    // primeiro arrival comprime as chegadas em <60s → 3 arrivals na janela.
    const internalEvents = [
        ev('a', 'PUT', 0, 0),
        ev('b', 'PUT', 30_000, 30_000),
        ev('c', 'PUT', 60_000, 60_000),
    ];
    const mockCalls = [
        call('a', 'PUT', 50),        // chega 50ms atrasado
        call('b', 'PUT', 30_001),
        call('c', 'PUT', 60_001),    // 60_001 - 50 = 59_951 < 60_000
    ];
    const r = analyzeGrantDispatchArrival({ internalEvents, mockCalls, limits: { writesPerMin: 2, aggregatePer5Min: 400 } });
    assert.strictEqual(r.writeMinute.maxGrantsInRollingMinute.maxStrict, 2, 'limiter respeita a própria janela');
    assert.strictEqual(r.writeMinute.maxArrivalsInRollingMinute.maxStrict, 3, 'arrivals comprimidos numa janela <60s real');
    assert.strictEqual(r.hypothesis.compressionConfirmedWriteStrict, true);
    // Na semântica inclusiva os grants na fronteira exata também contam 3 → não é compressão
    assert.strictEqual(r.writeMinute.maxGrantsInRollingMinute.max, 3);
    assert.strictEqual(r.hypothesis.compressionConfirmedWrite, false);
});
