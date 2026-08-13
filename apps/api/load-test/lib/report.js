'use strict';
/**
 * Geração do relatório do Cenário (JSON versionável + resumo markdown) e
 * aplicação dos critérios pass/fail automáticos do WP-12A.
 */

function pct(arr, p) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

/**
 * Estabilização de memória (WP-12B): a série não pode crescer monotonicamente
 * sem estabilizar. Heurística documentada (sem threshold de valor absoluto):
 * descartado o warmup (primeiros 25% das amostras), a série FALHA somente se
 * (a) for essencialmente monotônica (≥90% dos deltas não-negativos) E
 * (b) o último quartil continuar crescendo ≥10% sobre o quartil anterior.
 * Crescer e estabilizar (platô) passa; oscilar passa; poucas amostras (<8) é
 * registrado como inconclusivo-mas-pass (limitação anotada no detalhe).
 */
function checkMemoryStabilization(series) {
    const vals = series.filter(v => typeof v === 'number' && v > 0);
    if (vals.length < 8) return { pass: true, detail: `apenas ${vals.length} amostras — inconclusivo (registrado como limitação)` };
    const body = vals.slice(Math.floor(vals.length * 0.25)); // descarta warmup
    let nonNeg = 0;
    for (let i = 1; i < body.length; i++) if (body[i] >= body[i - 1]) nonNeg++;
    const monoRatio = nonNeg / (body.length - 1);
    const q = Math.max(1, Math.floor(body.length / 4));
    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    const lastQ = mean(body.slice(-q));
    const prevQ = mean(body.slice(-2 * q, -q));
    const tailGrowth = prevQ > 0 ? (lastQ - prevQ) / prevQ : 0;
    const monotonicNoPlateau = monoRatio >= 0.9 && tailGrowth >= 0.10;
    return {
        pass: !monotonicNoPlateau,
        detail: `deltas não-negativos=${(monoRatio * 100).toFixed(0)}%, crescimento do último quartil=${(tailGrowth * 100).toFixed(1)}% (falha se ≥90% e ≥10%)`,
        monoRatio, tailGrowth,
    };
}

/**
 * @param {object} input — ver runner.js. Retorna { report, passed }.
 */
function buildReport(input) {
    const {
        scenario, profile, seed, startedAt, endedAt,
        docLog, visLog, baselineSnapshots, processSamples, pgSamples, lagSamples,
        syncRuns, actions, notes = [], tlsApproach, statStatementsUnavailable,
        expected, // { clinicIds: string[], windows: number } — obrigatório p/ o critério de global sync
        baselineComparison = null,   // WP-12B: comparação com o baseline A (cenários b/c/d)
        cleanExit = null,            // WP-12B: { clean, exitCode, waitedMs } do shutdown gracioso da API
        queueJustification = null,   // WP-12B: justificativa explícita p/ QueueFull/Timeout ≠ 0 no cenário D
        partial = false,             // WP-12B: relatório parcial (execução interrompida)
        interruptionReason = null,
        grantDispatchArrival = null, // WP-12C: análise grant × dispatch × arrival (aditivo/informativo)
    } = input;
    if (!expected || !Array.isArray(expected.clinicIds) || !expected.clinicIds.length || !(expected.windows >= 1)) {
        throw new Error('buildReport: "expected" ({clinicIds, windows}) é obrigatório e não pode ser vazio');
    }

    const docSummary = docLog.summary();
    const visSummary = visLog.summary();
    const docBudget = docLog.budgetAudit();

    // Baseline: só snapshots VÁLIDOS contam; coleta quebrada é falha dura, nunca
    // um "zero implícito" que passaria nos critérios de fila/reserva.
    const isValidBaseline = (b) => b && !b.error && b.volume && typeof b.volume.DOCTORALIA_API_REQUEST_COUNT === 'number';
    const validSnapshots = baselineSnapshots.filter(s => isValidBaseline(s.baseline));
    const lastSnapshot = baselineSnapshots[baselineSnapshots.length - 1];
    const baselineHealthy = baselineSnapshots.length > 0 && isValidBaseline(lastSnapshot?.baseline);
    const finalBaseline = baselineHealthy ? lastSnapshot.baseline
        : (validSnapshots.length ? validSnapshots[validSnapshots.length - 1].baseline : {});

    // Filas ao longo do tempo (a partir dos snapshots do baseline)
    const queueSeries = baselineSnapshots.map(s => {
        const q = s.baseline?.queue ?? {};
        return {
            ts: s.ts,
            high: q.DOCTORALIA_QUEUE_SIZE_HIGH ?? q.queueHigh?.current ?? null,
            low: q.DOCTORALIA_QUEUE_SIZE_LOW ?? q.queueLow?.current ?? null,
            peakHigh: q.queueHigh?.max ?? null,
            peakLow: q.queueLow?.max ?? null,
        };
    });

    // Global sync por clínica — avaliado contra o ESPERADO (clínicas × janelas),
    // nunca contra o observado (coleção vazia jamais pode passar por vacuidade).
    const globalRuns = syncRuns.filter(r => r.type === 'full' || r.type === 'vismed-full');
    const clinicIds = expected.clinicIds;
    const perClinic = clinicIds.map(clinicId => {
        const runs = globalRuns.filter(r => r.clinicId === clinicId);
        return {
            clinicId,
            runs: runs.map(r => ({
                type: r.type, status: r.status,
                durationMs: r.endedAt ? new Date(r.endedAt) - new Date(r.startedAt) : null,
            })),
            completed: runs.filter(r => r.status === 'completed').length,
            failed: runs.filter(r => r.status === 'failed').length,
            running: runs.filter(r => r.status === 'running').length,
        };
    });

    // Amostras de processo
    const rssSeries = processSamples.map(s => s.rssBytes).filter(v => v != null);
    const lagMeans = lagSamples.map(s => s.elDelayMeanMs);
    const lagP95s = lagSamples.map(s => s.elDelayP95Ms);
    const heapSeries = lagSamples.map(s => s.heapUsedBytes);

    // ── Critérios pass/fail ─────────────────────────────────────────────────
    const dupWrites = [...docSummary.duplicateWrites, ...visSummary.duplicateWrites];
    const failedRuns = globalRuns.filter(r => r.status === 'failed');
    const stuckRuns = globalRuns.filter(r => r.status === 'running');
    const unmatchedTotal = docSummary.unmatchedPaths.length + visSummary.unmatchedPaths.length;
    const lastQueue = queueSeries[queueSeries.length - 1] ?? {};
    // Dados de fila AUSENTES (null) reprovam — ausência não é zero.
    const queueDrained = lastQueue.high === 0 && lastQueue.low === 0;
    const queueWait = finalBaseline?.queue?.waitMs ?? {};
    // Task 155: o deadline LOW passou a 60s + ε(300ms) + 700ms de margem (=61s)
    // para acomodar o refill com headroom ε — o critério continua o MESMO
    // ("oldest waiter dentro do deadline LOW"), apenas acompanha o valor vigente.
    const LOW_DEADLINE_MS = 61_000;
    const oldestWaiterOk = typeof queueWait.max === 'number' && queueWait.max <= LOW_DEADLINE_MS; // deadline LOW (HIGH 15s coberto por timeouts abaixo)
    const queueTimeouts = sumBaselineCounter(finalBaseline, ['QueueTimeout', 'queueTimeouts', 'timeouts']);
    const queueFull = sumBaselineCounter(finalBaseline, ['QueueFull', 'queueFull', 'rejectedQueueFull']);
    const expiredReservations = sumBaselineCounter(finalBaseline, ['expiredReservations', 'reservationExpired']);

    // Toda clínica esperada precisa completar 'full' E 'vismed-full' em TODAS as janelas.
    const globalSyncComplete = perClinic.every(c =>
        c.runs.filter(r => r.type === 'full' && r.status === 'completed').length >= expected.windows &&
        c.runs.filter(r => r.type === 'vismed-full' && r.status === 'completed').length >= expected.windows);

    // WP-12B: novos checks
    const memRss = checkMemoryStabilization(rssSeries);
    const memHeap = checkMemoryStabilization(heapSeries);
    const queueOverflowOk = queueFull === 0 && queueTimeouts === 0;
    const queueOverflowJustified = scenario === 'd' && !queueOverflowOk && !!queueJustification;

    const criteria = [
        { name: 'Baseline de métricas coletado com sucesso (snapshots válidos, último válido)', pass: baselineHealthy && validSnapshots.length > 0, detail: `${validSnapshots.length}/${baselineSnapshots.length} snapshots válidos` },
        { name: 'Nenhuma rota não-mapeada nos mocks', pass: unmatchedTotal === 0, detail: `${unmatchedTotal} rota(s): ${[...docSummary.unmatchedPaths, ...visSummary.unmatchedPaths].slice(0, 5).join('; ') || '—'}` },
        { name: 'Budget agregado 400/5min nunca excedido (mock Doctoralia)', pass: docBudget.aggOk, detail: `pico ${docBudget.peakAgg5min}/${docBudget.limitAgg5min}` },
        { name: 'Budget WRITE 40/min nunca excedido', pass: docBudget.writesMinOk, detail: `pico ${docBudget.peakWrites1min}/${docBudget.limitWrites1min}` },
        { name: 'Budget WRITE 2.400/h nunca excedido', pass: docBudget.writesHourOk, detail: `pico ${docBudget.peakWrites1h}/${docBudget.limitWrites1h}` },
        { name: 'Zero escrita duplicada nos mocks (janela 120s)', pass: dupWrites.length === 0, detail: `${dupWrites.length} duplicata(s)` },
        { name: 'Filas HIGH/LOW retornam a 0 ao final (dado ausente reprova)', pass: queueDrained, detail: `final high=${lastQueue.high ?? 'SEM DADO'} low=${lastQueue.low ?? 'SEM DADO'}` },
        { name: 'Oldest waiter dentro dos deadlines (≤61s = 60s+ε+margem; timeouts=0; dado ausente reprova)', pass: oldestWaiterOk && queueTimeouts === 0, detail: `waitMs.max=${queueWait.max ?? 'SEM DADO'}, QueueTimeout=${queueTimeouts}` },
        { name: `Toda clínica completa full+vismed-full em ${expected.windows} janela(s) (0 failed, 0 preso)`, pass: failedRuns.length === 0 && stuckRuns.length === 0 && globalSyncComplete, detail: `failed=${failedRuns.length}, running=${stuckRuns.length}, clínicas esperadas=${clinicIds.length}` },
        { name: 'Reservas expiradas = 0 (exige baseline válido)', pass: baselineHealthy && expiredReservations === 0, detail: `expiradas=${expiredReservations}${baselineHealthy ? '' : ' (baseline inválido)'}` },
        // WP-12B — novos checks
        { name: 'Memória RSS estabiliza (sem crescimento monotônico)', pass: memRss.pass, detail: memRss.detail },
        { name: 'Heap usado estabiliza (sem crescimento monotônico)', pass: memHeap.pass, detail: memHeap.detail },
        { name: `QueueFull/QueueTimeout = 0${scenario === 'd' ? ' (ou justificado explicitamente no cenário D)' : ''}`, pass: queueOverflowOk || queueOverflowJustified, detail: `QueueFull=${queueFull}, QueueTimeout=${queueTimeouts}${queueOverflowJustified ? ` — JUSTIFICADO: ${queueJustification}` : ''}` },
        { name: 'API encerra limpa (SIGTERM, sem Promise/timer órfão segurando o processo)', pass: cleanExit ? cleanExit.clean === true : false, detail: cleanExit ? `exit=${cleanExit.exitCode ?? cleanExit.signal ?? '?'} em ${cleanExit.waitedMs}ms${cleanExit.clean ? '' : ' (precisou de SIGKILL ou não saiu no prazo)'}` : 'SEM DADO (shutdown não medido — reprova)' },
    ];
    const passed = criteria.every(c => c.pass) && !partial;

    const report = {
        harness: 'WP-12A/12B',
        scenario, profile, seed,
        partial, interruptionReason,
        startedAt, endedAt,
        durationMs: new Date(endedAt) - new Date(startedAt),
        tlsApproach,
        passed,
        criteria,
        budgets: docBudget,
        mocks: { doctoralia: docSummary, vismed: visSummary },
        counterComparison: buildCounterComparison(docSummary, finalBaseline),
        queues: {
            series: queueSeries,
            waitMs: queueWait,
            queueFull, queueTimeouts,
        },
        circuitBreaker: finalBaseline.circuitBreaker ?? null,
        concurrencyGuard: finalBaseline.concurrencyGuard ?? null,
        writeBudget: finalBaseline.writeBudget ?? null,
        duplicatesReportedByApp: finalBaseline.duplicates ?? null,
        baselineComparison,
        grantDispatchArrival,
        cleanExit,
        memoryStabilization: { rss: memRss, heap: memHeap },
        syncRuns: { perClinic, all: globalRuns },
        actions,
        process: {
            rss: { samples: rssSeries.length, minBytes: Math.min(...rssSeries, Infinity), maxBytes: Math.max(...rssSeries, 0) },
            heapUsed: { samples: heapSeries.length, maxBytes: Math.max(...heapSeries, 0) },
            eventLoopLagMs: { meanP50: pct(lagMeans, 50), meanMax: Math.max(...lagMeans, 0), p95Max: Math.max(...lagP95s, 0), samples: lagSamples.length },
        },
        postgres: {
            samples: pgSamples.length,
            maxConnections: Math.max(...pgSamples.map(s => s.connections?.total ?? 0), 0),
            maxQps: Math.max(...pgSamples.map(s => s.qps ?? 0), 0),
            slowQueries: pgSamples[pgSamples.length - 1]?.slowQueries ?? null,
            statStatementsAvailable: !statStatementsUnavailable,
        },
        baselineFinal: finalBaseline,
        notes,
    };
    return { report, passed };
}

function sumBaselineCounter(baseline, keys) {
    let total = 0;
    const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
            if (keys.some(key => k.toLowerCase() === key.toLowerCase()) && typeof v === 'number') total += v;
            else if (typeof v === 'object') walk(v);
        }
    };
    walk(baseline);
    return total;
}

/** Compara contadores do mock Doctoralia vs. contadores do baseline de métricas. */
function buildCounterComparison(docSummary, baseline) {
    const baselineApi = baseline?.volume?.DOCTORALIA_API_REQUEST_COUNT ?? null;
    const baselineOauth = baseline?.volume?.DOCTORALIA_OAUTH_REQUEST_COUNT ?? null;
    const mockOauth = Object.entries(docSummary.byPathClass)
        .filter(([k]) => k.includes('/oauth/')).reduce((s, [, v]) => s + v, 0);
    const mockApi = docSummary.totalCalls - mockOauth;
    return {
        mockApiCalls: mockApi,
        baselineApiCalls: baselineApi,
        apiDelta: baselineApi === null ? null : mockApi - baselineApi,
        mockOauthCalls: mockOauth,
        baselineOauthCalls: baselineOauth,
        note: 'Delta esperado ≈ 0. Diferenças pequenas podem vir de chamadas em trânsito no último snapshot.',
    };
}

function renderMarkdown(report) {
    const lines = [];
    lines.push(`# Relatório de carga — ${report.harness} (cenário ${report.scenario}, perfil ${report.profile})${report.partial ? ' — ⚠️ PARCIAL' : ''}`);
    lines.push('');
    lines.push(`- **Resultado:** ${report.passed ? '✅ PASS' : '❌ FAIL'}${report.partial ? ' (relatório PARCIAL — execução interrompida)' : ''}`);
    if (report.interruptionReason) lines.push(`- **Motivo da interrupção:** ${report.interruptionReason}`);
    lines.push(`- Seed: \`${report.seed}\` · Duração: ${(report.durationMs / 1000).toFixed(1)}s · ${report.startedAt} → ${report.endedAt}`);
    lines.push(`- TLS: ${report.tlsApproach}`);
    lines.push('');
    lines.push('## Critérios');
    lines.push('| Critério | Resultado | Detalhe |');
    lines.push('|---|---|---|');
    for (const c of report.criteria) lines.push(`| ${c.name} | ${c.pass ? '✅' : '❌'} | ${c.detail} |`);
    lines.push('');
    lines.push('## Budgets (auditados no mock Doctoralia)');
    lines.push(`- Agregado 5min: pico **${report.budgets.peakAgg5min}** / ${report.budgets.limitAgg5min}`);
    lines.push(`- WRITE 1min: pico **${report.budgets.peakWrites1min}** / ${report.budgets.limitWrites1min}`);
    lines.push(`- WRITE 1h: pico **${report.budgets.peakWrites1h}** / ${report.budgets.limitWrites1h}`);
    lines.push('');
    lines.push('## Mocks');
    for (const m of [report.mocks.doctoralia, report.mocks.vismed]) {
        lines.push(`- **${m.mock}**: ${m.totalCalls} chamadas (${m.reads} GET, ${m.writes} WRITE), duplicatas=${m.duplicateWrites.length}, paths não-mapeados=${m.unmatchedPaths.length}`);
    }
    lines.push('');
    lines.push('## Comparação de contadores (mock vs. baseline)');
    const cc = report.counterComparison;
    lines.push(`- API: mock=${cc.mockApiCalls}, baseline=${cc.baselineApiCalls}, Δ=${cc.apiDelta}`);
    lines.push(`- OAuth: mock=${cc.mockOauthCalls}, baseline=${cc.baselineOauthCalls}`);
    lines.push('');
    if (report.baselineComparison) {
        const bc = report.baselineComparison;
        lines.push('## Comparação com o baseline A');
        lines.push(`- Baseline: \`${bc.baselinePath}\` (cenário ${bc.baselineScenario}, ${bc.baselineEndedAt}) · fator de clínicas: ×${bc.clinicFactor}`);
        lines.push('');
        lines.push('| Métrica | Baseline A | Este cenário | Fator |');
        lines.push('|---|---|---|---|');
        for (const m of bc.metrics) lines.push(`| ${m.name} | ${m.baseline ?? '—'} | ${m.current ?? '—'} | ${m.factor != null ? `×${m.factor}` : '—'} |`);
        lines.push('');
        const g = bc.growth;
        lines.push(`- **Crescimento relativo** (esperado ~×${g.clinicFactor} se linear): duração ×${g.durationFactor ?? '—'}, chamadas ×${g.callsFactor ?? '—'}, memória ×${g.memoryFactor ?? '—'}, pico de fila ×${g.queuePeakFactor ?? '—'}, espera p95 ×${g.waitP95Factor ?? '—'}`);
        lines.push('');
    }
    if (report.grantDispatchArrival) {
        const g = report.grantDispatchArrival;
        lines.push('## WP-12C — Grant × Dispatch × Arrival');
        lines.push(`- Correlação: ${g.correlation.correlated}/${g.correlation.internalEvents} eventos internos casados com ${g.correlation.mockArrivals} chegadas do mock (sem chegada: ${g.correlation.internalWithoutArrival}, chegadas sem evento interno: ${g.correlation.arrivalsWithoutInternal})`);
        const wm = g.writeMinute, ag = g.aggregate5Min;
        lines.push(`- WRITE/60s (semântica da auditoria do mock, fronteira inclusiva): grants **${wm.maxGrantsInRollingMinute.max}**, dispatches **${wm.maxDispatchesInRollingMinute.max}**, arrivals **${wm.maxArrivalsInRollingMinute.max}** (limite ${wm.limit})`);
        lines.push(`- WRITE/60s (semântica do limiter, fronteira estrita): grants **${wm.maxGrantsInRollingMinute.maxStrict}**, dispatches **${wm.maxDispatchesInRollingMinute.maxStrict}**, arrivals **${wm.maxArrivalsInRollingMinute.maxStrict}** (limite ${wm.limit})`);
        lines.push(`- Agregado/5min (inclusiva): grants **${ag.maxGrantsInRolling5Min.max}**, dispatches **${ag.maxDispatchesInRolling5Min.max}**, arrivals **${ag.maxArrivalsInRolling5Min.max}** (limite ${ag.limit})`);
        lines.push(`- Agregado/5min (estrita): grants **${ag.maxGrantsInRolling5Min.maxStrict}**, dispatches **${ag.maxDispatchesInRolling5Min.maxStrict}**, arrivals **${ag.maxArrivalsInRolling5Min.maxStrict}** (limite ${ag.limit})`);
        const d = (x) => `min=${x.min}ms p50=${x.p50}ms p95=${x.p95}ms p99=${x.p99}ms max=${x.max}ms (n=${x.count})`;
        lines.push(`- Δ grant→dispatch: ${d(g.deltas.grantToDispatchMs)}`);
        lines.push(`- Δ dispatch→arrival: ${d(g.deltas.dispatchToArrivalMs)}`);
        lines.push(`- Δ (só WRITE) grant→dispatch: ${d(g.deltas.writeOnly.grantToDispatchMs)} · dispatch→arrival: ${d(g.deltas.writeOnly.dispatchToArrivalMs)}`);
        lines.push(`- Hipótese de compressão temporal — semântica inclusiva (auditoria): WRITE/min **${g.hypothesis.compressionConfirmedWrite ? 'CONFIRMADA' : 'NÃO confirmada'}** · agregado/5min **${g.hypothesis.compressionConfirmedAggregate ? 'CONFIRMADA' : 'NÃO confirmada'}**`);
        lines.push(`- Hipótese de compressão temporal — semântica estrita (limiter): WRITE/min **${g.hypothesis.compressionConfirmedWriteStrict ? 'CONFIRMADA' : 'NÃO confirmada'}** · agregado/5min **${g.hypothesis.compressionConfirmedAggregateStrict ? 'CONFIRMADA' : 'NÃO confirmada'}**`);
        lines.push('');
    }
    lines.push('## Filas');
    lines.push(`- waitMs p50=${report.queues.waitMs.p50 ?? '?'} p95=${report.queues.waitMs.p95 ?? '?'} max=${report.queues.waitMs.max ?? '?'} · QueueFull=${report.queues.queueFull} QueueTimeout=${report.queues.queueTimeouts}`);
    lines.push('');
    lines.push('## Global sync por clínica');
    for (const c of report.syncRuns.perClinic) {
        lines.push(`- ${c.clinicId}: completed=${c.completed} failed=${c.failed} running=${c.running} (${c.runs.map(r => `${r.type}:${r.status}${r.durationMs != null ? ` ${r.durationMs}ms` : ''}`).join(', ')})`);
    }
    lines.push('');
    lines.push('## Processo sob teste');
    const pr = report.process;
    lines.push(`- RSS: max ${(pr.rss.maxBytes / 1048576).toFixed(1)} MB · heapUsed max ${(pr.heapUsed.maxBytes / 1048576).toFixed(1)} MB`);
    lines.push(`- Event-loop lag: mean p50=${pr.eventLoopLagMs.meanP50?.toFixed?.(2)}ms, mean max=${pr.eventLoopLagMs.meanMax?.toFixed?.(2)}ms, p95 max=${pr.eventLoopLagMs.p95Max?.toFixed?.(2)}ms (${pr.eventLoopLagMs.samples} amostras via preload)`);
    lines.push('');
    lines.push('## Postgres de teste');
    lines.push(`- Conexões máx: ${report.postgres.maxConnections} · QPS máx (xact/s): ${report.postgres.maxQps} · pg_stat_statements: ${report.postgres.statStatementsAvailable ? 'disponível' : 'indisponível (limitação registrada)'}`);
    if (report.notes.length) {
        lines.push('');
        lines.push('## Notas');
        for (const n of report.notes) lines.push(`- ${n}`);
    }
    return lines.join('\n') + '\n';
}

module.exports = { buildReport, renderMarkdown, sumBaselineCounter, buildCounterComparison };
