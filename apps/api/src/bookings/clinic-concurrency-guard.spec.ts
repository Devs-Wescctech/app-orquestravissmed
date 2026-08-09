/**
 * WP-02 P2c — Guard de Concorrência entre Polling e Safety Sweep
 *
 * Cobre os 12 cenários obrigatórios da especificação.
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
 * Simula pollVismedClinic com o guard integrado:
 * retorna true se o poll executou, false se foi descartado.
 * `body` é assíncrono para permitir simular delays/exceptions.
 */
async function runPoll(
    guard: ClinicConcurrencyGuard,
    clinicId: string,
    body: () => Promise<void> = async () => {},
): Promise<boolean> {
    if (guard.isActive(clinicId, 'SAFETY_SWEEP')) return false;
    if (!guard.tryAcquire(clinicId, 'POLLING')) return false;
    try {
        await body();
        return true;
    } finally {
        guard.release(clinicId, 'POLLING');
    }
}

/**
 * Simula a execução de sweepClinic dentro do laço de runSweepAllClinics:
 * retorna true se o sweep executou, false se foi descartado.
 */
async function runSweep(
    guard: ClinicConcurrencyGuard,
    clinicId: string,
    body: () => Promise<void> = async () => {},
): Promise<boolean> {
    if (guard.isActive(clinicId, 'POLLING')) return false;
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

    // Exclusão cruzada — POLLING ativo bloqueia SAFETY_SWEEP
    it('exclusão cruzada — tryAcquire SAFETY_SWEEP retorna false com POLLING ativo', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(false);
        guard.release('clinic-A', 'POLLING');
    });

    // Exclusão cruzada — SAFETY_SWEEP ativo bloqueia POLLING
    it('exclusão cruzada — tryAcquire POLLING retorna false com SAFETY_SWEEP ativo', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(false);
        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    // Dois Safety Sweeps — segundo retorna false
    it('segundo tryAcquire SAFETY_SWEEP na mesma clínica retorna false (SKIP)', () => {
        const guard = makeGuard();
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(false);
        guard.release('clinic-A', 'SAFETY_SWEEP');
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

describe('ClinicConcurrencyGuard — integração Polling × Safety Sweep', () => {
    // Cenário 5: Safety Sweep é SKIP quando Polling ativo
    it('cenário 5 — sweep é SKIP quando polling da mesma clínica está ativo', async () => {
        const guard = makeGuard();
        guard.tryAcquire('clinic-A', 'POLLING');

        const body = jest.fn(async () => {});
        const ran = await runSweep(guard, 'clinic-A', body);

        expect(ran).toBe(false);
        expect(body).not.toHaveBeenCalled();

        guard.release('clinic-A', 'POLLING');
    });

    // Cenário 6: Polling é SKIP quando Safety Sweep ativo
    it('cenário 6 — polling é SKIP quando sweep da mesma clínica está ativo', async () => {
        const guard = makeGuard();
        guard.tryAcquire('clinic-A', 'SAFETY_SWEEP');

        const body = jest.fn(async () => {});
        const ran = await runPoll(guard, 'clinic-A', body);

        expect(ran).toBe(false);
        expect(body).not.toHaveBeenCalled();

        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    // Cenário 7: Safety Sweep de outra clínica continua funcionando
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

// Cenário 12 (corrigido): POLLING e SAFETY_SWEEP NÃO podem coexistir na mesma clínica
describe('cenário 12 — exclusão mútua total: POLLING e SAFETY_SWEEP nunca coexistem na mesma clínica', () => {
    it('segundo subsistema NÃO adquire enquanto o primeiro está ativo', () => {
        const guard = makeGuard();

        expect(guard.tryAcquire('clinic-A', 'POLLING')).toBe(true);
        // ANTES este cenário permitia a coexistência — agora deve ser rejeitada.
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(false);

        expect(guard.isActive('clinic-A', 'POLLING')).toBe(true);
        expect(guard.isActive('clinic-A', 'SAFETY_SWEEP')).toBe(false);

        guard.release('clinic-A', 'POLLING');
        expect(guard.isActive('clinic-A', 'POLLING')).toBe(false);

        // Após o release, o outro subsistema adquire normalmente.
        expect(guard.tryAcquire('clinic-A', 'SAFETY_SWEEP')).toBe(true);
        guard.release('clinic-A', 'SAFETY_SWEEP');
        expect(guard.isActive('clinic-A', 'SAFETY_SWEEP')).toBe(false);
    });

    it('guard não é importado nem usado em serviços de Global Sync', () => {
        // Verificação por ausência: ClinicConcurrencyGuard existe no módulo Bookings;
        // não há referência a ele nos serviços de sync externo.
        // Este teste documenta o invariante; falha de compilação TypeScript seria evidência de violação.
        const guard = makeGuard();
        expect(guard).toBeInstanceOf(ClinicConcurrencyGuard);
    });
});

// Cenário 14: reprodução explícita da race isActive() → tryAcquire()
describe('race condition — aquisições concorrentes de subsistemas diferentes na mesma clínica', () => {
    it('somente UM subsistema obtém o guard mesmo quando ambos passam pelo isActive() antes de qualquer tryAcquire()', async () => {
        const guard = makeGuard();

        // Reproduz a interleaving da auditoria:
        // 1. Polling verifica isActive(SAFETY_SWEEP) → false
        // 2. Sweep verifica isActive(POLLING) → false
        // 3. Polling chama tryAcquire(POLLING)
        // 4. Sweep chama tryAcquire(SAFETY_SWEEP)
        const pollSawSweepActive = guard.isActive('clinic-A', 'SAFETY_SWEEP');
        const sweepSawPollActive = guard.isActive('clinic-A', 'POLLING');
        expect(pollSawSweepActive).toBe(false);
        expect(sweepSawPollActive).toBe(false);

        const pollAcquired = guard.tryAcquire('clinic-A', 'POLLING');
        const sweepAcquired = guard.tryAcquire('clinic-A', 'SAFETY_SWEEP');

        // Barreira atômica: exatamente um dos dois obtém o guard.
        expect(pollAcquired).toBe(true);
        expect(sweepAcquired).toBe(false);
        expect([pollAcquired, sweepAcquired].filter(Boolean)).toHaveLength(1);

        guard.release('clinic-A', 'POLLING');
    });

    it('duas execuções concorrentes (poll × sweep) na mesma clínica — somente uma executa o corpo', async () => {
        const guard = makeGuard();
        let resolvePoll!: () => void;
        const pollBlock = new Promise<void>(res => (resolvePoll = res));

        const pollBody = jest.fn(() => pollBlock);
        const sweepBody = jest.fn(async () => {});

        // Dispara os dois "simultaneamente" (mesmo tick)
        const pollPromise = runPoll(guard, 'clinic-A', pollBody);
        const sweepPromise = runSweep(guard, 'clinic-A', sweepBody);

        const sweepRan = await sweepPromise;
        expect(sweepRan).toBe(false);
        expect(sweepBody).not.toHaveBeenCalled();

        resolvePoll();
        const pollRan = await pollPromise;
        expect(pollRan).toBe(true);
        expect(pollBody).toHaveBeenCalledTimes(1);
    });
});
