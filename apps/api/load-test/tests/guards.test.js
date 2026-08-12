'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { assertSafeDatabaseUrl, assertNoProdEnv, assertConnectionsAreSafe, FORBIDDEN_HOST_RE } = require('../lib/guards');

test('aceita DATABASE_URL de teste local', () => {
    assert.ok(assertSafeDatabaseUrl('postgresql://loadtester@127.0.0.1:55442/loadtest_db'));
    assert.ok(assertSafeDatabaseUrl('postgresql://u:p@localhost:5432/my_loadtest'));
});

test('bloqueia DATABASE_URL remota ou sem marcação loadtest', () => {
    assert.throws(() => assertSafeDatabaseUrl('postgresql://u:p@db.example.com:5432/loadtest_db'), /allowlist/);
    assert.throws(() => assertSafeDatabaseUrl('postgresql://u:p@127.0.0.1:5432/production'), /loadtest/);
    assert.throws(() => assertSafeDatabaseUrl('postgresql://u:p@ep-something.neon.tech/neondb'), /allowlist/);
    assert.throws(() => assertSafeDatabaseUrl(''), /ausente/);
});

test('bloqueia PROD_DATABASE_URL no env do processo sob teste', () => {
    assert.throws(() => assertNoProdEnv({ PROD_DATABASE_URL: 'x' }), /PROD_DATABASE_URL/);
    assert.ok(assertNoProdEnv({ DATABASE_URL: 'postgresql://loadtester@127.0.0.1/loadtest_db' }));
});

test('bloqueia conexões apontando para domínios reais', () => {
    assert.throws(() => assertConnectionsAreSafe([{ clinicId: 'c', provider: 'doctoralia', domain: 'www.doctoralia.com.br' }]), /domínio real/);
    assert.throws(() => assertConnectionsAreSafe([{ clinicId: 'c', provider: 'vismed', domain: 'https://app.vissmed.com.br/api-vissmed-4' }]), /domínio real/);
    assert.throws(() => assertConnectionsAreSafe([{ clinicId: 'c', provider: 'doctoralia', domain: 'some-other-host.com' }]), /loopback/);
    assert.ok(assertConnectionsAreSafe([
        { clinicId: 'c', provider: 'doctoralia', domain: '127.0.0.1:45443' },
        { clinicId: 'c', provider: 'vismed', domain: 'https://127.0.0.1:45444' },
    ]));
});

test('regex de hosts proibidos cobre variantes', () => {
    for (const h of ['doctoralia.com.br', 'www.doctoralia.com', 'znanylekarz.pl', 'docplanner.com', 'app.vissmed.com.br']) {
        assert.ok(FORBIDDEN_HOST_RE.test(h), h);
    }
    assert.ok(!FORBIDDEN_HOST_RE.test('127.0.0.1:45443'));
});
