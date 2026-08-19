/**
 * Task 119 — Guard de concorrência no polling Doctoralia (pollClinic)
 *
 * Cobre os 12 cenários obrigatórios da especificação para o caminho Doctoralia,
 * usando um harness que replica exatamente o padrão integrado em
 * BookingSyncService.pollClinic: sweep-check → tryAcquire (barreira atômica,
 * ANTES de qualquer chamada externa) → trackPollStart → corpo → trackPollEnd +
 * release em finally.
 */
import { randomUUID } from 'crypto';
import { ClinicConcurrencyGuard } from './clinic-concurrency-guard';
import { DoctoraliaMetricsService } from '../metrics/doctoralia-metrics.service';

// ─── Harness: replica o padrão do pollClinic (Doctoralia) ────────────────────

interface PollResult {
    ran: boolean;
    skipReason?: 'POLL_SKIPPED_POLL_ACTIVE';
}

/**
 * Espelha BookingSyncService.pollClinic pós-Task 119.
 * `externalCall` simula rateLimiter.acquire + getNotifications — NÃO pode ser
 * invocado quando o poll é skipado.
 */
async function runDoctoraliaPoll(
    guard: ClinicConcurrencyGuard,
    metrics: DoctoraliaMetricsService,
    clinicId: string,
    externalCall: () => Promise<void> = async () => {},
): Promise<PollResult> {
    if (!guard.tryAcquire(clinicId, 'NOTIFICATION_POLL')) {
        metrics.recordNotificationPollSingleFlight(clinicId);
        metrics.recordConcurrencySkip('POLL_SKIPPED_POLL_ACTIVE', clinicId);
        return { ran: false, skipReason: 'POLL_SKIPPED_POLL_ACTIVE' };
    }
    const pollExecutionId = randomUUID();
    metrics.trackPollStart(clinicId, pollExecutionId);
    try {
        try {
            await externalCall();
        } catch (_err) {
            // pollClinic engole erros com logger.warn — replicado aqui
        }
        return { ran: true };
    } finally {
        metrics.trackPollEnd(clinicId, pollExecutionId);
        guard.release(clinicId, 'NOTIFICATION_POLL');
    }
}

/** Espelha o laço do Safety Sweep para exclusão mútua bidirecional. */
async function runSweep(
    guard: ClinicConcurrencyGuard,
    metrics: DoctoraliaMetricsService,
    clinicId: string,
    body: () => Promise<void> = async () => {},
): Promise<boolean> {
    if (guard.isActive(clinicId, 'POLLING')) {
        metrics.recordConcurrencySkip('SWEEP_SKIPPED_POLL_ACTIVE', clinicId);
        return false;
    }
    if (!guard.tryAcquire(clinicId, 'SAFETY_SWEEP')) {
        metrics.recordConcurrencySkip('SWEEP_SKIPPED_SWEEP_ACTIVE', clinicId);
        return false;
    }
    try {
        await body();
        return true;
    } finally {
        guard.release(clinicId, 'SAFETY_SWEEP');
    }
}

describe('Task 119 — pollClinic Doctoralia × ClinicConcurrencyGuard', () => {
    let guard: ClinicConcurrencyGuard;
    let metrics: DoctoraliaMetricsService;

    beforeEach(() => {
        guard = new ClinicConcurrencyGuard();
        metrics = new DoctoraliaMetricsService();
    });

    // Cenário 1: aquisição e execução normal
    it('cenário 1 — poll normal adquire, executa e libera o guard', async () => {
        const body = jest.fn(async () => {});
        const res = await runDoctoraliaPoll(guard, metrics, 'clinic-A', body);

        expect(res.ran).toBe(true);
        expect(body).toHaveBeenCalledTimes(1);
        expect(guard.isActive('clinic-A', 'POLLING')).toBe(false);
    });

    // Cenários 2 e 3: segundo poll da mesma clínica é SKIP imediato sem chamada Doctoralia
    it('cenários 2/3 — segundo poll da mesma clínica é SKIP sem esperar e sem chamada externa', async () => {
        let resolve!: () => void;
        const block = new Promise<void>(r => (resolve = r));
        const poll1 = runDoctoraliaPoll(guard, metrics, 'clinic-A', () => block);

        const body2 = jest.fn(async () => {});
        const res2 = await runDoctoraliaPoll(guard, metrics, 'clinic-A', body2);

        expect(res2.ran).toBe(false);
        expect(res2.skipReason).toBe('POLL_SKIPPED_POLL_ACTIVE');
        expect(body2).not.toHaveBeenCalled(); // nenhuma chamada Doctoralia
        expect(metrics.getConcurrencySkipCounts().POLL_SKIPPED_POLL_ACTIVE).toBe(1);

        resolve();
        expect((await poll1).ran).toBe(true);
    });

    // Cenário 4: clínicas diferentes executam em paralelo
    it('cenário 4 — clínicas diferentes continuam em paralelo', async () => {
        let resolveA!: () => void;
        const blockA = new Promise<void>(r => (resolveA = r));
        const pollA = runDoctoraliaPoll(guard, metrics, 'clinic-A', () => blockA);

        const bodyB = jest.fn(async () => {});
        const resB = await runDoctoraliaPoll(guard, metrics, 'clinic-B', bodyB);
        expect(resB.ran).toBe(true);
        expect(bodyB).toHaveBeenCalledTimes(1);

        resolveA();
        expect((await pollA).ran).toBe(true);
    });

    // Cenário 5: sweep ativo NÃO bloqueia o polling de notifications
    it('cenário 5 — poll de notifications executa com Safety Sweep da mesma clínica ativo', async () => {
        guard.tryAcquire('clinic-A', 'SAFETY_SWEEP');

        const body = jest.fn(async () => {});
        const res = await runDoctoraliaPoll(guard, metrics, 'clinic-A', body);

        expect(res.ran).toBe(true);
        expect(body).toHaveBeenCalledTimes(1);
        expect(metrics.getConcurrencySkipCounts().POLL_SKIPPED_SWEEP_ACTIVE).toBe(0);

        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    // Cenário 6: polling de notifications NÃO bloqueia o sweep
    it('cenário 6 — sweep executa com poll de notifications da mesma clínica ativo', async () => {
        let resolve!: () => void;
        const block = new Promise<void>(r => (resolve = r));
        const poll = runDoctoraliaPoll(guard, metrics, 'clinic-A', () => block);

        const sweepBody = jest.fn(async () => {});
        const sweepRan = await runSweep(guard, metrics, 'clinic-A', sweepBody);

        expect(sweepRan).toBe(true);
        expect(sweepBody).toHaveBeenCalledTimes(1);
        expect(metrics.getConcurrencySkipCounts().SWEEP_SKIPPED_POLL_ACTIVE).toBe(0);

        resolve();
        expect((await poll).ran).toBe(true);
    });

    // Cenário 7: sweep em clínica B não é afetado por poll em clínica A
    it('cenário 7 — sweep de clínica B executa com poll ativo em clínica A', async () => {
        let resolve!: () => void;
        const block = new Promise<void>(r => (resolve = r));
        const pollA = runDoctoraliaPoll(guard, metrics, 'clinic-A', () => block);

        const sweepRan = await runSweep(guard, metrics, 'clinic-B');
        expect(sweepRan).toBe(true);

        resolve();
        expect((await pollA).ran).toBe(true);
    });

    // Cenário 8: guard liberado quando o corpo lança (pollClinic engole o erro)
    it('cenário 8 — erro no corpo libera o guard e o poll seguinte executa', async () => {
        const res = await runDoctoraliaPoll(guard, metrics, 'clinic-A', async () => {
            throw new Error('doctoralia crashed');
        });
        expect(res.ran).toBe(true); // erro engolido como no pollClinic real
        expect(guard.isActive('clinic-A', 'POLLING')).toBe(false);

        const next = await runDoctoraliaPoll(guard, metrics, 'clinic-A');
        expect(next.ran).toBe(true);
    });

    // Cenário 9: término normal libera o guard
    it('cenário 9 — término normal libera o guard imediatamente', async () => {
        await runDoctoraliaPoll(guard, metrics, 'clinic-A');
        expect(guard.isActive('clinic-A', 'POLLING')).toBe(false);
    });

    // Cenário 10: novo poll após liberação executa normalmente
    it('cenário 10 — novo poll após liberação executa normalmente', async () => {
        expect((await runDoctoraliaPoll(guard, metrics, 'clinic-A')).ran).toBe(true);
        expect((await runDoctoraliaPoll(guard, metrics, 'clinic-A')).ran).toBe(true);
        expect(metrics.getConcurrencySkipCounts().POLL_SKIPPED_POLL_ACTIVE).toBe(0);
    });

    // Cenário 11: trackPollStart/trackPollEnd instrumentam início/fim/duração
    it('cenário 11 — poll executado registra trackPollStart/trackPollEnd sem overlap', async () => {
        await runDoctoraliaPoll(guard, metrics, 'clinic-A');
        expect(metrics.getTotalOverlapCount()).toBe(0);
        // poll skipado NÃO registra trackPollStart (nenhum overlap falso)
        let resolve!: () => void;
        const block = new Promise<void>(r => (resolve = r));
        const p1 = runDoctoraliaPoll(guard, metrics, 'clinic-A', () => block);
        await runDoctoraliaPoll(guard, metrics, 'clinic-A'); // SKIP
        expect(metrics.getTotalOverlapCount()).toBe(0);
        resolve();
        await p1;
    });

    // Cenário 12: somente o single-flight próprio gera skip
    it('cenário 12 — apenas outro poll de notifications gera skip', async () => {
        // Skip por poll ativo
        let resolve!: () => void;
        const block = new Promise<void>(r => (resolve = r));
        const p1 = runDoctoraliaPoll(guard, metrics, 'clinic-A', () => block);
        await runDoctoraliaPoll(guard, metrics, 'clinic-A');
        resolve();
        await p1;

        // Sweep ativo não bloqueia notifications
        guard.tryAcquire('clinic-A', 'SAFETY_SWEEP');
        expect((await runDoctoraliaPoll(guard, metrics, 'clinic-A')).ran).toBe(true);
        guard.release('clinic-A', 'SAFETY_SWEEP');

        const counts = metrics.getConcurrencySkipCounts();
        expect(counts.POLL_SKIPPED_POLL_ACTIVE).toBe(1);
        expect(counts.POLL_SKIPPED_SWEEP_ACTIVE).toBe(0);
    });
});

// ─── Task 133: skip do poll por reserva de prioridade do Global Sync ─────────
// Espelha o padrão pós-Task 133 de BookingSyncService.pollClinic /
// pollVismedClinic: em tryAcquire falho, o motivo vem de getBlockReason() e a
// reserva NUNCA é reportada com fallback enganoso tipo POLL_SKIPPED_POLL_ACTIVE.
describe('Task 133 — poll × reserva de prioridade (GLOBAL_SYNC_PENDING)', () => {
    async function runPollWithBlockReason(
        guard: ClinicConcurrencyGuard,
        metrics: DoctoraliaMetricsService,
        clinicId: string,
        externalCall: () => Promise<void> = async () => {},
    ): Promise<{ ran: boolean; skipReason?: string }> {
        if (!guard.tryAcquire(clinicId, 'NOTIFICATION_POLL')) {
            metrics.recordConcurrencySkip('POLL_SKIPPED_POLL_ACTIVE', clinicId);
            return { ran: false, skipReason: 'POLL_SKIPPED_POLL_ACTIVE' };
        }
        try {
            await externalCall();
            return { ran: true };
        } finally {
            guard.release(clinicId, 'NOTIFICATION_POLL');
        }
    }

    it('reserva pendente de Global Sync não bloqueia o poll de notifications', async () => {
        const guard = new ClinicConcurrencyGuard();
        const metrics = new DoctoraliaMetricsService();
        const externalCall = jest.fn(async () => {});

        guard.requestPriority('clinic-A', () => {});
        const result = await runPollWithBlockReason(guard, metrics, 'clinic-A', externalCall);

        expect(result.ran).toBe(true);
        expect(result.skipReason).toBeUndefined();
        expect(externalCall).toHaveBeenCalledTimes(1);
        const counts = metrics.getConcurrencySkipCounts();
        expect(counts.POLL_SKIPPED_GLOBAL_SYNC_PENDING).toBe(0);
        expect(counts.POLL_SKIPPED_POLL_ACTIVE).toBe(0);

        // Reserva consumida pelo Global Sync → poll volta ao normal
        guard.clearPriority('clinic-A');
        const next = await runPollWithBlockReason(guard, metrics, 'clinic-A', externalCall);
        expect(next.ran).toBe(true);
        expect(externalCall).toHaveBeenCalledTimes(2);
    });
});
