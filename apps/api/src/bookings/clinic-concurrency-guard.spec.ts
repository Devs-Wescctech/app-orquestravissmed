/**
 * WP-02 P2c + Task 223 — Guard de Concorrência entre Polling e Safety Sweep
 *
 * Task 223: POLLING e SAFETY_SWEEP podem coexistir em qualquer ordem.
 * Duplicata do mesmo ator bloqueia. GLOBAL_SYNC/SLOT_SYNC conflitam com tudo.
 */
import { ClinicConcurrencyGuard } from './clinic-concurrency-guard';
import { DoctoraliaMetricsService, getDoctoraliaMetricsService } from '../metrics/doctoralia-metrics.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Cria um guard limpo para cada teste. */
function makeGuard() {
    return new ClinicConcurrencyGuard();
}

/** Cria uma instância de métricas e registra como global singleton. */
function makeMetrics() {
    return new DoctoraliaMetricsService();
}

/**
 * Simula pollVismedClinic com o guard integrado.
 * Task 223: sem pre-check isActive(SAFETY_SWEEP) — polling e sweep podem coexistir.
 */
async function runPoll(
    guard: ClinicConcurrencyGuard,
    clinicId: string,
    body: () => Promise<void> = async () => {},
): Promise<boolean> {
    if (!guard.tryAcquire(clinicId, 'POLLING')) return false;
    try {
        await body();
        return true;
    } finally {
        guard.release(clinicId, 'POLLING');
    }
}

/**
 * Simula a execução de sweepClinic dentro do laço de runSweepAllClinics.
 * Task 223: sem pre-check isActive(POLLING) — polling e sweep podem coexistir.
 */
async function runSweep(
    guard: ClinicConcurrencyGuard,
    clinicId: string,
    body: () => Promise<void> = async () => {},
): Promise<boolean> {
    if (!guard.tryAcquire(clinicId, 'SAFETY_SWEEP')) return false;
    try {
        await body();
        return true;
    } finally {
        guard.release(clinicId, 'SAFETY_SWEEP');
    }
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('ClinicConcurrencyGuard — guard unitário', () => {
    // Cenário 1: Polling normal adquire e libera o guard
    it('cenário 1 — tryAcquire concede o slot e release o devolve', () => {
        const guard = makeGuard();

        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        expect(guard.isActive('clinic-A', 'POLLING')).toBe(true);

        guard.release('clinic-A', 'POLLING');
        expect(guard.isActive('clinic-A', 'POLLING')).toBe(false);
    });

    // Cenário 2: Segundo Polling da mesma clínica é SKIP
    it('cenário 2 — segundo tryAcquire POLLING na mesma clínica retorna false (SKIP)', () => {
        const guard = makeGuard();

        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(false);

        guard.release('clinic-A', 'POLLING');
    });

    // Cenário 4: Polling da clínica B continua funcionando enquanto A está bloqueada
    it('cenário 4 — bloqueio em clínica A não afeta clínica B', () => {
        const guard = makeGuard();

        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);

        // clínica B pode adquirir normalmente
        expect(guard.tryAcquire('clinic-B', 'POLLING')).toBe(true);
        expect(guard.isActive('clinic-B', 'POLLING')).toBe(true);

        guard.release('clinic-A', 'POLLING');
        guard.release('clinic-B', 'POLLING');
    });

    // Cenário 10: Após o primeiro fluxo terminar, o próximo executa normalmente
    it('cenário 10 — após release, próximo tryAcquire POLLING na mesma clínica concede', () => {
        const guard = makeGuard();

        guard.tryAcquire('clinic-A', 'POLLING');
        guard.release('clinic-A', 'POLLING');

        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        guard.release('clinic-A', 'POLLING');
    });

    it('release idempotente — não lança ao chamar em slot já liberado', () => {
        const guard = makeGuard();
        guard.tryAcquire('clinic-A', 'POLLING');
        guard.release('clinic-A', 'POLLING');
        expect(() => guard.release('clinic-A', 'POLLING')).not.toThrow();
    });

    // Task 223: POLLING e SAFETY_SWEEP podem COEXISTIR
    it('Task 223 — POLLING e SAFETY_SWEEP podem coexistir (tryAcquire SAFETY_SWEEP com POLLING ativo retorna true)', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        expect(guard.isActive('clinic-A', 'POLLING')).toBe(true);
        expect(guard.isActive('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        guard.release('clinic-A', 'POLLING');
        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    it('Task 223 — SAFETY_SWEEP e POLLING podem coexistir (tryAcquire POLLING com SWEEP ativo retorna true)', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        expect(guard.isActive('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        expect(guard.isActive('clinic-A', 'POLLING')).toBe(true);
        guard.release('clinic-A', 'SAFETY_SWEEP');
        guard.release('clinic-A', 'POLLING');
    });

    // Duplicata do mesmo ator ainda bloqueia
    it('duplicata — segundo POLLING bloqueia com POLLING ativo (mesma clínica)', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(false);
        guard.release('clinic-A', 'POLLING');
    });

    it('duplicata — segundo SAFETY_SWEEP bloqueia com SAFETY_SWEEP ativo (mesma clínica)', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(false);
        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    // Task 223: terceiro SWEEP com [POLLING+SWEEP] ativos é bloqueado por SWEEP (duplicata)
    it('Task 223 — terceiro SWEEP com [POLLING+SWEEP] ativos é bloqueado (getBlockReason = SAFETY_SWEEP)', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        // Terceiro: sweep duplicado
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(false);
        expect(guard.getBlockReason('clinic-A', 'SAFETY_SWEEP')).toBe('SAFETY_SWEEP');
        guard.release('clinic-A', 'POLLING');
        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    // Task 223: terceiro POLL com [POLLING+SWEEP] ativos é bloqueado por POLLING (duplicata)
    it('Task 223 — terceiro POLL com [POLLING+SWEEP] ativos é bloqueado (getBlockReason = POLLING)', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        // Terceiro: poll duplicado
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(false);
        expect(guard.getBlockReason('clinic-A', 'POLLING')).toBe('POLLING');
        guard.release('clinic-A', 'POLLING');
        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    it('Task 223 — ordem SWEEP→POLL também reporta POLLING para o terceiro poll', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(false);
        expect(guard.getBlockReason('clinic-A', 'POLLING')).toBe('POLLING');
        guard.release('clinic-A', 'POLLING');
        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    // Release parcial: ao liberar apenas um dos coexistentes, o outro continua
    it('Task 223 — release de POLLING com SWEEP ainda ativo: SWEEP permanece ativo', () => {
        const guard = makeGuard();
        guard.tryAcquire('clinic-A', 'POLLING');
        guard.tryAcquire('clinic-A', 'SAFETY_SWEEP');
        guard.release('clinic-A', 'POLLING');
        expect(guard.isActive('clinic-A', 'POLLING')).toBe(false);
        expect(guard.isActive('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        // Após liberar POLLING, novo POLLING pode entrar (SWEEP não bloqueia POLLING)
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        guard.release('clinic-A', 'POLLING');
        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    it('Task 223 — release de SAFETY_SWEEP com POLLING ainda ativo: POLLING permanece ativo', () => {
        const guard = makeGuard();
        guard.tryAcquire('clinic-A', 'POLLING');
        guard.tryAcquire('clinic-A', 'SAFETY_SWEEP');
        guard.release('clinic-A', 'SAFETY_SWEEP');
        expect(guard.isActive('clinic-A', 'SAFETY_SWEEP')).toBe(false);
        expect(guard.isActive('clinic-A', 'POLLING')).toBe(true);
        // Novo SWEEP pode entrar
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        guard.release('clinic-A', 'SAFETY_SWEEP');
        guard.release('clinic-A', 'POLLING');
    });

    // Release de POLLING → SAFETY_SWEEP pode adquirir depois
    it('após release de POLLING, SAFETY_SWEEP adquire normalmente', () => {
        const guard = makeGuard();
        guard.tryAcquire('clinic-A', 'POLLING');
        guard.release('clinic-A', 'POLLING');
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    // Release de SAFETY_SWEEP → POLLING pode adquirir depois
    it('após release de SAFETY_SWEEP, POLLING adquire normalmente', () => {
        const guard = makeGuard();
        guard.tryAcquire('clinic-A', 'SAFETY_SWEEP');
        guard.release('clinic-A', 'SAFETY_SWEEP');
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        guard.release('clinic-A', 'POLLING');
    });

    // Independência entre clínicas com subsistemas cruzados
    it('SAFETY_SWEEP em clínica B adquire mesmo com POLLING ativo em clínica A', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        expect(guard.tryAcquire('clinic-B', 'SAFETY_SWEEP')).toBe(true);
        guard.release('clinic-A', 'POLLING');
        guard.release('clinic-B', 'SAFETY_SWEEP');
    });
});

describe('ClinicConcurrencyGuard — single-flight isolado de notifications', () => {
    it('dois NOTIFICATION_POLL da mesma clínica nunca coexistem', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'NOTIFICATION_POLL')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'NOTIFICATION_POLL')).toBe(false);
        guard.release('clinic-A', 'NOTIFICATION_POLL');
        expect(guard.tryAcquire('clinic-A', 'NOTIFICATION_POLL')).toBe(true);
        guard.release('clinic-A', 'NOTIFICATION_POLL');
    });

    it.each(['POLLING', 'SAFETY_SWEEP', 'GLOBAL_SYNC', 'SLOT_SYNC'] as const)(
        'NOTIFICATION_POLL pode coexistir com %s na mesma clínica',
        (subsystem) => {
            const guard = makeGuard();
            expect(guard.tryAcquire('clinic-A', subsystem)).toBe(true);
            expect(guard.tryAcquire('clinic-A', 'NOTIFICATION_POLL')).toBe(true);
            expect(guard.isActive('clinic-A', subsystem)).toBe(true);
            expect(guard.isActive('clinic-A', 'NOTIFICATION_POLL')).toBe(true);
            guard.release('clinic-A', 'NOTIFICATION_POLL');
            guard.release('clinic-A', subsystem);
        },
    );

    it('reserva GLOBAL_SYNC_PENDING não bloqueia NOTIFICATION_POLL', () => {
        const guard = makeGuard();
        guard.requestPriority('clinic-A', () => {});
        expect(guard.tryAcquire('clinic-A', 'NOTIFICATION_POLL')).toBe(true);
        guard.release('clinic-A', 'NOTIFICATION_POLL');
        guard.clearPriority('clinic-A');
    });

    it('NOTIFICATION_POLL ativo não bloqueia um subsistema exclusivo', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'NOTIFICATION_POLL')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        expect(guard.getBlockReason('clinic-A')).toBe('POLLING');
        guard.release('clinic-A', 'POLLING');
        guard.release('clinic-A', 'NOTIFICATION_POLL');
    });
});

describe('ClinicConcurrencyGuard — integração Polling × Polling', () => {
    // Cenário 3: Segundo Polling não faz nenhuma chamada Doctoralia
    it('cenário 3 — segundo poll (mesma clínica) não executa o corpo', async () => {
        const guard = makeGuard();
        const calls: string[] = [];

        // Simula primeiro poll ainda em andamento (não liberamos antes do segundo)
        guard.tryAcquire('clinic-A', 'POLLING');

        // Segundo poll deveria ser descartado
        const body2 = jest.fn(async () => { calls.push('poll2'); });
        const ran2 = await runPoll(guard, 'clinic-A', body2);

        expect(ran2).toBe(false);
        expect(body2).not.toHaveBeenCalled();
        expect(calls).toHaveLength(0);

        guard.release('clinic-A', 'POLLING');
    });

    // Cenário 2 (integração): segundo poll retorna false
    it('segundo poll é SKIP enquanto primeiro ainda executa (simulado)', async () => {
        const guard = makeGuard();
        let resolve!: () => void;
        const block = new Promise<void>(res => (resolve = res));

        // Inicia primeiro poll que fica suspenso
        const poll1 = runPoll(guard, 'clinic-A', () => block);

        // Segundo poll imediatamente descartado
        const ran2 = await runPoll(guard, 'clinic-A');
        expect(ran2).toBe(false);

        resolve();
        const ran1 = await poll1;
        expect(ran1).toBe(true);
    });
});

describe('ClinicConcurrencyGuard — integração Polling × Safety Sweep (Task 223: coexistência)', () => {
    // Task 223: Sweep pode rodar mesmo com Polling ativo
    it('Task 223 — sweep EXECUTA (não é SKIP) quando polling da mesma clínica está ativo', async () => {
        const guard = makeGuard();
        guard.tryAcquire('clinic-A', 'POLLING');

        const body = jest.fn(async () => {});
        const ran = await runSweep(guard, 'clinic-A', body);

        expect(ran).toBe(true);
        expect(body).toHaveBeenCalledTimes(1);

        guard.release('clinic-A', 'POLLING');
    });

    // Task 223: Poll pode rodar mesmo com Sweep ativo
    it('Task 223 — polling EXECUTA (não é SKIP) quando sweep da mesma clínica está ativo', async () => {
        const guard = makeGuard();
        guard.tryAcquire('clinic-A', 'SAFETY_SWEEP');

        const body = jest.fn(async () => {});
        const ran = await runPoll(guard, 'clinic-A', body);

        expect(ran).toBe(true);
        expect(body).toHaveBeenCalledTimes(1);

        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    // Task 223: Poll e Sweep coexistem concorrentemente
    it('Task 223 — poll e sweep executam simultaneamente (ambos ran=true)', async () => {
        const guard = makeGuard();
        let resolvePoll!: () => void;
        let resolveSweep!: () => void;
        const pollBlock = new Promise<void>(res => (resolvePoll = res));
        const sweepBlock = new Promise<void>(res => (resolveSweep = res));

        const pollBody = jest.fn(() => pollBlock);
        const sweepBody = jest.fn(() => sweepBlock);

        const pollPromise = runPoll(guard, 'clinic-A', pollBody);
        const sweepPromise = runSweep(guard, 'clinic-A', sweepBody);

        // Ambos devem estar ativos simultaneamente
        expect(guard.isActive('clinic-A', 'POLLING')).toBe(true);
        expect(guard.isActive('clinic-A', 'SAFETY_SWEEP')).toBe(true);

        resolvePoll();
        resolveSweep();
        const pollRan = await pollPromise;
        const sweepRan = await sweepPromise;
        expect(pollRan).toBe(true);
        expect(sweepRan).toBe(true);
        expect(pollBody).toHaveBeenCalledTimes(1);
        expect(sweepBody).toHaveBeenCalledTimes(1);
    });

    // Cenário 5 (atualizado Task 223): Safety Sweep de outra clínica continua funcionando
    it('cenário 7 — sweep de clínica B executa normalmente enquanto clínica A tem polling ativo', async () => {
        const guard = makeGuard();
        guard.tryAcquire('clinic-A', 'POLLING');

        const bodyB = jest.fn(async () => {});
        const ran = await runSweep(guard, 'clinic-B', bodyB);

        expect(ran).toBe(true);
        expect(bodyB).toHaveBeenCalledTimes(1);

        guard.release('clinic-A', 'POLLING');
    });
});

describe('ClinicConcurrencyGuard — liberação em exceção', () => {
    // Cenário 8: Exception durante Polling libera o guard
    it('cenário 8 — exception em polling libera guard (clínica volta a aceitar execução)', async () => {
        const guard = makeGuard();

        await expect(
            runPoll(guard, 'clinic-A', async () => {
                throw new Error('poll crashed');
            }),
        ).rejects.toThrow('poll crashed');

        // Guard deve ter sido liberado no finally
        expect(guard.isActive('clinic-A', 'POLLING')).toBe(false);

        // Próximo poll deve executar normalmente
        const bodyNext = jest.fn(async () => {});
        const ran = await runPoll(guard, 'clinic-A', bodyNext);
        expect(ran).toBe(true);
        expect(bodyNext).toHaveBeenCalledTimes(1);
    });

    // Cenário 9: Exception durante Safety Sweep libera o guard
    it('cenário 9 — exception em sweep libera guard (clínica volta a aceitar execução)', async () => {
        const guard = makeGuard();

        await expect(
            runSweep(guard, 'clinic-A', async () => {
                throw new Error('sweep crashed');
            }),
        ).rejects.toThrow('sweep crashed');

        // Guard deve ter sido liberado no finally
        expect(guard.isActive('clinic-A', 'SAFETY_SWEEP')).toBe(false);

        // Próximo sweep deve executar normalmente
        const bodyNext = jest.fn(async () => {});
        const ran = await runSweep(guard, 'clinic-A', bodyNext);
        expect(ran).toBe(true);
        expect(bodyNext).toHaveBeenCalledTimes(1);
    });

    // Task 223: exception em poll não afeta sweep coexistente
    it('Task 223 — exception em poll com sweep coexistente: sweep continua ativo e poll é liberado', async () => {
        const guard = makeGuard();
        guard.tryAcquire('clinic-A', 'SAFETY_SWEEP');

        await expect(
            runPoll(guard, 'clinic-A', async () => { throw new Error('poll crashed'); }),
        ).rejects.toThrow('poll crashed');

        expect(guard.isActive('clinic-A', 'POLLING')).toBe(false);
        expect(guard.isActive('clinic-A', 'SAFETY_SWEEP')).toBe(true);

        guard.release('clinic-A', 'SAFETY_SWEEP');
    });
});

describe('ClinicConcurrencyGuard — métricas', () => {
    let metrics: DoctoraliaMetricsService;

    beforeEach(() => {
        metrics = makeMetrics(); // registra como singleton global
    });

    // Cenário 11: OVERLAPPING_POLL_DETECTED continua sendo emitido
    it('cenário 11 — trackPollStart ainda emite OVERLAPPING_POLL_DETECTED ao detectar sobreposição', () => {
        const poll1Id = 'poll-exec-1';
        const poll2Id = 'poll-exec-2';

        metrics.trackPollStart('clinic-A', poll1Id);
        const overlapEvent = metrics.trackPollStart('clinic-A', poll2Id);

        expect(overlapEvent).not.toBeNull();
        expect(overlapEvent?.clinicId).toBe('clinic-A');
        expect(overlapEvent?.newPollExecutionId).toBe(poll2Id);
        expect(overlapEvent?.activePollExecutionIds).toContain(poll1Id);
        expect(metrics.getTotalOverlapCount()).toBe(1);

        metrics.trackPollEnd('clinic-A', poll1Id);
        metrics.trackPollEnd('clinic-A', poll2Id);
    });

    it('recordConcurrencySkip registra POLL_SKIPPED_POLL_ACTIVE', () => {
        metrics.recordConcurrencySkip('POLL_SKIPPED_POLL_ACTIVE', 'clinic-A');

        const counts = metrics.getConcurrencySkipCounts();
        expect(counts.POLL_SKIPPED_POLL_ACTIVE).toBe(1);
        expect(counts.POLL_SKIPPED_SWEEP_ACTIVE).toBe(0);
        expect(counts.SWEEP_SKIPPED_POLL_ACTIVE).toBe(0);
    });

    it('recordConcurrencySkip registra POLL_SKIPPED_SWEEP_ACTIVE', () => {
        metrics.recordConcurrencySkip('POLL_SKIPPED_SWEEP_ACTIVE', 'clinic-A');

        const counts = metrics.getConcurrencySkipCounts();
        expect(counts.POLL_SKIPPED_SWEEP_ACTIVE).toBe(1);
        expect(counts.POLL_SKIPPED_POLL_ACTIVE).toBe(0);
    });

    it('recordConcurrencySkip registra SWEEP_SKIPPED_POLL_ACTIVE', () => {
        metrics.recordConcurrencySkip('SWEEP_SKIPPED_POLL_ACTIVE', 'clinic-B');

        const counts = metrics.getConcurrencySkipCounts();
        expect(counts.SWEEP_SKIPPED_POLL_ACTIVE).toBe(1);
    });

    it('contadores de concorrência são expostos em getBaseline()', () => {
        metrics.recordConcurrencySkip('POLL_SKIPPED_POLL_ACTIVE', 'c1');
        metrics.recordConcurrencySkip('POLL_SKIPPED_SWEEP_ACTIVE', 'c1');
        metrics.recordConcurrencySkip('SWEEP_SKIPPED_POLL_ACTIVE', 'c1');

        const baseline = metrics.getBaseline() as any;
        expect(baseline.concurrencyGuard).toBeDefined();
        expect(baseline.concurrencyGuard.POLL_SKIPPED_POLL_ACTIVE).toBe(1);
        expect(baseline.concurrencyGuard.POLL_SKIPPED_SWEEP_ACTIVE).toBe(1);
        expect(baseline.concurrencyGuard.SWEEP_SKIPPED_POLL_ACTIVE).toBe(1);
    });

    it('reset() zera contadores de concorrência', () => {
        metrics.recordConcurrencySkip('POLL_SKIPPED_POLL_ACTIVE', 'c1');
        metrics.recordConcurrencySkip('SWEEP_SKIPPED_POLL_ACTIVE', 'c1');
        metrics.reset();

        const counts = metrics.getConcurrencySkipCounts();
        expect(counts.POLL_SKIPPED_POLL_ACTIVE).toBe(0);
        expect(counts.SWEEP_SKIPPED_POLL_ACTIVE).toBe(0);
    });
});

// Task 223 (cenário 12 atualizado): POLLING e SAFETY_SWEEP PODEM coexistir;
// GLOBAL_SYNC e SLOT_SYNC conflitam com tudo.
describe('cenário 12 — Task 223: POLLING e SAFETY_SWEEP coexistem; GLOBAL_SYNC/SLOT_SYNC conflitam com tudo', () => {
    it('POLLING + SAFETY_SWEEP coexistem (ambos podem adquirir)', () => {
        const guard = makeGuard();

        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        // Task 223: SAFETY_SWEEP pode adquirir com POLLING ativo
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);

        expect(guard.isActive('clinic-A', 'POLLING')).toBe(true);
        expect(guard.isActive('clinic-A', 'SAFETY_SWEEP')).toBe(true);

        guard.release('clinic-A', 'POLLING');
        expect(guard.isActive('clinic-A', 'POLLING')).toBe(false);
        expect(guard.isActive('clinic-A', 'SAFETY_SWEEP')).toBe(true);

        guard.release('clinic-A', 'SAFETY_SWEEP');
        expect(guard.isActive('clinic-A', 'SAFETY_SWEEP')).toBe(false);
    });

    it('WP-04: GLOBAL_SYNC e SLOT_SYNC conflitam com POLLING, SAFETY_SWEEP e entre si', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'GLOBAL_SYNC')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(false);
        expect(guard.tryAcquire('clinic-A', 'SLOT_SYNC')).toBe(false);
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(false);
        guard.release('clinic-A', 'GLOBAL_SYNC');

        expect(guard.tryAcquire('clinic-A', 'SLOT_SYNC')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(false);
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(false);
        expect(guard.tryAcquire('clinic-A', 'GLOBAL_SYNC')).toBe(false);
        guard.release('clinic-A', 'SLOT_SYNC');
    });

    it('GLOBAL_SYNC bloqueia com [POLLING+SWEEP] coexistindo', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        // GLOBAL_SYNC conflita com tudo — não pode entrar
        expect(guard.tryAcquire('clinic-A', 'GLOBAL_SYNC')).toBe(false);
        guard.release('clinic-A', 'POLLING');
        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    it('SLOT_SYNC bloqueia com [POLLING+SWEEP] coexistindo', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'SLOT_SYNC')).toBe(false);
        guard.release('clinic-A', 'POLLING');
        guard.release('clinic-A', 'SAFETY_SWEEP');
    });
});

// Cenário 14 (atualizado Task 223): com nova matriz, POLLING+SWEEP podem coexistir
describe('Task 223 — aquisições concorrentes POLLING × SWEEP na mesma clínica', () => {
    it('POLLING e SWEEP concorrentes: ambos passam pelo tryAcquire com sucesso (coexistência)', async () => {
        const guard = makeGuard();

        const pollSawSweepActive = guard.isActive('clinic-A', 'SAFETY_SWEEP');
        const sweepSawPollActive = guard.isActive('clinic-A', 'POLLING');
        expect(pollSawSweepActive).toBe(false);
        expect(sweepSawPollActive).toBe(false);

        const pollAcquired = guard.tryAcquire('clinic-A', 'POLLING');
        const sweepAcquired = guard.tryAcquire('clinic-A', 'SAFETY_SWEEP');

        // Task 223: ambos adquirem (coexistência)
        expect(pollAcquired).toBe(true);
        expect(sweepAcquired).toBe(true);

        guard.release('clinic-A', 'POLLING');
        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    it('duas execuções concorrentes (poll × sweep) na mesma clínica — AMBAS executam o corpo (Task 223)', async () => {
        const guard = makeGuard();
        let resolvePoll!: () => void;
        const pollBlock = new Promise<void>(res => (resolvePoll = res));

        const pollBody = jest.fn(() => pollBlock);
        const sweepBody = jest.fn(async () => {});

        // Dispara os dois "simultaneamente" (mesmo tick)
        const pollPromise = runPoll(guard, 'clinic-A', pollBody);
        const sweepPromise = runSweep(guard, 'clinic-A', sweepBody);

        // Sweep não precisa esperar poll terminar
        const sweepRan = await sweepPromise;
        expect(sweepRan).toBe(true);
        expect(sweepBody).toHaveBeenCalledTimes(1);

        resolvePoll();
        const pollRan = await pollPromise;
        expect(pollRan).toBe(true);
        expect(pollBody).toHaveBeenCalledTimes(1);
    });

    it('duplicata POLLING com [POLLING+SWEEP] ativos: apenas o duplicado é rejeitado', async () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        // Terceiro: POLLING duplicado é bloqueado
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(false);
        guard.release('clinic-A', 'POLLING');
        guard.release('clinic-A', 'SAFETY_SWEEP');
    });
});

// ─── Task 133: reserva de prioridade do Global Sync ──────────────────────────
describe('Task 133 — reserva de prioridade do Global Sync', () => {
    const flushImmediates = () => new Promise<void>(res => setImmediate(res));

    it('polling ativo + reserva registrada → callback dispara quando o polling termina', async () => {
        const guard = makeGuard();
        const cb = jest.fn();

        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        guard.requestPriority('clinic-A', cb);
        expect(guard.hasPriorityPending('clinic-A')).toBe(true);

        // Callback não dispara enquanto a clínica está ocupada
        await flushImmediates();
        expect(cb).not.toHaveBeenCalled();

        guard.release('clinic-A', 'POLLING');
        await flushImmediates();
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('novos POLLING/SAFETY_SWEEP/SLOT_SYNC são rejeitados com motivo GLOBAL_SYNC_PENDING (nunca POLLING_ACTIVE)', () => {
        const guard = makeGuard();
        guard.requestPriority('clinic-A', () => {});

        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(false);
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(false);
        expect(guard.tryAcquire('clinic-A', 'SLOT_SYNC')).toBe(false);

        // Motivo inequívoco: reserva, não subsistema ativo
        expect(guard.getActiveSubsystem('clinic-A')).toBeNull();
        expect(guard.getBlockReason('clinic-A')).toBe('GLOBAL_SYNC_PENDING');
    });

    it('Task 223 + Task 133: GLOBAL_SYNC_PENDING bloqueia POLLING/SWEEP mesmo com par compatível ativo', () => {
        const guard = makeGuard();
        // POLLING ativo (coexistente com SWEEP)
        guard.tryAcquire('clinic-A', 'POLLING');
        // Reserva Global Sync registrada enquanto POLLING está ativo
        guard.requestPriority('clinic-A', () => {});

        // SAFETY_SWEEP tenta entrar: bloqueado pela reserva (não pelo POLLING)
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(false);
        expect(guard.getBlockReason('clinic-A', 'SAFETY_SWEEP')).toBe('GLOBAL_SYNC_PENDING');

        guard.release('clinic-A', 'POLLING');
        guard.clearPriority('clinic-A');
    });

    it('getBlockReason prioriza o subsistema ativo sobre a reserva', () => {
        const guard = makeGuard();
        guard.tryAcquire('clinic-A', 'POLLING');
        guard.requestPriority('clinic-A', () => {});
        expect(guard.getBlockReason('clinic-A')).toBe('POLLING');
        guard.release('clinic-A', 'POLLING');
    });

    it('GLOBAL_SYNC não é bloqueado pela própria reserva', () => {
        const guard = makeGuard();
        guard.requestPriority('clinic-A', () => {});
        expect(guard.tryAcquire('clinic-A', 'GLOBAL_SYNC')).toBe(true);
        guard.clearPriority('clinic-A');
        guard.release('clinic-A', 'GLOBAL_SYNC');
        expect(guard.getBlockReason('clinic-A')).toBeNull();
    });

    it('apenas UMA reserva por clínica — coalescência substitui o callback e preserva o deadline', async () => {
        const guard = makeGuard();
        const cb1 = jest.fn();
        const cb2 = jest.fn();

        guard.tryAcquire('clinic-A', 'POLLING');
        guard.requestPriority('clinic-A', cb1);
        guard.requestPriority('clinic-A', cb2);

        guard.release('clinic-A', 'POLLING');
        await flushImmediates();
        // Apenas o callback mais recente dispara — nunca duplica
        expect(cb1).not.toHaveBeenCalled();
        expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('clínicas diferentes são independentes — reserva em A não afeta B', () => {
        const guard = makeGuard();
        guard.requestPriority('clinic-A', () => {});
        expect(guard.tryAcquire('clinic-B', 'POLLING')).toBe(true);
        expect(guard.hasPriorityPending('clinic-B')).toBe(false);
        guard.release('clinic-B', 'POLLING');
    });

    it('clearPriority remove a reserva (sucesso ou falha do Global Sync)', () => {
        const guard = makeGuard();
        guard.requestPriority('clinic-A', () => {});
        guard.clearPriority('clinic-A');
        expect(guard.hasPriorityPending('clinic-A')).toBe(false);
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        guard.release('clinic-A', 'POLLING');
    });

    it('clearPriority antes do release não re-dispara o callback (reserva consumida)', async () => {
        const guard = makeGuard();
        const cb = jest.fn();
        guard.tryAcquire('clinic-A', 'GLOBAL_SYNC');
        guard.requestPriority('clinic-A', cb);
        // Simula o finally da execução GLOBAL_SYNC: clear ANTES do release
        guard.clearPriority('clinic-A');
        guard.release('clinic-A', 'GLOBAL_SYNC');
        await flushImmediates();
        expect(cb).not.toHaveBeenCalled();
    });

    it('TTL expira a reserva com onExpire (métrica) e libera a clínica', () => {
        const guard = makeGuard();
        const onExpire = jest.fn();
        const nowSpy = jest.spyOn(Date, 'now');
        const t0 = 1_000_000;
        nowSpy.mockReturnValue(t0);

        guard.requestPriority('clinic-A', () => {}, { onExpire });
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(false);

        // Avança além do TTL de 25min
        nowSpy.mockReturnValue(t0 + 26 * 60 * 1000);
        expect(guard.hasPriorityPending('clinic-A')).toBe(false);
        expect(onExpire).toHaveBeenCalledTimes(1);
        expect(guard.getBlockReason('clinic-A')).toBeNull();
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        guard.release('clinic-A', 'POLLING');
        nowSpy.mockRestore();
    });

    it('reserva expirada NÃO dispara callback no release (só a próxima janela do cron cobre)', async () => {
        const guard = makeGuard();
        const cb = jest.fn();
        const nowSpy = jest.spyOn(Date, 'now');
        const t0 = 2_000_000;
        nowSpy.mockReturnValue(t0);

        guard.tryAcquire('clinic-A', 'POLLING');
        guard.requestPriority('clinic-A', cb);
        nowSpy.mockReturnValue(t0 + 30 * 60 * 1000);
        guard.release('clinic-A', 'POLLING');
        await new Promise<void>(res => setImmediate(res));
        expect(cb).not.toHaveBeenCalled();
        nowSpy.mockRestore();
    });

    it('exceção no callback não trava a clínica (reserva descartada)', async () => {
        const guard = makeGuard();
        guard.tryAcquire('clinic-A', 'POLLING');
        guard.requestPriority('clinic-A', () => { throw new Error('callback crashed'); });
        guard.release('clinic-A', 'POLLING');
        await new Promise<void>(res => setImmediate(res));
        // Reserva descartada; clínica volta a aceitar execuções normalmente
        expect(guard.hasPriorityPending('clinic-A')).toBe(false);
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        guard.release('clinic-A', 'POLLING');
    });

    it('consumePriority remove a reserva e devolve a tag opaca (correlação no domínio)', () => {
        const guard = makeGuard();
        guard.requestPriority('clinic-A', () => {}, { tag: 'run-A' });

        const consumed = guard.consumePriority('clinic-A');
        expect(consumed).toEqual({ tag: 'run-A' });
        expect(guard.hasPriorityPending('clinic-A')).toBe(false);
        // Exatamente uma vez: segundo consumo retorna null
        expect(guard.consumePriority('clinic-A')).toBeNull();
    });

    it('GLOBAL_SYNC independente já na fila consome a reserva de A com tag (satisfação observável, nunca perda silenciosa)', async () => {
        const guard = makeGuard();
        const resumeA = jest.fn();

        // Run A adiado: POLLING ativo, reserva registrada com tag do run adiado
        guard.tryAcquire('clinic-A', 'POLLING');
        guard.requestPriority('clinic-A', resumeA, { tag: 'run-A' });
        guard.release('clinic-A', 'POLLING');
        // Callback de A agendado via setImmediate, mas ANTES dele um GLOBAL_SYNC B
        // (job independente na fila) consegue o acquire — reserva não bloqueia GLOBAL_SYNC.
        expect(guard.tryAcquire('clinic-A', 'GLOBAL_SYNC')).toBe(true);

        // O callback de A dispara e simula o re-disparo: encontra a clínica ocupada
        // (run B rodando) — o fluxo real re-registra/descarta; aqui só registramos a chamada.
        await flushImmediates();
        expect(resumeA).toHaveBeenCalledTimes(1);

        // B termina: finally consome a reserva com a tag de A para correlacionar
        const consumed = guard.consumePriority('clinic-A');
        guard.release('clinic-A', 'GLOBAL_SYNC');
        expect(consumed).toEqual({ tag: 'run-A' });

        // Nada pendente, callback de A não re-dispara, clínica livre
        await flushImmediates();
        expect(resumeA).toHaveBeenCalledTimes(1);
        expect(guard.hasPriorityPending('clinic-A')).toBe(false);
        expect(guard.getBlockReason('clinic-A')).toBeNull();
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        guard.release('clinic-A', 'POLLING');
    });

    it('consumo antes do release não re-dispara o callback da reserva satisfeita', async () => {
        const guard = makeGuard();
        const cb = jest.fn();
        guard.tryAcquire('clinic-A', 'GLOBAL_SYNC');
        guard.requestPriority('clinic-A', cb, { tag: 'run-A' });
        // Simula o finally da execução GLOBAL_SYNC: consume ANTES do release
        expect(guard.consumePriority('clinic-A')).toEqual({ tag: 'run-A' });
        guard.release('clinic-A', 'GLOBAL_SYNC');
        await flushImmediates();
        expect(cb).not.toHaveBeenCalled();
    });

    it('coalescência preserva a tag existente quando o re-registro não informa tag', () => {
        const guard = makeGuard();
        guard.requestPriority('clinic-A', () => {}, { tag: 'run-A' });
        guard.requestPriority('clinic-A', () => {}); // re-registro por corrida, sem tag
        expect(guard.consumePriority('clinic-A')).toEqual({ tag: 'run-A' });
    });

    it('race: reserva consumida entre o agendamento do callback (release) e sua execução → callback obsoleto NÃO dispara', async () => {
        const guard = makeGuard();
        const cb = jest.fn();

        guard.tryAcquire('clinic-A', 'POLLING');
        guard.requestPriority('clinic-A', cb, { tag: 'run-A' });
        // release agenda o callback via setImmediate...
        guard.release('clinic-A', 'POLLING');
        // ...mas ANTES do immediate rodar, um GLOBAL_SYNC independente consome a reserva
        expect(guard.consumePriority('clinic-A')).toEqual({ tag: 'run-A' });

        await flushImmediates();
        expect(cb).not.toHaveBeenCalled();
        expect(guard.hasPriorityPending('clinic-A')).toBe(false);
    });

    it('race: clearPriority entre o agendamento do callback e sua execução → callback obsoleto NÃO dispara', async () => {
        const guard = makeGuard();
        const cb = jest.fn();

        guard.tryAcquire('clinic-A', 'POLLING');
        guard.requestPriority('clinic-A', cb);
        guard.release('clinic-A', 'POLLING');
        guard.clearPriority('clinic-A');

        await flushImmediates();
        expect(cb).not.toHaveBeenCalled();
    });

    it('race: coalescência substitui a reserva entre o agendamento e a execução → callback ANTIGO não dispara (identidade)', async () => {
        const guard = makeGuard();
        const cbOld = jest.fn();
        const cbNew = jest.fn();

        guard.tryAcquire('clinic-A', 'POLLING');
        guard.requestPriority('clinic-A', cbOld, { tag: 'run-A' });
        guard.release('clinic-A', 'POLLING');
        // Antes do immediate: outro run adiado coalesce/substitui a reserva
        guard.requestPriority('clinic-A', cbNew, { tag: 'run-B' });

        await flushImmediates();
        // O callback antigo não dispara; o novo aguarda o próximo release/ciclo
        expect(cbOld).not.toHaveBeenCalled();
        expect(cbNew).not.toHaveBeenCalled();
        expect(guard.hasPriorityPending('clinic-A')).toBe(true);
        // A reserva substituída mantém deadline original mas callback/tag novos
        expect(guard.consumePriority('clinic-A')).toEqual({ tag: 'run-B' });
    });

    it('recordConcurrencySkip aceita os novos tipos GLOBAL_SYNC_PENDING e RESERVATION_EXPIRED', () => {
        const metrics = makeMetrics();
        metrics.recordConcurrencySkip('POLL_SKIPPED_GLOBAL_SYNC_PENDING', 'c1');
        metrics.recordConcurrencySkip('SWEEP_SKIPPED_GLOBAL_SYNC_PENDING', 'c1');
        metrics.recordConcurrencySkip('SLOT_SYNC_SKIPPED_GLOBAL_SYNC_PENDING', 'c1');
        metrics.recordConcurrencySkip('GLOBAL_SYNC_RESERVATION_EXPIRED', 'c1');

        const counts = metrics.getConcurrencySkipCounts();
        expect(counts.POLL_SKIPPED_GLOBAL_SYNC_PENDING).toBe(1);
        expect(counts.SWEEP_SKIPPED_GLOBAL_SYNC_PENDING).toBe(1);
        expect(counts.SLOT_SYNC_SKIPPED_GLOBAL_SYNC_PENDING).toBe(1);
        expect(counts.GLOBAL_SYNC_RESERVATION_EXPIRED).toBe(1);

        metrics.reset();
        expect(metrics.getConcurrencySkipCounts().POLL_SKIPPED_GLOBAL_SYNC_PENDING).toBe(0);
        expect(metrics.getConcurrencySkipCounts().GLOBAL_SYNC_RESERVATION_EXPIRED).toBe(0);
    });

    // Task 223: callback de reserva com POLLING+SWEEP ativos dispara quando AMBOS terminam
    it('Task 223 + Task 133: callback de reserva dispara quando último exclusivo (SWEEP) termina com POLLING já liberado', async () => {
        const guard = makeGuard();
        const cb = jest.fn();

        guard.tryAcquire('clinic-A', 'POLLING');
        guard.tryAcquire('clinic-A', 'SAFETY_SWEEP');
        guard.requestPriority('clinic-A', cb);

        // Libera POLLING — SWEEP ainda ativo, callback NÃO dispara ainda
        guard.release('clinic-A', 'POLLING');
        await flushImmediates();
        expect(cb).not.toHaveBeenCalled();

        // Libera SWEEP — agora sem exclusivos ativos, callback dispara
        guard.release('clinic-A', 'SAFETY_SWEEP');
        await flushImmediates();
        expect(cb).toHaveBeenCalledTimes(1);
    });
});
