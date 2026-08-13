#!/usr/bin/env node
'use strict';
/**
 * WP-13 — Bateria progressiva de fault injection: Baseline (cenário b, controle
 * saudável, mesma seed) → F1 → F2 → F3 → F4 → F5, um por vez.
 *
 * REGRA DE PARADA: no primeiro FAIL estrutural, PARAR a bateria, manter o
 * relatório do cenário e identificar a primeira limitação estrutural — sem
 * corrigir código, sem alterar parâmetros, sem relaxar critérios, sem repetir
 * para passar. (Erro do próprio harness — runner crashou sem relatório — não é
 * FAIL estrutural: é reportado como erro de execução e também interrompe.)
 *
 * Uso: node load-test/run-faults.js [--seed=wp13] [--skip-build] [--only=f2]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(__dirname, 'reports');

const args = { seed: 'wp13', skipBuild: false, only: null };
for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[1] === 'seed') args.seed = m[2];
    if (m[1] === 'skip-build') args.skipBuild = true;
    if (m[1] === 'only') args.only = m[2];
}

const SEQUENCE = args.only ? [args.only] : ['b', 'f1', 'f2', 'f3', 'f4', 'f5'];

function newestReport(scenario, sinceMs) {
    const files = fs.readdirSync(REPORT_DIR)
        .filter(f => f.startsWith(`scenario-${scenario}-medium-`) && f.endsWith('.json'))
        .map(f => ({ f, t: fs.statSync(path.join(REPORT_DIR, f)).mtimeMs }))
        .filter(x => x.t >= sinceMs)
        .sort((a, b) => b.t - a.t);
    return files[0] ? path.join(REPORT_DIR, files[0].f) : null;
}

function runOne(scenario, skipBuild) {
    return new Promise((resolve) => {
        const argv = ['load-test/runner.js', `--scenario=${scenario}`, '--profile=medium', `--seed=${args.seed}`];
        if (skipBuild) argv.push('--skip-build');
        const t0 = Date.now();
        const child = spawn('node', argv, { cwd: ROOT, stdio: 'inherit' });
        child.on('exit', (code) => resolve({ code, reportPath: newestReport(scenario, t0) }));
    });
}

function summarize(reportPath) {
    const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const failed = (r.criteria ?? []).filter(c => !c.pass);
    return {
        scenario: r.scenario, passed: r.passed, partial: r.partial ?? false,
        durationMs: r.durationMs, timeline: r.timeline ?? null,
        budgets: r.budgets ? { peakAgg5min: r.budgets.peakAgg5min, peakWrites1min: r.budgets.peakWrites1min, peakWrites1h: r.budgets.peakWrites1h } : null,
        queues: r.queues ?? null, breaker: r.circuitBreakerFinal ?? null,
        injected: r.injectedFaults ?? null,
        failedCriteria: failed.map(c => `${c.name} — ${c.detail}`),
        reportPath,
    };
}

async function main() {
    const results = [];
    let stopped = null;
    let skipBuild = args.skipBuild;
    for (const scenario of SEQUENCE) {
        console.log(`\n════════ WP-13: executando cenário ${scenario} (seed ${args.seed}) ════════\n`);
        const { code, reportPath } = await runOne(scenario, skipBuild);
        skipBuild = true; // build só na primeira execução
        if (!reportPath) {
            stopped = { scenario, reason: `runner saiu com código ${code} sem gerar relatório (erro de execução do harness)` };
            console.error(`\n✋ PARADA: ${stopped.reason}`);
            break;
        }
        const s = summarize(reportPath);
        results.push(s);
        console.log(`\n→ Cenário ${scenario}: ${s.passed ? '✅ PASS' : '❌ FAIL'} (${s.failedCriteria.length} critério(s) reprovado(s))`);
        if (!s.passed) {
            stopped = { scenario, reason: `FAIL estrutural no cenário ${scenario}: ${s.failedCriteria[0] ?? 'ver relatório'}` };
            console.error(`\n✋ REGRA DE PARADA acionada — bateria interrompida no cenário ${scenario}. Sem correções, sem repetição.`);
            break;
        }
    }

    // ── Relatório consolidado ────────────────────────────────────────────────
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const consolidated = { harness: 'WP-13', seed: args.seed, sequence: SEQUENCE, stopped, results };
    const jsonPath = path.join(REPORT_DIR, `wp13-consolidado-${stamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(consolidated, null, 2));

    const L = [];
    L.push('# WP-13 — Relatório consolidado: Baseline saudável vs. F1–F5');
    L.push('');
    L.push(`- Seed: \`${args.seed}\` · Sequência: ${SEQUENCE.join(' → ')}`);
    if (stopped) L.push(`- **✋ Bateria interrompida no cenário \`${stopped.scenario}\`** — ${stopped.reason}`);
    else L.push('- ✅ Bateria completa sem FAIL estrutural.');
    L.push('');
    L.push('| Cenário | Resultado | Duração | Pico agg 5min | Pico WRITE/min | Breaker (opens/probes/fastFails) | QueueFull/Timeout | Detecção | OPEN total | Recuperação pós-T3 | Drenagem |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const s of results) {
        const t = s.timeline; const d = t?.deltas ?? {};
        const opens = s.breaker ? Object.entries(s.breaker.transitions ?? {}).filter(([k]) => k.endsWith('->OPEN')).reduce((a, [, v]) => a + v, 0) : 0;
        const openTotal = t?.openIntervals?.reduce((a, i) => a + i.durationMs, 0) ?? null;
        const ms = (v) => v == null ? '—' : `${(v / 1000).toFixed(1)}s`;
        L.push(`| ${s.scenario} | ${s.passed ? '✅ PASS' : '❌ FAIL'} | ${(s.durationMs / 1000 / 60).toFixed(1)}min | ${s.budgets?.peakAgg5min ?? '—'}/400 | ${s.budgets?.peakWrites1min ?? '—'}/40 | ${opens}/${s.breaker?.probesExecuted ?? '—'}/${s.breaker?.fastFails ?? '—'} | ${s.queues ? `${s.queues.queueFull ?? 0}/${s.queues.queueTimeouts ?? 0}` : '—'} | ${ms(d.detectionMs)} | ${ms(openTotal)} | ${ms(d.recoveryDetectMs)} | ${ms(d.drainMs)} |`);
    }
    L.push('');
    for (const s of results.filter(x => x.failedCriteria.length)) {
        L.push(`## Critérios reprovados — ${s.scenario}`);
        for (const c of s.failedCriteria) L.push(`- ❌ ${c}`);
        L.push('');
    }
    L.push('## Relatórios individuais');
    for (const s of results) L.push(`- ${s.scenario}: \`${path.basename(s.reportPath)}\``);
    const mdPath = path.join(REPORT_DIR, `wp13-consolidado-${stamp}.md`);
    fs.writeFileSync(mdPath, L.join('\n') + '\n');
    console.log(`\nConsolidado: ${jsonPath}\n             ${mdPath}`);
    process.exit(stopped ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
