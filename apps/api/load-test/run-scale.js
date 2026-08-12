#!/usr/bin/env node
'use strict';
/**
 * WP-12B — Progressão de escala B(10) → C(20) → D(50).
 *
 * Executa os cenários EM ORDEM sobre o runner existente (um processo por
 * cenário; cada relatório é persistido pelo próprio runner assim que o cenário
 * termina). Regra de parada: se um cenário falhar por violação estrutural real
 * (exit != 0), NÃO executa o próximo. Ao final (ou na parada), produz o sumário
 * de escalabilidade em reports/scale-summary-<timestamp>.md/.json.
 *
 * Uso: node load-test/run-scale.js [--profile=medium] [--seed=wp12b] [--skip-build]
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPORT_DIR = path.join(__dirname, 'reports');
const SEQUENCE = ['b', 'c', 'd'];

function parseArgs(argv) {
    const args = { profile: 'medium', seed: 'wp12b-scale', skipBuild: false };
    for (const a of argv.slice(2)) {
        const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
        if (!m) continue;
        if (m[1] === 'profile') args.profile = m[2];
        if (m[1] === 'seed') args.seed = m[2];
        if (m[1] === 'skip-build') args.skipBuild = true;
    }
    return args;
}

function latestReport(scenario, profile, after) {
    const files = fs.readdirSync(REPORT_DIR)
        .filter(f => f.startsWith(`scenario-${scenario}-${profile}-`) && f.endsWith('.json'))
        .sort();
    const name = files[files.length - 1];
    if (!name) return null;
    const p = path.join(REPORT_DIR, name);
    if (after && fs.statSync(p).mtimeMs < after) return null; // não confundir com execução antiga
    try { return { path: p, report: JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch { return null; }
}

function main() {
    const args = parseArgs(process.argv);
    const startedAt = new Date().toISOString();
    const results = [];
    let stopped = null;

    for (let i = 0; i < SEQUENCE.length; i++) {
        const sc = SEQUENCE[i];
        const t0 = Date.now();
        console.log(`\n[SCALE] ===== Cenário ${sc.toUpperCase()} (${args.profile}) =====`);
        const cmdArgs = ['load-test/runner.js', `--scenario=${sc}`, `--profile=${args.profile}`, `--seed=${args.seed}`];
        if (args.skipBuild || i > 0) cmdArgs.push('--skip-build'); // build só na primeira execução
        const r = spawnSync('node', cmdArgs, { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
        const elapsedMs = Date.now() - t0;
        const found = latestReport(sc, args.profile, t0);
        results.push({
            scenario: sc,
            clinics: { b: 10, c: 20, d: 50 }[sc],
            exitCode: r.status,
            passed: r.status === 0,
            elapsedMs,
            reportPath: found ? path.basename(found.path) : null,
            report: found?.report ?? null,
        });
        if (r.status !== 0) {
            stopped = { scenario: sc, exitCode: r.status, reason: r.status === 2 ? 'critérios pass/fail violados (violação estrutural)' : 'erro do harness / interrupção' };
            console.error(`[SCALE] Cenário ${sc.toUpperCase()} falhou (exit ${r.status}) — regra de parada: cenários seguintes NÃO serão executados.`);
            break;
        }
    }

    // ── Sumário de escalabilidade ───────────────────────────────────────────
    const endedAt = new Date().toISOString();
    const healthy = results.filter(r => r.passed);
    const highestHealthy = healthy.length ? healthy[healthy.length - 1] : null;
    const firstFailure = results.find(r => !r.passed) ?? null;

    const bottleneck = (() => {
        if (!firstFailure?.report) return firstFailure ? 'harness interrompido antes de coletar dados suficientes' : 'nenhum gargalo observado até o cenário D';
        const failedCriteria = (firstFailure.report.criteria ?? []).filter(c => !c.pass).map(c => c.name);
        return failedCriteria.length ? failedCriteria.join('; ') : 'falha sem critério reprovado identificado (ver relatório)';
    })();

    const lines = [];
    lines.push(`# Sumário de escalabilidade — WP-12B (perfil ${args.profile})`);
    lines.push('');
    lines.push(`- Execução: ${startedAt} → ${endedAt} · seed \`${args.seed}\``);
    lines.push(`- Ordem executada: ${results.map(r => r.scenario.toUpperCase()).join(' → ')}${stopped ? ` (PARADO em ${stopped.scenario.toUpperCase()}: ${stopped.reason})` : ''}`);
    lines.push('');
    lines.push('| Cenário | Clínicas | Resultado | Tempo | Relatório |');
    lines.push('|---|---|---|---|---|');
    for (const r of results) {
        lines.push(`| ${r.scenario.toUpperCase()} | ${r.clinics} | ${r.passed ? '✅ PASS' : '❌ FAIL'} | ${(r.elapsedMs / 1000).toFixed(1)}s | ${r.reportPath ?? '—'} |`);
    }
    for (const sc of SEQUENCE.filter(s => !results.some(r => r.scenario === s))) {
        lines.push(`| ${sc.toUpperCase()} | ${{ b: 10, c: 20, d: 50 }[sc]} | ⏭️ NÃO EXECUTADO (regra de parada) | — | — |`);
    }
    lines.push('');
    lines.push(`- **Cenário mais alto saudável:** ${highestHealthy ? `${highestHealthy.scenario.toUpperCase()} (${highestHealthy.clinics} clínicas)` : 'nenhum'}`);
    lines.push(`- **Primeiro gargalo observado:** ${bottleneck}`);
    lines.push('');
    lines.push('## Crescimento vs. baseline A (fatores)');
    lines.push('| Cenário | ×clínicas | ×duração | ×chamadas | ×memória | ×pico fila | ×espera p95 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const r of results) {
        const g = r.report?.baselineComparison?.growth;
        if (!g) { lines.push(`| ${r.scenario.toUpperCase()} | — | — | — | — | — | — |`); continue; }
        lines.push(`| ${r.scenario.toUpperCase()} | ×${g.clinicFactor} | ×${g.durationFactor ?? '—'} | ×${g.callsFactor ?? '—'} | ×${g.memoryFactor ?? '—'} | ×${g.queuePeakFactor ?? '—'} | ×${g.waitP95Factor ?? '—'} |`);
    }
    lines.push('');
    lines.push('Detalhes por cenário (stagger, reservas, backpressure, cache/dedup) nos relatórios individuais listados acima.');
    lines.push('');

    const stamp = endedAt.replace(/[:.]/g, '-');
    const mdPath = path.join(REPORT_DIR, `scale-summary-${args.profile}-${stamp}.md`);
    const jsonPath = path.join(REPORT_DIR, `scale-summary-${args.profile}-${stamp}.json`);
    fs.writeFileSync(mdPath, lines.join('\n'));
    fs.writeFileSync(jsonPath, JSON.stringify({
        harness: 'WP-12B', profile: args.profile, seed: args.seed, startedAt, endedAt,
        stopped, highestHealthy: highestHealthy?.scenario ?? null, bottleneck,
        results: results.map(({ report, ...rest }) => ({ ...rest, growth: report?.baselineComparison?.growth ?? null, criteria: report?.criteria ?? null })),
    }, null, 2));
    console.log(`\n[SCALE] Sumário: ${mdPath}`);
    console.log(lines.join('\n'));
    process.exit(stopped ? 2 : 0);
}

main();
