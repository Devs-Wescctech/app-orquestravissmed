#!/usr/bin/env node
'use strict';
/**
 * Runner do harness de carga WP-12A.
 *
 * Uso: node load-test/runner.js --scenario=a --profile=medium [--seed=wp12a] [--skip-build]
 *
 * Orquestra: guards anti-produção → cert de teste → dataset → Postgres de teste
 * (initdb/pg_ctl) → prisma db push → seed → mocks HTTPS (loopback) → API (processo
 * filho com env isolado do zero, crons desligados, NODE_EXTRA_CA_CERTS + preload
 * de event-loop lag) → login SUPER_ADMIN → reset do baseline → Cenário A →
 * coleta → relatório JSON+MD com pass/fail → teardown completo.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { generateDataset } = require('./lib/dataset');
const { PROFILES, SCENARIOS } = require('./lib/profiles');
const { ensureTestCert } = require('./lib/certs');
const { MockDoctoralia } = require('./lib/mock-doctoralia');
const { MockVismed } = require('./lib/mock-vismed');
const { TestDb } = require('./lib/testdb');
const { seedDatabase, readConnections, readSyncRuns } = require('./lib/seed');
const { assertAllGuards, assertSafeDatabaseUrl } = require('./lib/guards');
const { Collector } = require('./lib/collector');
const { buildReport, renderMarkdown } = require('./lib/report');

const API_DIR = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(__dirname, '.runtime');
const REPORT_DIR = path.join(__dirname, 'reports');
const DOC_PORT = 45443;
const VIS_PORT = 45444;
const API_PORT = 45080;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const TLS_APPROACH = 'NODE_EXTRA_CA_CERTS apontando para o cert de teste no env do processo filho (abordagem preferida do plano; validação TLS permanece ativa)';

function parseArgs(argv) {
    const args = { scenario: 'a', profile: 'medium', seed: 'wp12a-baseline', skipBuild: false };
    for (const a of argv.slice(2)) {
        const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
        if (!m) continue;
        if (m[1] === 'scenario') args.scenario = m[2];
        if (m[1] === 'profile') args.profile = m[2];
        if (m[1] === 'seed') args.seed = m[2];
        if (m[1] === 'skip-build') args.skipBuild = true;
    }
    if (!SCENARIOS[args.scenario]) throw new Error(`Cenário desconhecido: ${args.scenario} (disponíveis: ${Object.keys(SCENARIOS)})`);
    if (!PROFILES[args.profile]) throw new Error(`Perfil desconhecido: ${args.profile} (disponíveis: ${Object.keys(PROFILES)})`);
    return args;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(base, token, method, p, body) {
    const res = await fetch(`${base}${p}`, {
        method,
        headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* respostas vazias */ }
    return { status: res.status, ok: res.ok, json };
}

async function main() {
    const args = parseArgs(process.argv);
    const scenario = SCENARIOS[args.scenario];
    const log = (msg) => console.log(`[RUNNER] ${new Date().toISOString()} ${msg}`);
    const notes = [];
    const actions = [];
    const startedAt = new Date().toISOString();

    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.mkdirSync(REPORT_DIR, { recursive: true });

    // ── Dataset + cert ──────────────────────────────────────────────────────
    const tls = ensureTestCert(RUNTIME_DIR);
    const dataset = generateDataset({
        profile: args.profile, seed: args.seed, clinics: scenario.clinics,
        doctoraliaHost: `127.0.0.1:${DOC_PORT}`,
        vismedBaseUrl: `https://127.0.0.1:${VIS_PORT}`,
    });
    log(`Dataset gerado: ${dataset.clinics.length} clínicas, perfil ${args.profile}, seed "${args.seed}"`);

    // ── Postgres de teste ───────────────────────────────────────────────────
    const db = new TestDb(RUNTIME_DIR);
    let apiProc = null;
    let docMock = null;
    let visMock = null;
    let collector = null;
    let exitCode = 1;

    const teardown = async () => {
        try { if (collector) await collector.stop(); } catch { }
        if (apiProc && !apiProc.killed) {
            apiProc.kill('SIGTERM');
            await Promise.race([new Promise(r => apiProc.once('exit', r)), sleep(8000)]);
            if (apiProc.exitCode === null) apiProc.kill('SIGKILL');
        }
        try { if (docMock) await docMock.stop(); } catch { }
        try { if (visMock) await visMock.stop(); } catch { }
        db.destroy();
        log('Teardown concluído (API parada, mocks fechados, cluster Postgres destruído).');
    };

    try {
        assertSafeDatabaseUrl(db.url); // guard antes de qualquer criação
        log('Criando cluster Postgres de teste (initdb + pg_ctl, loopback)...');
        db.create();
        if (db.statStatementsUnavailable) notes.push('pg_stat_statements indisponível neste build de Postgres — slow queries não coletadas.');
        log('Aplicando schema Prisma (db push) no banco de teste...');
        db.pushSchema(API_DIR);
        log('Populando banco de teste com o dataset sintético...');
        await seedDatabase(db.url, dataset);

        // ── Guards anti-produção (obrigatórios; recusa iniciar) ─────────────
        const lagFile = path.join(RUNTIME_DIR, 'el-lag.jsonl');
        fs.rmSync(lagFile, { force: true });
        const childEnv = {
            // Env isolado construído DO ZERO — sem secrets do ambiente do runner.
            PATH: process.env.PATH,
            HOME: process.env.HOME || '/tmp',
            NODE_ENV: 'test',
            DATABASE_URL: db.url,
            VISMED_API_PORT: String(API_PORT),
            JWT_SECRET: 'loadtest-only-jwt-secret',
            DISABLE_SYNC_CRON: 'true',
            DISABLE_BOOKING_SWEEP: 'true',
            DISABLE_BLOCK_WATCHER: 'true',
            REDIS_HOST: '127.0.0.1',
            REDIS_PORT: '6379', // nada escutando → fallback direto sem Redis
            NODE_EXTRA_CA_CERTS: tls.certPath,
            NODE_OPTIONS: `--require ${path.join(__dirname, 'lib', 'preload-lag.js')}`,
            LOADTEST_LAG_FILE: lagFile,
            LOADTEST_LAG_INTERVAL_MS: '5000',
        };
        const connections = await readConnections(db.url);
        assertAllGuards({ databaseUrl: db.url, childEnv, connections });
        log(`Guards anti-produção OK (${connections.length} conexões, todas loopback).`);

        // ── Mocks ────────────────────────────────────────────────────────────
        docMock = new MockDoctoralia({ dataset, tls, port: DOC_PORT });
        visMock = new MockVismed({ dataset, tls, port: VIS_PORT });
        await docMock.start();
        await visMock.start();
        log(`Mocks no ar: Doctoralia https://127.0.0.1:${DOC_PORT}, VisMed https://127.0.0.1:${VIS_PORT} (loopback).`);

        // ── API sob teste ────────────────────────────────────────────────────
        const distMain = path.join(API_DIR, 'dist', 'main.js');
        if (!args.skipBuild || !fs.existsSync(distMain)) {
            log('Compilando a API (nest build)...');
            const b = spawnSync('npm', ['run', 'build'], { cwd: API_DIR, encoding: 'utf8' });
            if (b.status !== 0) throw new Error(`Build da API falhou:\n${b.stderr || b.stdout}`);
        }
        const apiLog = fs.createWriteStream(path.join(RUNTIME_DIR, 'api.log'));
        apiProc = spawn('node', [distMain], { cwd: API_DIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        apiProc.stdout.pipe(apiLog);
        apiProc.stderr.pipe(apiLog);
        log(`API iniciada (pid ${apiProc.pid}), aguardando ficar pronta...`);

        let token = null;
        for (let i = 0; i < 120; i++) {
            await sleep(1000);
            if (apiProc.exitCode !== null) throw new Error(`API morreu na inicialização (exit ${apiProc.exitCode}) — ver ${path.join(RUNTIME_DIR, 'api.log')}`);
            try {
                const r = await api(API_BASE, null, 'POST', '/auth/login', {
                    email: dataset.superAdmin.email, password: dataset.superAdmin.password,
                });
                if (r.ok && r.json?.access_token) { token = r.json.access_token; break; }
            } catch { /* ainda subindo */ }
        }
        if (!token) throw new Error('Não foi possível autenticar SUPER_ADMIN na API sob teste (timeout).');
        log('Login SUPER_ADMIN OK.');

        // ── Coleta + reset do baseline ───────────────────────────────────────
        const reset = await api(API_BASE, token, 'POST', '/metrics/doctoralia-baseline/reset');
        if (!reset.ok) throw new Error(`Reset do baseline falhou: HTTP ${reset.status}`);
        collector = new Collector({ apiBase: API_BASE, token, apiPid: apiProc.pid, dbUrl: db.url, lagFile, intervalMs: 5000 });
        collector.start();

        // ── Cenário A ────────────────────────────────────────────────────────
        // Toda ação obrigatória do cenário FALHA o harness em status inesperado —
        // um endpoint rejeitado/inexistente nunca pode virar PASS "sob budget zero".
        const act = async (name, method, p, body, { tolerate = false } = {}) => {
            const t0 = Date.now();
            const r = await api(API_BASE, token, method, p, body);
            actions.push({ name, method, path: p, status: r.status, ms: Date.now() - t0, at: new Date().toISOString() });
            log(`  ${name}: HTTP ${r.status} (${Date.now() - t0}ms)`);
            if (!tolerate && r.status >= 400) {
                throw new Error(`Ação obrigatória "${name}" falhou: ${method} ${p} → HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 300)}`);
            }
            return r;
        };

        const waitForRuns = async (label, timeoutMs = 300_000) => {
            const t0 = Date.now();
            while (Date.now() - t0 < timeoutMs) {
                const runs = await readSyncRuns(db.url);
                const running = runs.filter(r => r.status === 'running');
                if (running.length === 0) { log(`  ${label}: todos os SyncRuns terminaram (${runs.length} no total).`); return; }
                await sleep(2000);
            }
            notes.push(`${label}: timeout aguardando SyncRuns terminarem (${timeoutMs}ms).`);
        };

        for (let w = 1; w <= scenario.globalSyncWindows; w++) {
            log(`— Janela de global sync ${w}/${scenario.globalSyncWindows} —`);
            for (const c of dataset.clinics) {
                await act(`global-sync ${c.id} (janela ${w})`, 'POST', `/sync/${c.id}/global`);
            }
            await waitForRuns(`janela ${w}`);
            await act(`poll Doctoralia (janela ${w})`, 'POST', '/booking-sync/poll');
            for (const c of dataset.clinics) {
                await act(`poll VisMed ${c.id} (janela ${w})`, 'POST', `/booking-sync/poll-vismed?clinicId=${c.id}`);
            }
            await act(`safety-sweep (janela ${w})`, 'POST', '/booking-sync/safety-sweep');
            for (const c of dataset.clinics) {
                // slot sync pode colidir com o guard de concorrência → retry curto,
                // mas TEM de suceder em alguma tentativa (senão o harness falha).
                let slotOk = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    const r = await act(`slot-sync ${c.id} (janela ${w}, tentativa ${attempt})`, 'POST', `/sync/${c.id}/slots`, undefined, { tolerate: true });
                    if (r.status < 400) { slotOk = true; break; }
                    await sleep(5000);
                }
                if (!slotOk) throw new Error(`slot-sync ${c.id} (janela ${w}) falhou nas 3 tentativas`);
            }
            await waitForRuns(`pós-janela ${w}`);
        }

        // ── Drenagem final ───────────────────────────────────────────────────
        log('Aguardando drenagem final das filas (até 120s)...');
        const drainT0 = Date.now();
        while (Date.now() - drainT0 < 120_000) {
            await sleep(5000);
            const snap = collector.baselineSnapshots[collector.baselineSnapshots.length - 1];
            const q = snap?.baseline?.queue ?? {};
            const high = q.DOCTORALIA_QUEUE_SIZE_HIGH ?? 0;
            const low = q.DOCTORALIA_QUEUE_SIZE_LOW ?? 0;
            const runs = await readSyncRuns(db.url);
            if (high === 0 && low === 0 && !runs.some(r => r.status === 'running')) break;
        }
        await collector.stop();

        // ── Relatório ────────────────────────────────────────────────────────
        const endedAt = new Date().toISOString();
        const syncRuns = await readSyncRuns(db.url);
        const { report, passed } = buildReport({
            scenario: args.scenario, profile: args.profile, seed: args.seed,
            startedAt, endedAt,
            docLog: docMock.log, visLog: visMock.log,
            baselineSnapshots: collector.baselineSnapshots,
            processSamples: collector.processSamples,
            pgSamples: collector.pgSamples,
            lagSamples: collector.readLagSamples(),
            syncRuns, actions, notes, tlsApproach: TLS_APPROACH,
            expected: { clinicIds: dataset.clinics.map(c => c.id), windows: scenario.globalSyncWindows },
            statStatementsUnavailable: db.statStatementsUnavailable,
        });
        const stamp = endedAt.replace(/[:.]/g, '-');
        const jsonPath = path.join(REPORT_DIR, `scenario-${args.scenario}-${args.profile}-${stamp}.json`);
        const mdPath = path.join(REPORT_DIR, `scenario-${args.scenario}-${args.profile}-${stamp}.md`);
        fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
        fs.writeFileSync(mdPath, renderMarkdown(report));
        log(`Relatório: ${jsonPath}`);
        log(`Resumo:    ${mdPath}`);
        console.log('\n' + renderMarkdown(report));
        exitCode = passed ? 0 : 2;
    } finally {
        await teardown();
    }
    process.exit(exitCode);
}

main().catch(async (err) => {
    console.error(`[RUNNER] FALHA: ${err.message}`);
    process.exit(1);
});
