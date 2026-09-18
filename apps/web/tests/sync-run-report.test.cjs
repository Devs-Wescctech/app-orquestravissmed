const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const filename = path.resolve(__dirname, '../src/components/sync/SyncRunReport.tsx');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const component = new Module(filename, module);
component.filename = filename;
component.paths = Module._nodeModulePaths(path.dirname(filename));
component._compile(compiled, filename);
const render = (report, events) => renderToStaticMarkup(React.createElement(component.exports.SyncRunReport, { report, events }));

test('historical totals are identified as not measuring actual changes', () => {
  assert.match(render(), /Contagem anterior: não distingue alterações reais/);
});

test('new report distinguishes unchanged records, stages and pending calendars', () => {
  const html = render({ version: 2, categories: { doctors: { verified: 62, created: 1, updated: 2, unchanged: 59, errors: 0 } },
    stages: [{ name: 'push_to_doctoralia', durationMs: 1200 }], agendas: { unchanged: 16, managed_scope_pending: 3 }, errors: 0, warnings: 3 });
  assert.match(html, /Profissionais/);
  assert.match(html, /Inalterados/);
  assert.match(html, />59</);
  assert.match(html, /Agendas pendentes: 3/);
  assert.match(html, /Atualização de agendas e vínculos: 1.2 s/);
  assert.match(html, /overflow-x-auto/);
});

const emptyReport = { version: 2, categories: {}, stages: [], agendas: { skipped_empty: 2 }, errors: 0, warnings: 0 };
test('professional cleanup is included in the pending calendar total', () => {
  assert.match(render({ ...emptyReport, agendas: { professional_cleanup_pending: 2, managed_scope_pending: 1 } }), /Agendas pendentes: 3/);
});
test('empty agendas show evidence without claiming the internal calendar is blocked', () => {
  const html = render(emptyReport, [{ entityType: 'SLOT_SYNC', action: 'skipped_empty', message: 'Profissional Teste, endereço 1, período 2026-09-13 a 2026-10-12: sem intervalos livres.' }]);
  assert.match(html, /sem disponibilidade identificada/);
  assert.match(html, /2026-09-13 a 2026-10-12/);
  assert.match(html, /não comprova/);
  assert.match(html, /não cobrem todas/);
});
test('legacy events are explained without inventing a detailed cause', () => {
  const html = render(emptyReport, [{ entityType: 'SLOT_SYNC', action: 'skipped_empty', message: 'Doctor Teste address 12: nenhuma faixa livre e sem estado prévio gerenciado — skip (evita wipe acidental).' }, { entityType: 'OTHER', action: 'skipped_empty', message: 'não relacionado' }]);
  assert.match(html, /execução antiga não registrou o motivo detalhado/);
  assert.doesNotMatch(html, /wipe|não relacionado/);
});
test('no empty count does not show empty-agenda details', () => {
  assert.doesNotMatch(render({ ...emptyReport, agendas: {} }), /Ver agendas sem disponibilidade/);
});
