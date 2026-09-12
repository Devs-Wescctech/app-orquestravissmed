const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(name, dependencies = {}) {
    const filename = path.resolve(__dirname, '../src/components/sync', name);
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    const original = mod.require.bind(mod);
    mod.require = id => dependencies[id] || original(id);
    mod._compile(compiled, filename);
    return mod.exports;
}
const helper = load('execution-summary.ts');
const { SyncExecutionSummary } = load('SyncExecutionSummary.tsx', { './execution-summary': helper });
const runs = statuses => statuses.map(status => ({ status }));
const render = value => renderToStaticMarkup(React.createElement(SyncExecutionSummary, { runs: value }));

test('incident sample keeps four clean, five pending and one failure distinct', () => {
    const sample = runs([...Array(4).fill('completed'), ...Array(5).fill('completed_with_warnings'), 'failed']);
    assert.deepEqual(helper.summarizeExecutions(sample), { sampled: 10, completed: 4, warnings: 5, failed: 1, running: 0, skipped: 0, other: 0 });
    const html = render(sample);
    for (const label of ['Sem pendências', 'Com pendências', 'Falhas', 'Em andamento', 'Últimas 10']) assert.ok(html.includes(label));
    assert.doesNotMatch(html, /40%|Saúde de/);
});
test('running, skipped and unknown statuses are never classified as failure', () => {
    assert.deepEqual(helper.summarizeExecutions(runs(['running', 'skipped', 'queued'])),
        { sampled: 3, completed: 0, warnings: 0, failed: 0, running: 1, skipped: 1, other: 1 });
    assert.match(render(runs(['skipped', 'queued'])), /1 pulada\(s\), sem execução/);
    assert.match(render(runs(['queued'])), /1 com outro status/);
});
test('both history sizes use only ten newest records', () => {
    const current = runs(Array(10).fill('completed'));
    assert.deepEqual(helper.summarizeExecutions([...current, ...runs(Array(10).fill('failed'))]), helper.summarizeExecutions(current));
});
test('legacy status aliases retain their meaning', () => {
    const s = helper.summarizeExecutions(runs(['success', 'warning', 'partially', 'error']));
    assert.equal(s.completed, 1); assert.equal(s.warnings, 2); assert.equal(s.failed, 1);
});
test('empty history and unavailable data have distinct explanations, no percentage', () => {
    assert.match(render([]), /Nenhuma execução registrada/);
    assert.match(render(null), /Resumo indisponível/);
    assert.doesNotMatch(render(null), /Sem pendências|0%|100%/);
});
test('a small sample shows its actual size and preserves totals', () => {
    const sample = runs(['completed', 'completed_with_warnings', 'running']);
    const s = helper.summarizeExecutions(sample);
    assert.equal(s.sampled, s.completed + s.warnings + s.failed + s.running + s.skipped + s.other);
    assert.match(render(sample), /Últimas 3/);
});
