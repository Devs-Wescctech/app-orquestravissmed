const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Transpile the actual TS/TSX component; dependencies use the candidate lockfile.
function loadSource(relativePath, imports = {}) {
    const filename = path.resolve(__dirname, '..', relativePath);
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
        fileName: filename,
    }).outputText;
    const module = { exports: {} };
    new Function('require', 'module', 'exports', output)(name => imports[name] || require(name), module, module.exports);
    return module.exports;
}
const presentation = loadSource('apps/web/src/lib/booking-alert-presentation.ts');
const { BookingAlerts } = loadSource('apps/web/src/components/bookings/BookingAlerts.tsx', {
    '@/lib/booking-alert-presentation': presentation,
});
function group(reason, errorMessage = 'Horário indisponível, tente outro horário') {
    return { vismedDoctorId: reason || 'unknown', doctorName: 'Profissional de teste', reason, count: 1, latestAt: '2026-09-14', appointments: [
        { id: 'test-1', startAt: '2026-09-15T19:50:00Z', endAt: '2026-09-15T20:20:00Z', patientName: 'Paciente de teste', errorMessage },
    ] };
}
function render(doctors, props = {}) {
    return renderToStaticMarkup(React.createElement(BookingAlerts, {
        skippedAlerts: { total: doctors.length, doctors }, dismissingAlerts: false, handleDismissAlerts() {}, ...props,
    }));
}

test('unavailable VissMed time shows correct destination and no mapping actions', () => {
    const html = render([group('VISMED_CREATE_FAILED')]);
    assert.match(html, /1 agendamento não confirmado na VissMed/);
    assert.match(html, /Horário indisponível na VissMed/);
    assert.match(html, /Confira as duas agendas antes de escolher outro horário/);
    assert.doesNotMatch(html, /Resolver vínculos|Central de Mapeamento|href="\/mapping"|agendar manualmente|não enviado.*à Doctoralia/);
    assert.match(html, /<summary[^>]*>Ver agendamento<\/summary>/);
    assert.match(html, /Paciente de teste/);
    assert.match(html, /16:50/);
    assert.match(html, /17:20/);
    assert.match(html, /Ver diagnóstico técnico/);
});

test('confirmed missing mapping retains mapping links', () => {
    const html = render([group('DOCTOR_NOT_LINKED', '')]);
    assert.match(html, /1 agendamento não enviado à Doctoralia/);
    assert.match(html, /Resolver vínculos/);
    assert.match(html, /Central de Mapeamento/);
    assert.match(html, /href="\/mapping"/);
});

test('mixed causes use neutral heading and mapping only for affected group', () => {
    const html = render([group('VISMED_CREATE_FAILED'), group('DOCTOR_NOT_LINKED', '')]);
    assert.match(html, /2 agendamentos com pendência de sincronização/);
    assert.equal((html.match(/Resolver vínculos/g) || []).length, 1);
    assert.equal((html.match(/Ver agendamento/g) || []).length, 2);
});

test('generic VissMed failure does not falsely claim unavailable time', () => {
    const html = render([group('VISMED_CREATE_FAILED', 'Falha de comunicação')]);
    assert.match(html, /A VissMed não confirmou a criação/);
    assert.doesNotMatch(html, /Horário indisponível|Resolver vínculos|agendar manualmente/);
});

test('a generic sync error does not hide the specific unavailable-time message', () => {
    const doctor = group('VISMED_CREATE_FAILED');
    doctor.appointments[0].syncError = 'Criação não confirmada';
    assert.match(render([doctor]), /Horário indisponível na VissMed/);
});

test('unknown cause is not treated as missing mapping', () => {
    const html = render([group(undefined, '')]);
    assert.match(html, /pendência de sincronização/);
    assert.doesNotMatch(html, /href="\/mapping"/);
});

test('empty alerts render nothing and dismiss in progress stays disabled', () => {
    assert.equal(render([]), '');
    assert.match(render([group('VISMED_CREATE_FAILED')], { dismissingAlerts: true }), /<button[^>]*disabled=""/);
});

test('plural title and accent-free unavailable message', () => {
    assert.equal(presentation.getAlertHeading(2, [group('VISMED_CREATE_FAILED')]), '2 agendamentos não confirmados na VissMed');
    assert.equal(presentation.getAlertPresentation('VISMED_CREATE_FAILED', 'HORARIO INDISPONIVEL').title, 'Horário indisponível na VissMed');
});
