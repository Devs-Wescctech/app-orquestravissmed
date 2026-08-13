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
const { buildReport, renderMarkdown, checkMemoryStabilization } = require('./lib/report');
const { FaultInjector } = require('./lib/fault-injector');
const { buildFaultPlan } = require('./lib/fault-plans');
const { buildFaultReport, renderFaultMarkdown, breakerOf } = require('./lib/fault-report');
const { analyzeGrantDispatchArrival } = require('./lib/grant-dispatch');
const { findBaselineReport, loadBaseline, compareWithBaseline } = require('./lib/baseline-compare');

const API_DIR = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(__dirname, '.runtime');
const REPORT_DIR = path.join(__dirname, 'reports');
const DOC_PORT = 45443;
const VIS_PORT = 45444;
const API_PORT = 45080;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const TLS_APPROACH = 'NODE_EXTRA_CA_CERTS apontando para o cert de teste no env do processo filho (abordagem preferida do plano; validação TLS permanece ativa)';

function parseArgs(argv) {
    const args = { scenario: 'a', profile: 'medium', seed: 'wp12a-baseline', skipBuild: false, baseline: null };
    for (const a of argv.slice(2)) {
        const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
        if (!m) continue;
        if (m[1] === 'scenario') args.scenario = m[2];
        if (m[1] === 'profile') args.profile = m[2];
        if (m[1] === 'seed') args.seed = m[2];
        if (m[1] === 'skip-build') args.skipBuild = true;
        if (m[1] === 'baseline') args.baseline = m[2]; // caminho do JSON do baseline A (12B)
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

    let cleanExit = null; // WP-12B: resultado do shutdown gracioso (medido antes do relatório)
    let rawInternalEvents = []; // WP-12C: eventos brutos da API (grant/dispatch), coletados antes do shutdown
    let authToken = null;

    // WP-13: plano de falhas + marcos da timeline (só em cenários f1–f5)
    const faultPlan = scenario.fault ? buildFaultPlan(scenario.fault, args.seed) : null;
    let faultArmAt = null;
    const faultMarks = {};

    // WP-12C: coleta os eventos brutos (enqueuedAt/releasedAt/sentAt) da API viva.
    const fetchRawEvents = async () => {
        if (!authToken || !apiProc || apiProc.exitCode !== null) return;
        try {
            const r = await api(API_BASE, authToken, 'GET', '/metrics/doctoralia-baseline/raw-events');
            if (r.ok && Array.isArray(r.json?.events)) {
                rawInternalEvents = r.json.events;
                log(`WP-12C: ${rawInternalEvents.length} eventos internos coletados (grant/dispatch).`);
            } else {
                notes.push(`WP-12C: raw-events HTTP ${r.status} — eventos internos não coletados.`);
            }
        } catch (e) {
            notes.push(`WP-12C: falha ao coletar raw-events: ${e.message}`);
        }
    };

    // Shutdown gracioso e MEDIDO da API: SIGTERM e espera; se não sair no prazo,
    // há Promise/timer órfão segurando o processo → SIGKILL e cleanExit=false.
    const shutdownApi = async (timeoutMs = 10_000) => {
        if (!apiProc || apiProc.exitCode !== null) {
            return { clean: false, exitCode: apiProc?.exitCode ?? null, signal: null, waitedMs: 0, note: 'API já estava morta antes do shutdown' };
        }
        const t0 = Date.now();
        apiProc.kill('SIGTERM');
        const exited = await Promise.race([
            new Promise(r => apiProc.once('exit', (code, signal) => r({ code, signal }))),
            sleep(timeoutMs).then(() => null),
        ]);
        const waitedMs = Date.now() - t0;
        if (!exited) {
            apiProc.kill('SIGKILL');
            await Promise.race([new Promise(r => apiProc.once('exit', r)), sleep(5000)]);
            return { clean: false, exitCode: null, signal: 'SIGKILL', waitedMs, note: 'não encerrou com SIGTERM no prazo — Promise/timer órfão provável' };
        }
        // Saída via SIGTERM (signal SIGTERM com code null) ou exit 0 = encerramento limpo.
        const clean = exited.code === 0 || exited.signal === 'SIGTERM';
        return { clean, exitCode: exited.code, signal: exited.signal, waitedMs };
    };

    const teardown = async () => {
        try { if (collector) await collector.stop(); } catch { }
        if (apiProc && !apiProc.killed && apiProc.exitCode === null) {
            apiProc.kill('SIGTERM');
            await Promise.race([new Promise(r => apiProc.once('exit', r)), sleep(8000)]);
            if (apiProc.exitCode === null) apiProc.kill('SIGKILL');
        }
        try { if (docMock) await docMock.stop(); } catch { }
        try { if (visMock) await visMock.stop(); } catch { }
        db.destroy();
        log('Teardown concluído (API parada, mocks fechados, cluster Postgres destruído).');
    };

    // WP-12B: comparação com o baseline A (para cenários != a).
    const buildBaselineComparison = (report) => {
        if (args.scenario === 'a') return null;
        const baselinePath = args.baseline || findBaselineReport(REPORT_DIR, { scenario: 'a', profile: args.profile });
        if (!baselinePath || !fs.existsSync(baselinePath)) {
            notes.push(`Baseline A (JSON) não encontrado em ${REPORT_DIR} — comparação com baseline omitida.`);
            return null;
        }
        try {
            return compareWithBaseline(report, loadBaseline(baselinePath), baselinePath);
        } catch (e) {
            notes.push(`Falha ao comparar com baseline A (${baselinePath}): ${e.message}`);
            return null;
        }
    };

    // Persistência imediata do relatório (completo ou parcial) — nunca sobrescreve
    // anteriores (timestamp no nome) e grava assim que o cenário termina.
    let finalConnections = null; // WP-13: status persistido das conexões ao final
    const persistReport = ({ syncRuns = [], partial = false, interruptionReason = null } = {}) => {
        const endedAt = new Date().toISOString();
        // WP-13: cenários de falha usam o relatório próprio (timeline T0–T6 +
        // critérios de resiliência). Se a falha ocorreu ANTES do arm, cai no
        // relatório padrão (não houve injeção ainda).
        if (faultPlan && faultArmAt !== null && docMock?.log) {
            const { report, passed } = buildFaultReport({
                plan: faultPlan, armAt: faultArmAt, marks: faultMarks,
                docLog: docMock.log, visLog: visMock.log,
                baselineSnapshots: collector?.baselineSnapshots ?? [],
                syncRuns, connections: finalConnections,
                expected: { clinicIds: dataset.clinics.map(c => c.id) },
                actions, notes, cleanExit,
                processSamples: collector?.processSamples ?? [],
                lagSamples: collector?.readLagSamples?.() ?? [],
                scenario: args.scenario, profile: args.profile, seed: args.seed,
                startedAt, endedAt, tlsApproach: TLS_APPROACH,
                partial, interruptionReason,
                memoryCheck: checkMemoryStabilization, sampleIntervalMs: 1500,
            });
            const stamp = endedAt.replace(/[:.]/g, '-');
            const suffix = partial ? '-PARTIAL' : '';
            const jsonPath = path.join(REPORT_DIR, `scenario-${args.scenario}-${args.profile}-${stamp}${suffix}.json`);
            const mdPath = path.join(REPORT_DIR, `scenario-${args.scenario}-${args.profile}-${stamp}${suffix}.md`);
            fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
            fs.writeFileSync(mdPath, renderFaultMarkdown(report));
            if (docMock.log.calls.length) {
                const ndjson = (arr) => arr.map(x => JSON.stringify(x)).join('\n') + '\n';
                fs.writeFileSync(path.join(REPORT_DIR, `scenario-${args.scenario}-${args.profile}-${stamp}${suffix}-mock-arrivals.ndjson`), ndjson(docMock.log.calls));
            }
            log(`Relatório WP-13${partial ? ' PARCIAL' : ''}: ${jsonPath}`);
            log(`Resumo:          ${mdPath}`);
            return { report, passed, jsonPath, mdPath, renderer: 'fault' };
        }
        const emptyLog = (name) => ({
            summary: () => ({ mock: name, totalCalls: 0, reads: 0, writes: 0, duplicateWrites: [], unmatchedPaths: [], byPathClass: {} }),
            budgetAudit: () => ({ peakAgg5min: 0, limitAgg5min: 400, aggOk: true, peakWrites1min: 0, limitWrites1min: 40, writesMinOk: true, peakWrites1h: 0, limitWrites1h: 2400, writesHourOk: true }),
        });
        // WP-12C: análise grant × dispatch × arrival (aditivo/informativo)
        let grantDispatchArrival = null;
        let gdaCorrelated = [];
        try {
            if (rawInternalEvents.length && docMock?.log) {
                const gda = analyzeGrantDispatchArrival({
                    internalEvents: rawInternalEvents,
                    mockCalls: docMock.log.calls,
                });
                gdaCorrelated = gda.correlatedRequests;
                const { correlatedRequests, ...summary } = gda;
                grantDispatchArrival = summary;
            } else {
                notes.push('WP-12C: eventos internos não coletados — análise grant×dispatch×arrival omitida.');
            }
        } catch (e) {
            notes.push(`WP-12C: falha na análise grant×dispatch×arrival: ${e.message}`);
        }
        const { report, passed } = buildReport({
            scenario: args.scenario, profile: args.profile, seed: args.seed,
            startedAt, endedAt,
            docLog: docMock?.log ?? emptyLog('doctoralia'),
            visLog: visMock?.log ?? emptyLog('vismed'),
            baselineSnapshots: collector?.baselineSnapshots ?? [],
            processSamples: collector?.processSamples ?? [],
            pgSamples: collector?.pgSamples ?? [],
            lagSamples: collector?.readLagSamples?.() ?? [],
            syncRuns, actions, notes, tlsApproach: TLS_APPROACH,
            expected: { clinicIds: dataset.clinics.map(c => c.id), windows: scenario.globalSyncWindows },
            statStatementsUnavailable: db.statStatementsUnavailable,
            cleanExit, partial, interruptionReason,
            grantDispatchArrival,
        });
        report.baselineComparison = buildBaselineComparison(report);
        const stamp = endedAt.replace(/[:.]/g, '-');
        const suffix = partial ? '-PARTIAL' : '';
        const jsonPath = path.join(REPORT_DIR, `scenario-${args.scenario}-${args.profile}-${stamp}${suffix}.json`);
        const mdPath = path.join(REPORT_DIR, `scenario-${args.scenario}-${args.profile}-${stamp}${suffix}.md`);
        fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
        fs.writeFileSync(mdPath, renderMarkdown(report));
        // WP-12C: dumps brutos (NDJSON) — eventos internos, chegadas do mock e requisições correlacionadas
        const ndjson = (arr) => arr.map(x => JSON.stringify(x)).join('\n') + (arr.length ? '\n' : '');
        if (rawInternalEvents.length) {
            fs.writeFileSync(path.join(REPORT_DIR, `scenario-${args.scenario}-${args.profile}-${stamp}${suffix}-internal-events.ndjson`), ndjson(rawInternalEvents));
        }
        if (docMock?.log?.calls?.length) {
            fs.writeFileSync(path.join(REPORT_DIR, `scenario-${args.scenario}-${args.profile}-${stamp}${suffix}-mock-arrivals.ndjson`), ndjson(docMock.log.calls));
        }
        if (gdaCorrelated.length) {
            fs.writeFileSync(path.join(REPORT_DIR, `scenario-${args.scenario}-${args.profile}-${stamp}${suffix}-correlated.ndjson`), ndjson(gdaCorrelated));
        }
        log(`Relatório${partial ? ' PARCIAL' : ''}: ${jsonPath}`);
        log(`Resumo:    ${mdPath}`);
        return { report, passed, jsonPath, mdPath };
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
            // WP-12C: habilita o header de correlação API↔mock (inerte fora do harness)
            LOADTEST_CORRELATION_HEADER: 'true',
        };
        const connections = await readConnections(db.url);
        assertAllGuards({ databaseUrl: db.url, childEnv, connections });
        log(`Guards anti-produção OK (${connections.length} conexões, todas loopback).`);

        // ── Mocks ────────────────────────────────────────────────────────────
        docMock = new MockDoctoralia({ dataset, tls, port: DOC_PORT, faultInjector: faultPlan ? new FaultInjector(faultPlan) : null });
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
        authToken = token;
        log('Login SUPER_ADMIN OK.');

        // ── Coleta + reset do baseline ───────────────────────────────────────
        const reset = await api(API_BASE, token, 'POST', '/metrics/doctoralia-baseline/reset');
        if (!reset.ok) throw new Error(`Reset do baseline falhou: HTTP ${reset.status}`);
        // WP-13: durante fault injection a amostragem cai p/ 1,5s (timeline T0–T6)
        collector = new Collector({ apiBase: API_BASE, token, apiPid: apiProc.pid, dbUrl: db.url, lagFile, intervalMs: faultPlan ? 1500 : 5000 });
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

        // Timeouts escalam com o número de clínicas (D=50 leva mais tempo que A=2).
        const runsTimeoutMs = 300_000 + scenario.clinics * 10_000;
        const waitForRuns = async (label, timeoutMs = runsTimeoutMs) => {
            const t0 = Date.now();
            while (Date.now() - t0 < timeoutMs) {
                const runs = await readSyncRuns(db.url);
                const running = runs.filter(r => r.status === 'running');
                if (running.length === 0) { log(`  ${label}: todos os SyncRuns terminaram (${runs.length} no total).`); return; }
                await sleep(2000);
            }
            notes.push(`${label}: timeout aguardando SyncRuns terminarem (${timeoutMs}ms).`);
        };

        // Uma janela completa de sync (global + polls + sweep + slot-sync).
        // strict=false (WP-13): tolera HTTP >=400 (a falha é o objeto do teste;
        // os critérios do relatório julgam a semântica, não o status pontual).
        const runWindow = async (w, { strict = true } = {}) => {
            const tolerate = !strict;
            log(`— Janela de global sync ${w} (${strict ? 'estrita' : 'tolerante'}) —`);
            for (const c of dataset.clinics) {
                await act(`global-sync ${c.id} (janela ${w})`, 'POST', `/sync/${c.id}/global`, undefined, { tolerate });
            }
            await waitForRuns(`janela ${w}`);
            await act(`poll Doctoralia (janela ${w})`, 'POST', '/booking-sync/poll', undefined, { tolerate });
            for (const c of dataset.clinics) {
                await act(`poll VisMed ${c.id} (janela ${w})`, 'POST', `/booking-sync/poll-vismed?clinicId=${c.id}`, undefined, { tolerate });
            }
            await act(`safety-sweep (janela ${w})`, 'POST', '/booking-sync/safety-sweep', undefined, { tolerate });
            // slot sync pode colidir com o guard de concorrência (HTTP 409 é o
            // guard funcionando, não erro): os pollers em background podem segurar
            // o guard de uma clínica por minutos em escala. Round-robin: tenta
            // TODAS as clínicas pendentes por rodada (uma clínica ocupada não
            // serializa as demais), com deadline global que escala com a carga.
            {
                const pending = new Set(dataset.clinics.map(c => c.id));
                const slotDeadlineMs = 300_000 + scenario.clinics * 20_000;
                const slotT0 = Date.now();
                let round = 0;
                while (pending.size && Date.now() - slotT0 < slotDeadlineMs) {
                    round++;
                    for (const id of [...pending]) {
                        const r = await act(`slot-sync ${id} (janela ${w}, rodada ${round})`, 'POST', `/sync/${id}/slots`, undefined, { tolerate: true });
                        if (r.status < 400) pending.delete(id);
                        else if (r.status !== 409 && strict) throw new Error(`slot-sync ${id} (janela ${w}) falhou com HTTP ${r.status} (não é colisão do guard)`);
                        else if (r.status !== 409) pending.delete(id); // tolerante: erro contabilizado nas actions
                    }
                    if (pending.size) await sleep(5000);
                }
                if (pending.size && strict) throw new Error(`slot-sync não conseguiu executar para ${pending.size} clínica(s) em ${Math.round(slotDeadlineMs / 1000)}s (guard ocupado além do deadline): ${[...pending].join(', ')}`);
                if (pending.size) notes.push(`Janela ${w}: slot-sync não executou para ${[...pending].join(', ')} (tolerado no modo fault).`);
            }
            await waitForRuns(`pós-janela ${w}`);
        };

        if (!faultPlan) {
            for (let w = 1; w <= scenario.globalSyncWindows; w++) await runWindow(w);
        } else {
            // ── WP-13: cenário de falha F1–F5 ────────────────────────────────
            log(`WP-13: plano ${faultPlan.key} — ${faultPlan.title}`);
            // T0: janela saudável ESTRITA antes da falha (HEALTHY comprovado)
            await runWindow('T0-healthy', { strict: true });
            faultMarks.healthyDoneAt = Date.now();

            faultArmAt = docMock.faults.arm();
            log(`Injector ARMADO em ${new Date(faultArmAt).toISOString()} — janelas de falha relativas a este instante.`);

            // Bomba de carga contínua durante driveMs: demanda constante expõe
            // retries, abertura do breaker, fast-fail e backpressure.
            const pumpEnd = faultArmAt + faultPlan.driveMs;
            let i = 0;
            while (Date.now() < pumpEnd) {
                const c = dataset.clinics[i % dataset.clinics.length];
                await act(`pump global-sync ${c.id} (#${i})`, 'POST', `/sync/${c.id}/global`, undefined, { tolerate: true });
                if (i % 2 === 0) await act(`pump poll Doctoralia (#${i})`, 'POST', '/booking-sync/poll', undefined, { tolerate: true });
                if (i % 5 === 3) await act(`pump safety-sweep (#${i})`, 'POST', '/booking-sync/safety-sweep', undefined, { tolerate: true });
                i++;
                await sleep(8000);
            }
            faultMarks.driveDoneAt = Date.now();
            log(`Fase de falha encerrada (${i} iterações de pump). Aguardando recuperação (até ${Math.round(faultPlan.recoveryTimeoutMs / 60000)}min)...`);

            // Recuperação: breaker CLOSED (quando aplicável) + filas 0 + sem runs ativos.
            const recDeadline = Date.now() + faultPlan.recoveryTimeoutMs;
            while (Date.now() < recDeadline) {
                await sleep(3000);
                const snap = collector.baselineSnapshots[collector.baselineSnapshots.length - 1];
                const st = breakerOf(snap)?.state ?? 'CLOSED';
                const q = snap?.baseline?.queue ?? {};
                const high = q.DOCTORALIA_QUEUE_SIZE_HIGH ?? 0;
                const low = q.DOCTORALIA_QUEUE_SIZE_LOW ?? 0;
                const runs = await readSyncRuns(db.url);
                if (st === 'CLOSED' && high === 0 && low === 0 && !runs.some(r => r.status === 'running')) break;
            }
            faultMarks.recoveryAt = Date.now();
            log(`Recuperação detectada/deadline em ${new Date(faultMarks.recoveryAt).toISOString()}. Janela final de sync saudável...`);

            // Janela final de sync saudável (tolerante: critérios julgam via SyncRuns)
            await runWindow('T6-final', { strict: false });
            faultMarks.finalWindowDoneAt = Date.now();
        }

        // ── Drenagem final ───────────────────────────────────────────────────
        const drainMaxMs = 120_000 + scenario.clinics * 5_000;
        log(`Aguardando drenagem final das filas (até ${Math.round(drainMaxMs / 1000)}s)...`);
        const drainT0 = Date.now();
        while (Date.now() - drainT0 < drainMaxMs) {
            await sleep(5000);
            const snap = collector.baselineSnapshots[collector.baselineSnapshots.length - 1];
            const q = snap?.baseline?.queue ?? {};
            const high = q.DOCTORALIA_QUEUE_SIZE_HIGH ?? 0;
            const low = q.DOCTORALIA_QUEUE_SIZE_LOW ?? 0;
            const runs = await readSyncRuns(db.url);
            if (high === 0 && low === 0 && !runs.some(r => r.status === 'running')) break;
        }
        await collector.stop();

        // WP-12C: eventos brutos ANTES do shutdown (o buffer vive em memória da API)
        await fetchRawEvents();

        // ── Shutdown gracioso MEDIDO (check de Promise/timer órfão) ─────────
        const syncRuns = await readSyncRuns(db.url);
        try { finalConnections = await readConnections(db.url); } catch { /* SEM DADO reprova no relatório */ }
        log('Encerrando a API com SIGTERM (medindo encerramento limpo)...');
        cleanExit = await shutdownApi();
        log(`Shutdown: clean=${cleanExit.clean} exit=${cleanExit.exitCode ?? cleanExit.signal} em ${cleanExit.waitedMs}ms`);

        // ── Relatório (persistido imediatamente ao término do cenário) ──────
        const { report, passed } = persistReport({ syncRuns });
        console.log('\n' + (faultPlan && faultArmAt !== null ? renderFaultMarkdown(report) : renderMarkdown(report)));
        exitCode = passed ? 0 : 2;
    } catch (err) {
        // Falha/interrupção: gerar relatório PARCIAL se houver dados suficientes,
        // registrando o motivo. Relatórios anteriores nunca são apagados.
        console.error(`[RUNNER] FALHA: ${err.message}`);
        try {
            const hasData = actions.length > 0 || (collector?.baselineSnapshots?.length ?? 0) > 0;
            if (hasData) {
                await fetchRawEvents().catch(() => { }); // WP-12C: melhor esforço no parcial
                let syncRuns = [];
                try { syncRuns = await readSyncRuns(db.url); } catch { }
                if (!finalConnections) { try { finalConnections = await readConnections(db.url); } catch { } }
                persistReport({ syncRuns, partial: true, interruptionReason: err.message });
            } else {
                log('Sem dados suficientes para relatório parcial — nenhum relatório gravado.');
            }
        } catch (e2) {
            console.error(`[RUNNER] Falha ao gravar relatório parcial: ${e2.message}`);
        }
        exitCode = 1;
    } finally {
        await teardown();
    }
    process.exit(exitCode);
}

main().catch(async (err) => {
    console.error(`[RUNNER] FALHA: ${err.message}`);
    process.exit(1);
});
