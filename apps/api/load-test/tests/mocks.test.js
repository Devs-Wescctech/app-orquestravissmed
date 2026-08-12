'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { generateDataset } = require('../lib/dataset');
const { ensureTestCert } = require('../lib/certs');
const { MockDoctoralia } = require('../lib/mock-doctoralia');
const { MockVismed } = require('../lib/mock-vismed');

const DOC_PORT = 46443, VIS_PORT = 46444;
const tlsDir = path.join(os.tmpdir(), 'wp12a-test-certs');
const tls = ensureTestCert(tlsDir);
const dataset = generateDataset({
    profile: 'small', seed: 'mock-test', clinics: 2,
    doctoraliaHost: `127.0.0.1:${DOC_PORT}`, vismedBaseUrl: `https://127.0.0.1:${VIS_PORT}`,
});

// cliente de teste que confia apenas no cert local (https nativo, sem deps extras)
const https = require('node:https');
function request(method, url, body, ct = 'application/json') {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, ca: tls.cert, headers: body ? { 'content-type': ct } : {} }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => { try { resolve(JSON.parse(data || 'null')); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}
const get = (url) => request('GET', url);
const post = (url, body, ct) => request('POST', url, body, ct);

test('mocks coerentes com o dataset', async (t) => {
    const doc = new MockDoctoralia({ dataset, tls, port: DOC_PORT });
    const vis = new MockVismed({ dataset, tls, port: VIS_PORT });
    await doc.start(); await vis.start();
    t.after(async () => { await doc.stop(); await vis.stop(); });

    const docBase = `https://127.0.0.1:${DOC_PORT}`;
    const visBase = `https://127.0.0.1:${VIS_PORT}`;
    const c = dataset.clinics[0];

    await t.test('OAuth emite token', async () => {
        const tok = await post(`${docBase}/oauth/v2/token`, 'grant_type=client_credentials', 'application/x-www-form-urlencoded');
        assert.ok(tok.access_token && tok.expires_in === 3600);
    });

    await t.test('facilities/doctors/addresses/services refletem o dataset', async () => {
        const fac = await get(`${docBase}/api/v3/integration/facilities`);
        assert.deepStrictEqual(fac._items.map(f => f.id).sort(), dataset.clinics.map(x => x.facilityId).sort());
        const docs = await get(`${docBase}/api/v3/integration/facilities/${c.facilityId}/doctors`);
        assert.strictEqual(docs._items.length, c.doctors.length);
        const d = c.doctors[0];
        const addrs = await get(`${docBase}/api/v3/integration/facilities/${c.facilityId}/doctors/${d.doctoraliaDoctorId}/addresses`);
        assert.deepStrictEqual(addrs._items.map(a => a.id), d.addresses.map(a => a.id));
        const svcs = await get(`${docBase}/api/v3/integration/facilities/${c.facilityId}/doctors/${d.doctoraliaDoctorId}/addresses/${d.addresses[0].id}/services`);
        assert.strictEqual(svcs._items.length, d.addresses[0].services.length);
    });

    await t.test('bookings do sweep vêm do dataset e o detail funciona', async () => {
        const d = c.doctors[0];
        const url = `${docBase}/api/v3/integration/facilities/${c.facilityId}/doctors/${d.doctoraliaDoctorId}/addresses/${d.addresses[0].id}/bookings`;
        const bk = await get(`${url}?start=x&end=y`);
        assert.strictEqual(bk._items.length, d.doctoraliaBookings.length);
        const detail = await get(`${url}/${d.doctoraliaBookings[0].id}`);
        assert.strictEqual(detail.visit_booking.id, d.doctoraliaBookings[0].id);
    });

    await t.test('VisMed: entidades por empresa refletem o dataset', async () => {
        const unis = await get(`${visBase}/api/v1.0/unidade-by-idempresagestora?idempresagestora=${c.empresaId}`);
        assert.strictEqual(unis[0].idunidade, c.unit.vismedId);
        const profs = await get(`${visBase}/api/v1.0/profissionais-by-idempresagestora?idempresagestora=${c.empresaId}`);
        assert.deepStrictEqual(profs.map(p => p.idprofissional).sort(), c.doctors.map(d => d.vismedId).sort());
        const cats = await get(`${visBase}/api/v1.0/especialidades-by-idempresagestora?idempresagestora=${c.empresaId}`);
        assert.strictEqual(cats.length, c.specialties.length);
    });

    await t.test('scheduleDay é determinístico e filtra por categoria', async () => {
        const cat = c.specialties[1].vismedId;
        const u = `${visBase}/api/v1.0/schedule/online/scheduleDay?idempresagestora=${c.empresaId}&idcategoriaservico=${cat}&dataagendamento=2026-08-20`;
        const a = await get(u);
        const b = await get(u);
        assert.deepStrictEqual(a, b);
        assert.ok(a.every(e => c.doctors.some(d => d.vismedId === e.idprofissional && d.specialtyVismedId === cat)));
        assert.ok(a[0].horarios.every(h => h.inicio && h.fim));
    });

    await t.test('criação de agendamento VisMed é stateful (aparece na listagem, some no delete)', async () => {
        const d = c.doctors[0];
        const created = await post(`${visBase}/api/v1.0/schedule/online/schedule/pacient`,
            JSON.stringify({ idprofissional: d.vismedId, data_agendamento: '20/08/2026', horarios_profissional: `${d.vismedId}|09:00`, nome: 'Teste Stateful' }));
        assert.ok(created.idpacienteagendamento);
        const list = await get(`${visBase}/api/v1.0/get-agendamento-filtros?unidade=${c.unit.vismedId}`);
        assert.ok(list.some(a => String(a.idpacienteagendamento) === String(created.idpacienteagendamento)));
        await post(`${visBase}/api/v1.0/delete-agendamento`, JSON.stringify({ idpacienteagendamento: created.idpacienteagendamento }));
        const list2 = await get(`${visBase}/api/v1.0/get-agendamento-filtros?unidade=${c.unit.vismedId}`);
        assert.ok(!list2.some(a => String(a.idpacienteagendamento) === String(created.idpacienteagendamento)));
    });

    await t.test('mocks registram GET/WRITE com timestamp', async () => {
        assert.ok(doc.log.calls.length > 0 && vis.log.calls.length > 0);
        assert.ok(doc.log.calls.every(e => typeof e.ts === 'number' && typeof e.isWrite === 'boolean'));
        assert.ok(vis.log.calls.some(e => e.isWrite));
    });
});
