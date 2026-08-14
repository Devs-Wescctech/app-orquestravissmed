'use strict';
/**
 * WP-13 — Relatório dos cenários de falha F1–F5: timeline T0–T6 reconstruída a
 * partir dos snapshots do baseline (amostragem 1,5s durante WP-13) correlacionados
 * com o CallLog do mock, mais os critérios PASS/FAIL automáticos por cenário.
 *
 * Timeline:
 *  T0 HEALTHY (arm do injector, após janela saudável) → T1 falha inicia (1ª
 *  injeção no CallLog) → T2 proteção reage (1º snapshot com breaker != CLOSED,
 *  ou 1ª rejeição de fila no F5) → T3 mock volta a 200 (fim da última janela de
 *  falha) → T4 recuperação detectada (1º snapshot CLOSED após T3 / 1ª resposta
 *  200 após T3 no F5) → T5 filas drenadas → T6 HEALTHY (janela final de sync
 *  saudável completa).
 */

function pickQueue(snap) {
    const q = snap?.baseline?.queue ?? {};
    return {
        high: q.DOCTORALIA_QUEUE_SIZE_HIGH ?? q.queueHigh?.current ?? null,
        low: q.DOCTORALIA_QUEUE_SIZE_LOW ?? q.queueLow?.current ?? null,
    };
}

function breakerOf(snap) {
    // Formato do baseline: circuitBreaker.byDomain = { '<host>': entry }.
    const cb = snap?.baseline?.circuitBreaker;
    if (!cb) return null;
    const domains = cb.byDomain ? Object.values(cb.byDomain) : (Array.isArray(cb) ? cb : [cb]);
    const one = domains[0];
    if (!one || typeof one !== 'object') return null;
    return {
        state: one.state ?? 'CLOSED',
        transitions: one.transitions ?? {},
        fastFails: one.fastFails ?? 0,
        probesExecuted: one.probesStarted ?? one.probesExecuted ?? 0,
        probesSucceeded: one.probesSucceeded ?? 0,
        probesFailed: one.probesFailed ?? 0,
        openReason: one.openReason ?? null,
        cooldownMs: one.cooldownMs ?? null,
    };
}

function sumCounter(baseline, keys) {
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

/** Intervalos contíguos em que o breaker esteve em `state` segundo os snapshots. */
function stateIntervals(snapshots, state) {
    const intervals = [];
    let cur = null;
    for (const s of snapshots) {
        const b = breakerOf(s);
        const st = b?.state ?? 'CLOSED';
        if (st === state) {
            if (!cur) cur = { start: s.ts, end: s.ts };
            else cur.end = s.ts;
        } else if (cur) { intervals.push(cur); cur = null; }
    }
    if (cur) intervals.push(cur);
    return intervals;
}

/**
 * @param {object} input
 *  plan, armAt (ms), marks {healthyDoneAt, driveDoneAt, recoveryAt, finalWindowDoneAt},
 *  docLog, visLog, baselineSnapshots, syncRuns, expected {clinicIds}, actions, notes,
 *  cleanExit, processSamples, lagSamples, scenario/profile/seed/startedAt/endedAt,
 *  partial/interruptionReason, memoryCheck (fn), sampleIntervalMs
 */
function buildFaultReport(input) {
    const {
        plan, armAt, marks = {}, docLog, visLog, baselineSnapshots, syncRuns,
        connections = null, expected, actions, notes = [], cleanExit = null,
        processSamples = [], lagSamples = [],
        scenario, profile, seed, startedAt, endedAt, tlsApproach,
        partial = false, interruptionReason = null,
        memoryCheck, sampleIntervalMs = 1500,
        internalEvents = [],
    } = input;

    const docSummary = docLog.summary();
    const visSummary = visLog.summary();
    const docBudget = docLog.budgetAudit();
    const calls = docLog.calls;
    const tol = sampleIntervalMs + 700; // tolerância de amostragem p/ correlação snapshot×evento

    const faultRules = plan.rules.filter(r => r.action !== 'shortToken');
    const faultEndMs = Math.max(...faultRules.map(r => r.endMs));
    const injected = calls.filter(c => c.faultTag && c.faultTag !== 'F4-short-token');

    // ── Timeline T0–T6 ──────────────────────────────────────────────────────
    const T0 = armAt;
    const T1 = injected.length ? injected[0].ts : null;
    const T3 = armAt + faultEndMs;

    const snaps = baselineSnapshots.filter(s => s.baseline && !s.baseline.error);
    const openIntervals = stateIntervals(snaps, 'OPEN');
    const halfOpenIntervals = stateIntervals(snaps, 'HALF_OPEN');
    const firstNonClosed = snaps.find(s => {
        const b = breakerOf(s); return b && b.state !== 'CLOSED' && s.ts >= (T1 ?? 0);
    });

    // Série de rejeições de fila (p/ F5: "proteção reage" = 1ª rejeição)
    const queueRejectSeries = snaps.map(s => ({
        ts: s.ts,
        rejects: sumCounter(s.baseline, ['QueueFull', 'queueFull', 'rejectedQueueFull'])
            + sumCounter(s.baseline, ['QueueTimeout', 'queueTimeouts', 'timeouts']),
    }));
    const firstQueueReject = queueRejectSeries.find(x => x.rejects > 0);

    const T2 = plan.expected.breakerOpens
        ? (firstNonClosed?.ts ?? null)
        : (firstQueueReject?.ts ?? null);

    const T4 = plan.expected.breakerOpens
        ? (snaps.find(s => s.ts > T3 && (breakerOf(s)?.state ?? 'CLOSED') === 'CLOSED'
            && !openIntervals.some(i => s.ts >= i.start && s.ts <= i.end))?.ts
            ?? (calls.find(c => c.ts > T3 && !c.faultTag && c.status === 200)?.ts ?? null))
        : (calls.find(c => c.ts > T3 && !c.faultTag && c.status === 200)?.ts ?? null);

    const T5 = snaps.find(s => s.ts >= (T4 ?? T3) && pickQueue(s).high === 0 && pickQueue(s).low === 0)?.ts ?? null;
    const T6 = marks.finalWindowDoneAt ?? null;

    const dur = (a, b) => (a != null && b != null) ? b - a : null;
    const timeline = {
        T0_healthyArmAt: T0, T1_faultStart: T1, T2_protectionReacts: T2,
        T3_mockRecovered: T3, T4_recoveryDetected: T4, T5_queuesDrained: T5, T6_healthyAgain: T6,
        deltas: {
            detectionMs: dur(T1, T2),
            faultDurationMs: dur(T1, T3),
            recoveryDetectMs: dur(T3, T4),
            drainMs: dur(T4, T5),
            healthyAgainMs: dur(T5, T6),
            totalMs: dur(T0, T6),
        },
        openIntervals: openIntervals.map(i => ({ ...i, durationMs: i.end - i.start })),
        halfOpenIntervals,
    };

    // ── Dados p/ critérios ─────────────────────────────────────────────────
    const lastSnap = snaps[snaps.length - 1] ?? null;
    const finalBaseline = lastSnap?.baseline ?? {};
    const finalBreaker = breakerOf(lastSnap);
    const lastQueue = lastSnap ? pickQueue(lastSnap) : { high: null, low: null };
    const queueFull = sumCounter(finalBaseline, ['QueueFull', 'queueFull', 'rejectedQueueFull']);
    const queueTimeouts = sumCounter(finalBaseline, ['QueueTimeout', 'queueTimeouts', 'timeouts']);
    const queueWait = finalBaseline?.queue?.waitMs ?? {};

    // Duplicatas: OAuth avaliado à parte (refreshes legítimos com TTL curto no F4
    // são espaçados ~120s; corrida real = mesmo auth em <5s).
    const isOauth = (d) => d.path.startsWith('/oauth/');
    const dupWrites = [...docSummary.duplicateWrites.filter(d => !isOauth(d)), ...visSummary.duplicateWrites];
    const oauthCalls = calls.filter(c => c.path.startsWith('/oauth/') && c.method === 'POST' && !c.faultTag);
    const oauthRaces = [];
    const lastByAuth = new Map();
    for (const c of oauthCalls) {
        const key = c.bodyHash ?? 'none';
        const prev = lastByAuth.get(key);
        if (prev !== undefined && c.ts - prev < 5_000) oauthRaces.push({ path: c.path, deltaMs: c.ts - prev });
        lastByAuth.set(key, c.ts);
    }

    // Critério revisado (Task 162): o que importa é NENHUM HTTP NOVO ser
    // INICIADO (dispatch/sentAt) após o OPEN — requests em voo iniciadas antes
    // do OPEN podem legitimamente CHEGAR ao mock depois. Correlacionamos cada
    // arrival durante OPEN com o evento interno (sentAt) via correlationId:
    //  - dispatch ANTES do openStart (+tol) → in-flight legítimo, não viola;
    //  - dispatch DEPOIS do openStart (+tol) → violação (novo HTTP em OPEN).
    // Fallback: arrival sem evento interno correlacionado usa a graça antiga.
    const grace = plan.inflightGraceMs ?? 5_000;
    const sentAtByCorrelation = new Map();
    for (const e of internalEvents) {
        if (e?.doctoraliaRequestId != null && typeof e.sentAt === 'number') {
            sentAtByCorrelation.set(e.doctoraliaRequestId, e.sentAt);
        }
    }
    const arrivalsDuringOpen = [];   // todos os arrivals no meio de um intervalo OPEN (informativo)
    const newDispatchesDuringOpen = []; // violações: HTTP INICIADO após o OPEN
    for (const i of openIntervals) {
        for (const c of calls) {
            // OAuth não passa pelo breaker (endpoint distinto; renovação de token
            // é legítima mesmo em OPEN) — fora do critério, como no scan interno.
            if (typeof c.path === 'string' && c.path.includes('/oauth/')) continue;
            if (c.ts > i.start + tol && c.ts < i.end - tol) {
                const sentAt = c.correlationId != null ? sentAtByCorrelation.get(c.correlationId) : undefined;
                const entry = {
                    ts: c.ts, method: c.method, path: c.path, faultTag: c.faultTag,
                    openStart: i.start, sentAt: sentAt ?? null,
                    inFlightBeforeOpen: sentAt !== undefined ? sentAt <= i.start + tol : null,
                };
                arrivalsDuringOpen.push(entry);
                const violates = sentAt !== undefined
                    ? sentAt > i.start + tol
                    : c.ts > i.start + Math.max(tol, grace); // sem correlação: graça antiga
                if (violates) newDispatchesDuringOpen.push(entry);
            }
        }
    }

    // Varredura INDEPENDENTE de arrivals: TODO evento interno com sentAt dentro
    // de um intervalo OPEN é violação, mesmo que a resposta nunca chegue ao mock,
    // chegue fora do intervalo, ou seja atrasada em trânsito. A probe autorizada
    // dispara em HALF_OPEN (fora dos intervalos OPEN, respeitada a tolerância de
    // amostragem `tol`), portanto não entra aqui.
    const seenViolations = new Set(newDispatchesDuringOpen.map(e => e.sentAt ?? e.ts));
    for (const e of internalEvents) {
        if (typeof e?.sentAt !== 'number') continue;
        if (e.isOAuth) continue; // OAuth não passa pelo breaker (endpoint distinto)
        for (const i of openIntervals) {
            if (e.sentAt > i.start + tol && e.sentAt < i.end - tol) {
                if (!seenViolations.has(e.sentAt)) {
                    seenViolations.add(e.sentAt);
                    newDispatchesDuringOpen.push({
                        ts: null, method: e.method ?? null, path: e.endpoint ?? e.path ?? null,
                        faultTag: null, openStart: i.start, sentAt: e.sentAt,
                        inFlightBeforeOpen: false, source: 'internal-sentAt-scan',
                    });
                }
                break;
            }
        }
    }

    // Fila não cresce durante OPEN
    let queueGrewDuringOpen = false;
    for (const i of openIntervals) {
        const inSnaps = snaps.filter(s => s.ts >= i.start && s.ts <= i.end).map(pickQueue);
        if (inSnaps.length >= 2) {
            const first = (inSnaps[0].high ?? 0) + (inSnaps[0].low ?? 0);
            const maxIn = Math.max(...inSnaps.map(q => (q.high ?? 0) + (q.low ?? 0)));
            if (maxIn > first + 2) queueGrewDuringOpen = true;
        }
    }

    // Breaker: transições/probes do snapshot final
    const transitions = finalBreaker?.transitions ?? {};
    const opens = (transitions['CLOSED->OPEN'] ?? 0) + (transitions['HALF_OPEN->OPEN'] ?? 0);
    const halfOpens = transitions['OPEN->HALF_OPEN'] ?? 0;
    const probesExecuted = finalBreaker?.probesExecuted ?? 0;
    const fastFails = finalBreaker?.fastFails ?? 0;
    const breakerEverOpen = openIntervals.length > 0 || opens > 0;

    // Global sync: pós-recuperação toda clínica completa full + vismed-full
    const clinicIds = expected.clinicIds;
    const globalRuns = syncRuns.filter(r => r.type === 'full' || r.type === 'vismed-full');
    const stuckRuns = globalRuns.filter(r => r.status === 'running');
    const recoveredAfter = marks.recoveryAt ?? T4 ?? T3;
    const postRecovery = globalRuns.filter(r => new Date(r.startedAt).getTime() >= recoveredAfter);
    const postRecoveryMissing = [];
    for (const id of clinicIds) {
        for (const type of ['full', 'vismed-full']) {
            if (!postRecovery.some(r => r.clinicId === id && r.type === type && r.status === 'completed')) {
                const found = postRecovery.filter(r => r.clinicId === id && r.type === type);
                postRecoveryMissing.push(`${id}/${type}=${found.length ? found.map(r => r.status).join(',') : 'AUSENTE'}`);
            }
        }
    }
    const postRecoveryComplete = postRecoveryMissing.length === 0;

    const memRss = memoryCheck(processSamples.map(s => s.rssBytes).filter(v => v != null));
    const memHeap = memoryCheck(lagSamples.map(s => s.heapUsedBytes).filter(v => v != null));

    const exp = plan.expected;
    const criteria = [];
    const add = (name, pass, detail) => criteria.push({ name, pass: !!pass, detail });

    // ── Invariantes comuns ─────────────────────────────────────────────────
    add('Budget agregado 400/5min nunca excedido (mock)', docBudget.aggOk, `pico ${docBudget.peakAgg5min}/${docBudget.limitAgg5min}`);
    add('Budget WRITE 40/min nunca excedido', docBudget.writesMinOk, `pico ${docBudget.peakWrites1min}/${docBudget.limitWrites1min}`);
    add('Budget WRITE 2.400/h nunca excedido', docBudget.writesHourOk, `pico ${docBudget.peakWrites1h}/${docBudget.limitWrites1h}`);
    add('Zero writes duplicados (mocks; OAuth avaliado à parte)', dupWrites.length === 0, `${dupWrites.length} duplicata(s)`);
    add('Zero POST OAuth duplicado por corrida (<5s mesmo credential)', oauthRaces.length === 0, `${oauthRaces.length} corrida(s); ${oauthCalls.length} refresh(es) legítimos`);
    add('Snapshots do baseline coletados (colector 1,5s)', snaps.length > 10, `${snaps.length} snapshots válidos`);
    add('Falhas injetadas registradas no CallLog com tag da regra', injected.length > 0, `${injected.length} injeções (${[...new Set(injected.map(c => c.faultTag))].join(', ')})`);

    // ── Breaker abre somente quando deveria ────────────────────────────────
    if (exp.breakerOpens) {
        add('Breaker ABRIU durante a falha (como deveria)', breakerEverOpen, `opens=${opens}, intervalos OPEN observados=${openIntervals.length}`);
        if (exp.noOpenBeforeMs != null) {
            const early = snaps.find(s => (breakerOf(s)?.state ?? 'CLOSED') !== 'CLOSED' && s.ts < armAt + exp.noOpenBeforeMs - tol);
            add(`F1-A: breaker permanece CLOSED na sub-janela intermitente (até +${Math.round(exp.noOpenBeforeMs / 1000)}s)`, !early, early ? `estado ${breakerOf(early)?.state} em +${Math.round((early.ts - armAt) / 1000)}s` : 'nenhum estado != CLOSED antes do F1-B');
        }
        add('Durante OPEN: zero HTTPs NOVOS iniciados (fast-fail; in-flight pré-OPEN pode chegar; fila não cresce)',
            newDispatchesDuringOpen.length === 0 && !queueGrewDuringOpen && fastFails > 0,
            `novos dispatches em OPEN=${newDispatchesDuringOpen.length}, arrivals em OPEN=${arrivalsDuringOpen.length} ` +
            `(in-flight pré-OPEN=${arrivalsDuringOpen.filter(a => a.inFlightBeforeOpen === true).length}), ` +
            `filaCresceu=${queueGrewDuringOpen}, fastFails=${fastFails}`);
        add('HALF_OPEN com exatamente 1 probe por ciclo', probesExecuted === halfOpens && halfOpens >= 1, `probes=${probesExecuted}, transições OPEN->HALF_OPEN=${halfOpens}`);
        add('Após recuperação: breaker volta a CLOSED', (finalBreaker?.state ?? null) === 'CLOSED', `estado final=${finalBreaker?.state ?? 'SEM DADO'}`);
        if (exp.minOpens) add(`Breaker abriu ≥${exp.minOpens}× (duas janelas de falha)`, opens >= exp.minOpens, `opens=${opens}`);
        if (exp.reopenDoubled) {
            const durations = openIntervals.map(i => i.end - i.start);
            const ratio = durations.length >= 2 ? durations[1] / durations[0] : null;
            add('F2: 1ª probe falhou e reabriu com cooldown DOBRADO (progressivo)', halfOpens >= 2 && (transitions['HALF_OPEN->OPEN'] ?? 0) >= 1 && ratio != null && ratio >= 1.5 && ratio <= 2.8,
                `HALF_OPEN->OPEN=${transitions['HALF_OPEN->OPEN'] ?? 0}, durações OPEN=${durations.map(d => Math.round(d / 1000) + 's').join(', ')} (razão ${ratio ? ratio.toFixed(2) : '—'}, esperado ~2)`);
        }
        if (exp.isWaf) {
            const firstWaf = injected.find(c => c.faultTag?.startsWith('F4A'));
            const openAfterWaf = firstWaf ? snaps.find(s => s.ts >= firstWaf.ts && (breakerOf(s)?.state ?? '') === 'OPEN') : null;
            add('F4: abertura IMEDIATA em 1 resposta WAF', firstWaf && openAfterWaf && (openAfterWaf.ts - firstWaf.ts) <= tol + 3_000,
                firstWaf ? `WAF em ${new Date(firstWaf.ts).toISOString()}, OPEN detectado ${openAfterWaf ? '+' + (openAfterWaf.ts - firstWaf.ts) + 'ms' : 'NUNCA'}` : 'nenhuma resposta WAF F4A registrada');
            const wafByCorrelation = new Map();
            let wafRetries = 0;
            for (const c of calls) {
                if (c.faultTag?.includes('waf') && c.correlationId) wafByCorrelation.set(c.correlationId, c.ts);
                else if (c.correlationId && wafByCorrelation.has(c.correlationId)) wafRetries++;
            }
            add('F4: zero retry do request WAFado (405 é não-retryable)', wafRetries === 0, `${wafRetries} reenvio(s) com o mesmo correlationId de uma resposta WAF`);
            const shortOpens = openIntervals.filter(i => (i.end - i.start) < (exp.wafCooldownMinMs ?? 290_000));
            add('F4: cooldown WAF ≥5min em cada OPEN', openIntervals.length >= 1 && shortOpens.length === 0,
                `durações OPEN=${openIntervals.map(i => Math.round((i.end - i.start) / 1000) + 's').join(', ')} (mínimo exigido ${(exp.wafCooldownMinMs ?? 290000) / 1000}s)`);
        }
    } else {
        add('Breaker NUNCA abre (falha não é do host: lentidão/backpressure)', !breakerEverOpen && !firstNonClosed, `opens=${opens}, snapshots != CLOSED=${firstNonClosed ? 1 : 0}`);
    }

    // Status persistido das conexões: NENHUMA falha injetada pode marcar a
    // integração como 'error' (isso tiraria a clínica do polling silenciosamente).
    // Em especial no F5: QueueFull/QueueTimeout não podem virar status error.
    const errorConns = (connections ?? []).filter(c => String(c.status ?? '').toLowerCase() === 'error');
    add('Nenhuma conexão marcada como status \'error\' no banco (dado ausente reprova)',
        Array.isArray(connections) && connections.length > 0 && errorConns.length === 0,
        connections ? `${connections.length} conexões, ${errorConns.length} em 'error'${errorConns.length ? ': ' + errorConns.map(c => `${c.clinicId}/${c.provider}`).join(', ') : ''}` : 'SEM DADO');

    // ── Backpressure / filas ───────────────────────────────────────────────
    if (exp.queuePressureExpected) {
        add('F5: QueueFull/QueueTimeout OCORRERAM (backpressure engajou)', (queueFull + queueTimeouts) > 0, `QueueFull=${queueFull}, QueueTimeout=${queueTimeouts}`);
        add('F5: QueueFull/QueueTimeout NÃO alimentaram o breaker', !breakerEverOpen, `breaker abriu=${breakerEverOpen}`);
        add('F5: oldest waiter respeitou o deadline LOW (~61s) — HIGH nunca presa', typeof queueWait.max === 'number' && queueWait.max <= 62_000, `waitMs.max=${queueWait.max ?? 'SEM DADO'}`);
    } else {
        add('QueueFull/QueueTimeout = 0 (sem saturação induzida)', queueFull === 0 && queueTimeouts === 0, `QueueFull=${queueFull}, QueueTimeout=${queueTimeouts}`);
    }

    // ── Recuperação / drenagem / consistência ──────────────────────────────
    add('Timeline completa: T4 (recuperação) e T5 (drenagem) detectados', T4 != null && T5 != null, `T4=${T4 ? new Date(T4).toISOString() : '—'}, T5=${T5 ? new Date(T5).toISOString() : '—'}`);
    add('Filas HIGH/LOW = 0 ao final (dado ausente reprova)', lastQueue.high === 0 && lastQueue.low === 0, `final high=${lastQueue.high ?? 'SEM DADO'} low=${lastQueue.low ?? 'SEM DADO'}`);
    add('Nenhum SyncRun preso em running (nenhuma clínica presa no guard)', stuckRuns.length === 0, `${stuckRuns.length} preso(s)`);
    add('Pós-recuperação: TODA clínica completa full+vismed-full (T6)', postRecoveryComplete && T6 != null,
        `clínicas=${clinicIds.length}, runs pós-recuperação=${postRecovery.length}` +
        (postRecoveryMissing.length ? `, pendências: ${postRecoveryMissing.join(' · ')}` : ''));
    add('Memória RSS estável', memRss.pass, memRss.detail);
    add('Heap estável / timers liberados (heap + encerramento limpo)', memHeap.pass, memHeap.detail);
    add('API encerra limpa (SIGTERM sem Promise/timer órfão)', cleanExit ? cleanExit.clean === true : false, cleanExit ? `exit=${cleanExit.exitCode ?? cleanExit.signal} em ${cleanExit.waitedMs}ms` : 'SEM DADO');
    add('Nenhuma rota não-mapeada nos mocks', docSummary.unmatchedPaths.length + visSummary.unmatchedPaths.length === 0, `${docSummary.unmatchedPaths.length + visSummary.unmatchedPaths.length} rota(s)`);

    const passed = criteria.every(c => c.pass) && !partial;

    const report = {
        harness: 'WP-13',
        scenario, profile, seed, partial, interruptionReason,
        startedAt, endedAt, durationMs: new Date(endedAt) - new Date(startedAt),
        tlsApproach,
        plan: { key: plan.key, title: plan.title, rules: plan.rules.map(r => ({ tag: r.tag, method: r.method, path: String(r.pathRe), startMs: r.startMs, endMs: r.endMs, action: r.action, params: r.params, modulo: r.modulo ?? null })) },
        passed, criteria,
        timeline,
        injectedFaults: { total: injected.length, byTag: injected.reduce((m, c) => { m[c.faultTag] = (m[c.faultTag] ?? 0) + 1; return m; }, {}) },
        budgets: docBudget,
        mocks: { doctoralia: docSummary, vismed: visSummary },
        circuitBreakerFinal: finalBreaker,
        queues: { waitMs: queueWait, queueFull, queueTimeouts, final: lastQueue },
        oauth: { totalPosts: oauthCalls.length, races: oauthRaces },
        arrivalsDuringOpen,
        newDispatchesDuringOpen,
        syncRuns: { total: globalRuns.length, stuck: stuckRuns.length, postRecovery: postRecovery.length, postRecoveryComplete, postRecoveryMissing, postRecoveryRuns: postRecovery.map(r => ({ clinicId: r.clinicId, type: r.type, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt ?? null, error: r.error ?? null })) },
        memoryStabilization: { rss: memRss, heap: memHeap },
        cleanExit,
        actions, notes,
    };
    return { report, passed };
}

function fmtTs(t) { return t == null ? '—' : new Date(t).toISOString(); }
function fmtMs(ms) { return ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`; }

function renderFaultMarkdown(report) {
    const L = [];
    L.push(`# WP-13 — Relatório de fault injection (cenário ${report.scenario}, perfil ${report.profile})${report.partial ? ' — ⚠️ PARCIAL' : ''}`);
    L.push('');
    L.push(`- **Resultado:** ${report.passed ? '✅ PASS' : '❌ FAIL'}`);
    if (report.interruptionReason) L.push(`- **Motivo da interrupção:** ${report.interruptionReason}`);
    L.push(`- Plano: **${report.plan.title}** · Seed \`${report.seed}\` · Duração ${(report.durationMs / 1000).toFixed(0)}s`);
    L.push('');
    L.push('## Timeline T0–T6');
    const t = report.timeline;
    L.push('| Etapa | Instante | Δ desde etapa anterior |');
    L.push('|---|---|---|');
    L.push(`| T0 HEALTHY (arm) | ${fmtTs(t.T0_healthyArmAt)} | — |`);
    L.push(`| T1 falha inicia | ${fmtTs(t.T1_faultStart)} | — |`);
    L.push(`| T2 proteção reage | ${fmtTs(t.T2_protectionReacts)} | detecção ${fmtMs(t.deltas.detectionMs)} |`);
    L.push(`| T3 mock volta a 200 | ${fmtTs(t.T3_mockRecovered)} | falha durou ${fmtMs(t.deltas.faultDurationMs)} |`);
    L.push(`| T4 recuperação detectada | ${fmtTs(t.T4_recoveryDetected)} | ${fmtMs(t.deltas.recoveryDetectMs)} após T3 |`);
    L.push(`| T5 filas drenadas | ${fmtTs(t.T5_queuesDrained)} | ${fmtMs(t.deltas.drainMs)} após T4 |`);
    L.push(`| T6 HEALTHY de novo | ${fmtTs(t.T6_healthyAgain)} | ${fmtMs(t.deltas.healthyAgainMs)} após T5 |`);
    if (t.openIntervals.length) {
        L.push('');
        L.push(`- Intervalos OPEN observados: ${t.openIntervals.map(i => `${fmtMs(i.durationMs)} (${fmtTs(i.start)})`).join(' · ')}`);
    }
    L.push('');
    L.push('## Critérios');
    L.push('| Critério | Resultado | Detalhe |');
    L.push('|---|---|---|');
    for (const c of report.criteria) L.push(`| ${c.name} | ${c.pass ? '✅' : '❌'} | ${c.detail} |`);
    L.push('');
    L.push('## Falhas injetadas');
    for (const [tag, n] of Object.entries(report.injectedFaults.byTag)) L.push(`- \`${tag}\`: ${n} injeções`);
    L.push('');
    L.push('## Budgets (mock Doctoralia)');
    L.push(`- Agregado 5min: pico **${report.budgets.peakAgg5min}**/${report.budgets.limitAgg5min} · WRITE 1min: **${report.budgets.peakWrites1min}**/${report.budgets.limitWrites1min} · WRITE 1h: **${report.budgets.peakWrites1h}**/${report.budgets.limitWrites1h}`);
    L.push('');
    L.push('## Breaker (snapshot final)');
    const cb = report.circuitBreakerFinal;
    if (cb) L.push(`- estado=${cb.state} · transições=${JSON.stringify(cb.transitions)} · fastFails=${cb.fastFails} · probes exec/ok/fail=${cb.probesExecuted}/${cb.probesSucceeded}/${cb.probesFailed}`);
    else L.push('- SEM DADO');
    L.push('');
    L.push(`## Filas — waitMs p50=${report.queues.waitMs.p50 ?? '?'} p95=${report.queues.waitMs.p95 ?? '?'} max=${report.queues.waitMs.max ?? '?'} · QueueFull=${report.queues.queueFull} QueueTimeout=${report.queues.queueTimeouts}`);
    L.push('');
    L.push(`## OAuth — ${report.oauth.totalPosts} POSTs legítimos, ${report.oauth.races.length} corrida(s)`);
    if (report.notes.length) {
        L.push('');
        L.push('## Notas');
        for (const n of report.notes) L.push(`- ${n}`);
    }
    return L.join('\n') + '\n';
}

module.exports = { buildFaultReport, renderFaultMarkdown, stateIntervals, breakerOf };
