const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
function load(file, imports = {}) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const output = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const module = { exports: {} };
    new Function('require', 'module', 'exports', output)(name => imports[name] || require(name), module, module.exports);
    return module.exports;
}
const helpers = load('apps/web/src/lib/booking-conflict-details.ts');
const { BookingConflictDetails } = load('apps/web/src/components/bookings/BookingConflictDetails.tsx', { '@/lib/booking-conflict-details': helpers });
const related = { id: 'related', patientName: 'Paciente fictício', startAt: '2026-09-15T10:30:00Z', endAt: '2026-09-15T10:40:00Z', status: 'BOOKED', synchronized: true };
const base = { availability: 'complete', checkedAt: '2026-09-14T15:00:00Z', overlaps: [], sameNameBookings: [] };
test('shows real interval and three related associations in Brasilia time', () => {
    const data = { ...base, overlaps: [{ startAt: related.startAt, endAt: related.endAt, relatedBookings: [1, 2, 3].map(i => ({ ...related, id: String(i) })) }] };
    const html = renderToStaticMarkup(React.createElement(BookingConflictDetails, { data }));
    assert.match(html, /07:30 às 07:40/);
    assert.match(html, /3 outros agendamentos/);
    assert.match(html, /Ver agendamentos relacionados \(3\)/);
    assert.match(html, /Consulta em/);
});
test('same name with distinct IDs is not asserted to be a duplicate patient', () => {
    const lines = helpers.conflictExplanation({ ...base, sameNameBookings: [related] }).join(' ');
    assert.match(lines, /IDs de agendamento VissMed diferentes/);
    assert.match(lines, /1 com sincronização confirmada/);
    assert.match(lines, /não comprova duplicidade/);
});
test('failure and pagination never imply that the conflict is resolved', () => {
    assert.match(helpers.conflictExplanation({ ...base, availability: 'unavailable' }).join(' '), /sem confirmação/);
    assert.match(helpers.conflictExplanation({ ...base, availability: 'partial' }).join(' '), /podem existir outros bloqueios/);
    assert.match(helpers.conflictExplanation(base).join(' '), /não confirma.*resolvida/);
});
test('loading is explicit and related entries are not duplicated', () => {
    assert.match(helpers.conflictExplanation().join(' '), /Consultando/);
    const data = { ...base, sameNameBookings: [related], overlaps: [{ startAt: related.startAt, endAt: related.endAt, relatedBookings: [related] }] };
    const html = renderToStaticMarkup(React.createElement(BookingConflictDetails, { data }));
    assert.match(html, /relacionados \(1\)/);
});
test('zero local associations does not claim exclusive ownership', () => {
    const text = helpers.conflictExplanation({ ...base, overlaps: [{ startAt: related.startAt, endAt: related.endAt, relatedBookings: [] }] }).join(' ');
    assert.match(text, /Não foi encontrada associação/);
    assert.doesNotMatch(text, /pertence somente|exclusiv/);
});
