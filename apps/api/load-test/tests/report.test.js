'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CallLog } = require('../lib/call-log');
const { buildReport, renderMarkdown, sumBaselineCounter } = require('../lib/report');

function makeLog(entries) {
    const log = new CallLog('doctoralia');
    for (const e of entries) log.record(e);
    // reescreve timestamps controlados
    entries.forEach((e, i) => { if (e.ts !== undefined) log.calls[i].ts = e.ts; });
    return log;
}

function baseInput(overrides = {}) {
    return {
        scenario: 'a', profile: 'medium', seed: 's',
        startedAt: '2026-08-12T00:00:00.000Z', endedAt: '2026-08-12T00:05:00.000Z',
        docLog: makeLog([{ method: 'GET', path: '/api/v3/integration/facilities' }]),
        visLog: makeLog([]),
        baselineSnapshots: [{
            ts: 1, baseline: {
                volume: { DOCTORALIA_API_REQUEST_COUNT: 1, DOCTORALIA_OAUTH_REQUEST_COUNT: 0 },
                queue: { waitMs: { p50: 1, p95: 2, max: 100 }, DOCTORALIA_QUEUE_SIZE_HIGH: 0, DOCTORALIA_QUEUE_SIZE_LOW: 0 },
            },
        }],
        processSamples: [{ ts: 1, rssBytes: 100 * 1048576 }],
        pgSamples: [{ ts: 1, connections: { total: 3 }, qps: 5 }],
        lagSamples: [{ ts: 1, elDelayMeanMs: 1, elDelayP95Ms: 2, heapUsedBytes: 50 * 1048576 }],
        syncRuns: [
            { id: '1', clinicId: 'c1', type: 'full', status: 'completed', startedAt: '2026-08-12T00:00:00Z', endedAt: '2026-08-12T00:01:00Z' },
            { id: '2', clinicId: 'c1', type: 'vismed-full', status: 'completed', startedAt: '2026-08-12T00:00:00Z', endedAt: '2026-08-12T00:01:00Z' },
        ],
        actions: [], notes: [], tlsApproach: 'NODE_EXTRA_CA_CERTS',
        expected: { clinicIds: ['c1'], windows: 1 },
        cleanExit: { clean: true, exitCode: null, signal: 'SIGTERM', waitedMs: 500 },
        ...overrides,
    };
}

test('cenário limpo passa em todos os critérios', () => {
    const { report, passed } = buildReport(baseInput());
    assert.ok(passed, JSON.stringify(report.criteria.filter(c => !c.pass)));
    assert.strictEqual(report.criteria.length, 14);
    assert.ok(renderMarkdown(report).includes('✅ PASS'));
});

test('escrita duplicada em janela curta reprova', () => {
    const t = Date.now();
    const docLog = makeLog([
        { method: 'PUT', path: '/x/slots', body: '{"slots":[1]}', ts: t },
        { method: 'PUT', path: '/x/slots', body: '{"slots":[1]}', ts: t + 1000 },
    ]);
    const { report, passed } = buildReport(baseInput({ docLog }));
    assert.ok(!passed);
    assert.ok(!report.criteria.find(c => c.name.includes('duplicada')).pass);
});

test('escrita idêntica fora da janela de 120s NÃO conta como duplicata', () => {
    const t = Date.now();
    const docLog = makeLog([
        { method: 'PUT', path: '/x/slots', body: '{"slots":[1]}', ts: t },
        { method: 'PUT', path: '/x/slots', body: '{"slots":[1]}', ts: t + 300_000 },
    ]);
    const { passed } = buildReport(baseInput({ docLog }));
    assert.ok(passed);
});

test('estouro de budget WRITE/min reprova', () => {
    const t = Date.now();
    const entries = [];
    for (let i = 0; i < 45; i++) entries.push({ method: 'POST', path: `/w/${i}`, body: String(i), ts: t + i * 100 });
    const { report, passed } = buildReport(baseInput({ docLog: makeLog(entries) }));
    assert.ok(!passed);
    assert.ok(!report.criteria.find(c => c.name.includes('40/min')).pass);
});

test('SyncRun failed ou preso reprova', () => {
    const bad = baseInput({
        syncRuns: [{ id: '1', clinicId: 'c1', type: 'full', status: 'failed', startedAt: '2026-08-12T00:00:00Z', endedAt: '2026-08-12T00:01:00Z' }],
    });
    assert.ok(!buildReport(bad).passed);
});

test('NENHUM SyncRun observado reprova (coleção vazia não passa por vacuidade)', () => {
    const { report, passed } = buildReport(baseInput({ syncRuns: [] }));
    assert.ok(!passed);
    assert.ok(!report.criteria.find(c => c.name.includes('completa full')).pass);
});

test('menos janelas completadas que o esperado reprova', () => {
    // esperado 2 janelas, mas só 1 full+vismed-full completados
    const { passed } = buildReport(baseInput({ expected: { clinicIds: ['c1'], windows: 2 } }));
    assert.ok(!passed);
});

test('clínica esperada sem nenhum run reprova', () => {
    const { passed } = buildReport(baseInput({ expected: { clinicIds: ['c1', 'c2-sem-runs'], windows: 1 } }));
    assert.ok(!passed);
});

test('expected ausente ou vazio é erro do harness', () => {
    assert.throws(() => buildReport(baseInput({ expected: undefined })), /obrigatório/);
    assert.throws(() => buildReport(baseInput({ expected: { clinicIds: [], windows: 1 } })), /obrigatório/);
});

test('baseline com erro em todos os snapshots reprova (não vira zero implícito)', () => {
    const { report, passed } = buildReport(baseInput({
        baselineSnapshots: [{ ts: 1, baseline: { error: 'HTTP 403' } }],
    }));
    assert.ok(!passed);
    assert.ok(!report.criteria.find(c => c.name.includes('Baseline de métricas')).pass);
    assert.ok(!report.criteria.find(c => c.name.includes('Filas HIGH/LOW')).pass, 'fila sem dado deve reprovar');
    assert.ok(!report.criteria.find(c => c.name.includes('Oldest waiter')).pass, 'waitMs sem dado deve reprovar');
    assert.ok(!report.criteria.find(c => c.name.includes('Reservas expiradas')).pass, 'reservas exigem baseline válido');
});

test('nenhum snapshot de baseline reprova', () => {
    const { passed } = buildReport(baseInput({ baselineSnapshots: [] }));
    assert.ok(!passed);
});

test('rota não-mapeada no mock reprova', () => {
    const docLog = makeLog([{ method: 'GET', path: '/api/v3/integration/facilities' }]);
    docLog.record({ method: 'GET', path: '/api/v3/integration/rota-desconhecida', matched: false });
    const { report, passed } = buildReport(baseInput({ docLog }));
    assert.ok(!passed);
    assert.ok(!report.criteria.find(c => c.name.includes('não-mapeada')).pass);
});

test('sumBaselineCounter encontra contadores aninhados', () => {
    assert.strictEqual(sumBaselineCounter({ a: { QueueTimeout: 2 }, b: { c: { queueTimeouts: 3 } } }, ['QueueTimeout', 'queueTimeouts']), 5);
});

test('comparação mock vs baseline aparece no relatório', () => {
    const { report } = buildReport(baseInput());
    assert.strictEqual(report.counterComparison.mockApiCalls, 1);
    assert.strictEqual(report.counterComparison.baselineApiCalls, 1);
    assert.strictEqual(report.counterComparison.apiDelta, 0);
});

// ── WP-12B: novos checks ────────────────────────────────────────────────────
test('memória crescendo monotonicamente sem estabilizar reprova', () => {
    const processSamples = Array.from({ length: 20 }, (_, i) => ({ ts: i, rssBytes: (100 + i * 20) * 1048576 }));
    const { report, passed } = buildReport(baseInput({ processSamples }));
    assert.ok(!passed);
    assert.ok(!report.criteria.find(c => c.name.includes('RSS estabiliza')).pass);
});

test('memória que cresce e estabiliza (platô) passa', () => {
    const processSamples = Array.from({ length: 20 }, (_, i) => ({ ts: i, rssBytes: (i < 10 ? 100 + i * 20 : 300) * 1048576 }));
    const { report } = buildReport(baseInput({ processSamples }));
    assert.ok(report.criteria.find(c => c.name.includes('RSS estabiliza')).pass);
});

test('QueueFull != 0 reprova, exceto justificado no cenário D', () => {
    const snap = (qf) => [{
        ts: 1, baseline: {
            volume: { DOCTORALIA_API_REQUEST_COUNT: 1, DOCTORALIA_OAUTH_REQUEST_COUNT: 0 },
            queue: { waitMs: { p50: 1, p95: 2, max: 100 }, DOCTORALIA_QUEUE_SIZE_HIGH: 0, DOCTORALIA_QUEUE_SIZE_LOW: 0, queueFull: qf },
        },
    }];
    let r = buildReport(baseInput({ baselineSnapshots: snap(3) }));
    assert.ok(!r.report.criteria.find(c => c.name.startsWith('QueueFull')).pass);
    r = buildReport(baseInput({ scenario: 'd', baselineSnapshots: snap(3), queueJustification: 'saturação esperada no D' }));
    assert.ok(r.report.criteria.find(c => c.name.startsWith('QueueFull')).pass);
    r = buildReport(baseInput({ scenario: 'd', baselineSnapshots: snap(3) }));
    assert.ok(!r.report.criteria.find(c => c.name.startsWith('QueueFull')).pass);
});

test('shutdown sujo (SIGKILL) reprova; sem dado reprova', () => {
    let r = buildReport(baseInput({ cleanExit: { clean: false, signal: 'SIGKILL', waitedMs: 10000 } }));
    assert.ok(!r.passed);
    r = buildReport(baseInput({ cleanExit: null }));
    assert.ok(!r.passed);
});

test('relatório parcial nunca é PASS e registra o motivo', () => {
    const { report, passed } = buildReport(baseInput({ partial: true, interruptionReason: 'teste interrompido' }));
    assert.ok(!passed);
    assert.ok(report.partial);
    const md = renderMarkdown(report);
    assert.ok(md.includes('PARCIAL'));
    assert.ok(md.includes('teste interrompido'));
});
