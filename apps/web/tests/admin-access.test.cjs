const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const Module = require('node:module');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(relative) {
    const filename = path.resolve(__dirname, relative);
    const mod = new Module(filename, module);
    mod.paths = module.paths;
    mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, filename);
    return mod.exports;
}
const { canManageAccounts } = load('../src/lib/admin-access.ts');
test('only active Super Admin sees management controls', () => {
    for (const role of ['OPERATOR', 'CLINIC_ADMIN', 'READONLY']) {
        assert.equal(canManageAccounts({ roles: [{ role }] }), false);
    }
    assert.equal(canManageAccounts(null), false);
    assert.equal(canManageAccounts({ roles: [] }), false);
    assert.equal(canManageAccounts({ roles: [{ role: 'SUPER_ADMIN' }] }), true);
    assert.equal(canManageAccounts({ active: false, roles: [{ role: 'SUPER_ADMIN' }] }), false);
});
test('notice explains the restriction and preserves own profile guidance', () => {
    const { AdminAccessNotice } = load('../src/components/layout/AdminAccessNotice.tsx');
    const html = renderToStaticMarkup(React.createElement(AdminAccessNotice));
    assert.match(html, /Acesso restrito ao Super Admin/);
    assert.match(html, /nome e sua senha/);
    assert.match(html, /role="status"/);
});
