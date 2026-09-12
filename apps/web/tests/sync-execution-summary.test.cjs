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
const { SyncExecutionSummary } = load('SyncExecutionSummary.tsx', { './execution-summary': helper, './SyncStatusHelp': load('SyncStatusHelp.tsx') });
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

const { explainPendingReasons } = load('pending-reasons.ts');
test('help buttons have accessible names for all four concepts', () => {
 const html=render(runs(['completed']));
 for(const label of ['Sem pendências','Com pendências','Falhas','Em andamento']) assert.ok(html.includes('Entenda: '+label));
 assert.ok(html.includes('aria-expanded="false"'));
});
test('compact card keeps the sample total visible and results in a closed disclosure', () => {
 const html=render(runs(['completed','completed_with_warnings','failed']));
 assert.match(html,/3<span class="sr-only"> execuções na amostra/);
 assert.match(html,/<summary[^>]*>Ver resultados/);
 assert.doesNotMatch(html,/<details[^>]*\sopen/);
 assert.match(html,/Entender pendências/);
});
test('known pending causes are explained without declaring all appointments failed', () => {
 const result=explainPendingReasons([{action:'plan_pending',message:'catálogo vazio'},{action:'regression_warning'},{action:'managed_scope_pending'},{action:'skipped_no_approved_mapping'},{action:'created'}]);
 assert.equal(result.length,3);assert.equal(result[0].events.length,2);
 assert.ok(result.some(r=>r.title==='Remoção de horários aguardando conferência'));
 assert.ok(result.every(r=>r.meaning&&r.next));
});
test('unknown events do not invent a cause',()=>{
 assert.deepEqual(explainPendingReasons([{action:'new_unknown_warning'}]),[]);
});
const { SyncPendingDetails }=load('SyncPendingDetails.tsx',{'./pending-reasons':load('pending-reasons.ts')});
test('pending details identify the execution and do not fetch until requested',()=>{
 let calls=0;
 const html=renderToStaticMarkup(React.createElement(SyncPendingDetails,{startedAt:'2026-09-12T10:00:00Z',source:'Doctoralia',loadEvents:async()=>{calls++;return [];}}));
 assert.equal(calls,0);assert.match(html,/12\/09\/2026/);assert.match(html,/07:00:00/);assert.match(html,/Ver motivos e próximos passos/);
});
