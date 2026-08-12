'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { generateDataset } = require('../lib/dataset');

const OPTS = {
    profile: 'medium', seed: 'seed-x', clinics: 2,
    doctoraliaHost: '127.0.0.1:45443', vismedBaseUrl: 'https://127.0.0.1:45444',
};

test('gerador é determinístico por seed', () => {
    const a = generateDataset(OPTS);
    const b = generateDataset(OPTS);
    assert.deepStrictEqual(a, b);
});

test('seeds diferentes → datasets diferentes', () => {
    const a = generateDataset(OPTS);
    const b = generateDataset({ ...OPTS, seed: 'seed-y' });
    assert.notDeepStrictEqual(a.clinics[0].doctors.map(d => d.name), b.clinics[0].doctors.map(d => d.name));
});

test('estrutura respeita o perfil médio', () => {
    const ds = generateDataset(OPTS);
    assert.strictEqual(ds.clinics.length, 2);
    for (const c of ds.clinics) {
        assert.strictEqual(c.doctors.length, 5);
        assert.strictEqual(c.specialties.length, 3);
        assert.ok(c.doctors.every(d => d.addresses.length === 1));
        assert.ok(c.doctors.every(d => d.addresses[0].services.length === 2));
        assert.strictEqual(c.vismedAppointments.length, 3);
        // Todo médico aponta para uma especialidade existente na clínica
        for (const d of c.doctors) {
            assert.ok(c.specialties.some(s => s.vismedId === d.specialtyVismedId));
        }
    }
});

test('ids VisMed são globalmente únicos entre clínicas', () => {
    const ds = generateDataset(OPTS);
    const docIds = ds.clinics.flatMap(c => c.doctors.map(d => d.vismedId));
    assert.strictEqual(new Set(docIds).size, docIds.length);
    const unitIds = ds.clinics.map(c => c.unit.vismedId);
    assert.strictEqual(new Set(unitIds).size, unitIds.length);
});
