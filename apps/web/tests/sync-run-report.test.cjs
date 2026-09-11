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
const render = report => renderToStaticMarkup(React.createElement(component.exports.SyncRunReport, { report }));

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
