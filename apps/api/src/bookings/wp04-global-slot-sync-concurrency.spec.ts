/**
 * WP-04 — Lock por clínica completo: GLOBAL_SYNC + SLOT_SYNC no ClinicConcurrencyGuard
 *
 * Harnesses replicam os padrões integrados:
 *  - runGlobalSync  → SyncProcessor.process / SyncService.runDoctoraliaSyncDirect
 *    (tryAcquire GLOBAL_SYNC antes de tudo; skip finaliza o SyncRun como 'skipped';
 *    release em finally; SlotSync interno roda SEM novo acquire — sem auto-bloqueio)
 *  - runSlotSyncWatch → BlockWatcherService.watchClinic
 *    (tryAcquire SLOT_SYNC do fetch ao commit do snapshot; skip NÃO toca o snapshot)
 */
import { ClinicConcurrencyGuard, ConcurrencySubsystem } from './clinic-concurrency-guard';
import { DoctoraliaMetricsService, concurrencyActorOf, ConcurrencySkipType } from '../metrics/doctoralia-metrics.service';

// ─── Harnesses ───────────────────────────────────────────────────────────────

interface FakeSyncRun {
    id: string;
    status: string;
    metrics?: any;
}

interface GlobalSyncResult {
    ran: boolean;
    skipReason?: ConcurrencySkipType;
}

/**
 * Espelha SyncProcessor.process / runDoctoraliaSyncDirect pós-WP-04:
 * acquire → corpo (que pode chamar SlotSync interno) → release em finally.
 * No SKIP finaliza o run como 'skipped' (nunca órfão em 'running').
 */
async function runGlobalSync(
    guard: ClinicConcurrencyGuard,
    metrics: DoctoraliaMetricsService,
    clinicId: string,
    syncRun: FakeSyncRun,
    body: (internalSlotSync: () => Promise<void>) => Promise<void> = async () => {},
): Promise<GlobalSyncResult> {
    if (!guard.tryAcquire(clinicId, 'GLOBAL_SYNC')) {
        const blocker = concurrencyActorOf(guard.getActiveSubsystem(clinicId) ?? 'GLOBAL_SYNC');
        const reason = `GLOBAL_SYNC_SKIPPED_${blocker}_ACTIVE` as ConcurrencySkipType;
        metrics.recordConcurrencySkip(reason, clinicId);
        syncRun.status = 'skipped';
        syncRun.metrics = { skipReason: reason };
        return { ran: false, skipReason: reason };
    }
    try {
        // SlotSync interno do global sync — roda no MESMO lock, sem novo acquire.
        const internalSlotSync = async () => { /* sem tryAcquire — não se auto-bloqueia */ };
        await body(internalSlotSync);
        syncRun.status = 'completed';
        return { ran: true };
    } catch (err) {
        syncRun.status = 'failed';
        throw err;
    } finally {
        guard.release(clinicId, 'GLOBAL_SYNC');
    }
}

interface SlotSyncResult {
    ran: boolean;
    skipReason?: ConcurrencySkipType;
}

/** Espelha BlockWatcherService.watchClinic pós-WP-04. */
async function runSlotSyncWatch(
    guard: ClinicConcurrencyGuard,
    metrics: DoctoraliaMetricsService,
    clinicId: string,
    snapshot: { value: string },
    body: () => Promise<void> = async () => {},
): Promise<SlotSyncResult> {
    if (!guard.tryAcquire(clinicId, 'SLOT_SYNC')) {
        const blocker = concurrencyActorOf(guard.getActiveSubsystem(clinicId) ?? 'SLOT_SYNC');
        const reason = `SLOT_SYNC_SKIPPED_${blocker}_ACTIVE` as ConcurrencySkipType;
        metrics.recordConcurrencySkip(reason, clinicId);
        return { ran: false, skipReason: reason }; // snapshot intacto
    }
    try {
        await body();
        snapshot.value = 'updated';
        return { ran: true };
    } finally {
        guard.release(clinicId, 'SLOT_SYNC');
    }
}

/** Espelha pollClinic/pollVismedClinic pós-WP-04. */
async function runPoll(
    guard: ClinicConcurrencyGuard,
    metrics: DoctoraliaMetricsService,
    clinicId: string,
    body: () => Promise<void> = async () => {},
): Promise<{ ran: boolean; skipReason?: ConcurrencySkipType }> {
    if (guard.isActive(clinicId, 'SAFETY_SWEEP')) {
        metrics.recordConcurrencySkip('POLL_SKIPPED_SWEEP_ACTIVE', clinicId);
        return { ran: false, skipReason: 'POLL_SKIPPED_SWEEP_ACTIVE' };
    }
    if (!guard.tryAcquire(clinicId, 'POLLING')) {
        const blocker = concurrencyActorOf(guard.getActiveSubsystem(clinicId) ?? 'POLLING');
        const reason = `POLL_SKIPPED_${blocker}_ACTIVE` as ConcurrencySkipType;
        metrics.recordConcurrencySkip(reason, clinicId);
        return { ran: false, skipReason: reason };
    }
    try {
        await body();
        return { ran: true };
    } finally {
        guard.release(clinicId, 'POLLING');
    }
}

/** Espelha runSweepAllClinics pós-WP-04. */
async function runSweep(
    guard: ClinicConcurrencyGuard,
    metrics: DoctoraliaMetricsService,
    clinicId: string,
    body: () => Promise<void> = async () => {},
): Promise<{ ran: boolean; skipReason?: ConcurrencySkipType }> {
    if (guard.isActive(clinicId, 'POLLING')) {
        metrics.recordConcurrencySkip('SWEEP_SKIPPED_POLL_ACTIVE', clinicId);
        return { ran: false, skipReason: 'SWEEP_SKIPPED_POLL_ACTIVE' };
    }
    if (!guard.tryAcquire(clinicId, 'SAFETY_SWEEP')) {
        const blocker = concurrencyActorOf(guard.getActiveSubsystem(clinicId) ?? 'SAFETY_SWEEP');
        const reason = `SWEEP_SKIPPED_${blocker}_ACTIVE` as ConcurrencySkipType;
        metrics.recordConcurrencySkip(reason, clinicId);
        return { ran: false, skipReason: reason };
    }
    try {
        await body();
        return { ran: true };
    } finally {
        guard.release(clinicId, 'SAFETY_SWEEP');
    }
}

function makeRun(): FakeSyncRun {
    return { id: 'run-1', status: 'running' };
}

// ─── Testes ──────────────────────────────────────────────────────────────────

describe('WP-04 — guard unitário: GLOBAL_SYNC e SLOT_SYNC no union', () => {
    let guard: ClinicConcurrencyGuard;
    beforeEach(() => { guard = new ClinicConcurrencyGuard(); });

    const all: ConcurrencySubsystem[] = ['POLLING', 'SAFETY_SWEEP', 'GLOBAL_SYNC', 'SLOT_SYNC'];

    it.each(all.flatMap(a => all.map(b => [a, b] as const)))(
        'exclusão total: %s ativo bloqueia %s na mesma clínica',
        (first, second) => {
            expect(guard.tryAcquire('clinic-A', first)).toBe(true);
            expect(guard.tryAcquire('clinic-A', second)).toBe(false);
            guard.release('clinic-A', first);
        },
    );

    it('getActiveSubsystem devolve o subsistema ativo e null quando livre', () => {
        expect(guard.getActiveSubsystem('clinic-A')).toBeNull();
        guard.tryAcquire('clinic-A', 'GLOBAL_SYNC');
        expect(guard.getActiveSubsystem('clinic-A')).toBe('GLOBAL_SYNC');
        guard.release('clinic-A', 'GLOBAL_SYNC');
        expect(guard.getActiveSubsystem('clinic-A')).toBeNull();
    });
});

describe('WP-04 — GLOBAL_SYNC × outros subsistemas (ambas direções)', () => {
    let guard: ClinicConcurrencyGuard;
    let metrics: DoctoraliaMetricsService;
    beforeEach(() => {
        guard = new ClinicConcurrencyGuard();
        metrics = new DoctoraliaMetricsService();
    });

    it('GLOBAL_SYNC × POLLING — poll skipado com motivo GLOBAL_SYNC durante o run inteiro', async () => {
        let release!: () => void;
        const block = new Promise<void>(r => (release = r));
        const run = makeRun();
        const gs = runGlobalSync(guard, metrics, 'clinic-A', run, () => block);

        const pollBody = jest.fn(async () => {});
        const poll = await runPoll(guard, metrics, 'clinic-A', pollBody);
        expect(poll.ran).toBe(false);
        expect(poll.skipReason).toBe('POLL_SKIPPED_GLOBAL_SYNC_ACTIVE');
        expect(pollBody).not.toHaveBeenCalled();
        expect(metrics.getConcurrencySkipCounts().POLL_SKIPPED_GLOBAL_SYNC_ACTIVE).toBe(1);

        release();
        expect((await gs).ran).toBe(true);
        expect((await runPoll(guard, metrics, 'clinic-A')).ran).toBe(true);
    });

    it('POLLING × GLOBAL_SYNC — global sync skipado por poll ativo, run finalizado como skipped', async () => {
        let release!: () => void;
        const block = new Promise<void>(r => (release = r));
        const poll = runPoll(guard, metrics, 'clinic-A', () => block);

        const run = makeRun();
        const gs = await runGlobalSync(guard, metrics, 'clinic-A', run);
        expect(gs.ran).toBe(false);
        expect(gs.skipReason).toBe('GLOBAL_SYNC_SKIPPED_POLL_ACTIVE');
        // NÃO deixa SyncRun órfão em 'running'
        expect(run.status).toBe('skipped');
        expect(run.metrics.skipReason).toBe('GLOBAL_SYNC_SKIPPED_POLL_ACTIVE');
        expect(metrics.getConcurrencySkipCounts().GLOBAL_SYNC_SKIPPED_POLL_ACTIVE).toBe(1);

        release();
        expect((await poll).ran).toBe(true);
    });

    it('GLOBAL_SYNC × SAFETY_SWEEP — sweep skipado com motivo GLOBAL_SYNC', async () => {
        guard.tryAcquire('clinic-A', 'GLOBAL_SYNC');
        const sweep = await runSweep(guard, metrics, 'clinic-A');
        expect(sweep.ran).toBe(false);
        expect(sweep.skipReason).toBe('SWEEP_SKIPPED_GLOBAL_SYNC_ACTIVE');
        expect(metrics.getConcurrencySkipCounts().SWEEP_SKIPPED_GLOBAL_SYNC_ACTIVE).toBe(1);
        guard.release('clinic-A', 'GLOBAL_SYNC');
    });

    it('SAFETY_SWEEP × GLOBAL_SYNC — global sync skipado por sweep ativo', async () => {
        guard.tryAcquire('clinic-A', 'SAFETY_SWEEP');
        const run = makeRun();
        const gs = await runGlobalSync(guard, metrics, 'clinic-A', run);
        expect(gs.ran).toBe(false);
        expect(gs.skipReason).toBe('GLOBAL_SYNC_SKIPPED_SWEEP_ACTIVE');
        expect(run.status).toBe('skipped');
        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    it('GLOBAL_SYNC × SLOT_SYNC — watcher skipado sem tocar o snapshot', async () => {
        guard.tryAcquire('clinic-A', 'GLOBAL_SYNC');
        const snapshot = { value: 'original' };
        const res = await runSlotSyncWatch(guard, metrics, 'clinic-A', snapshot);
        expect(res.ran).toBe(false);
        expect(res.skipReason).toBe('SLOT_SYNC_SKIPPED_GLOBAL_SYNC_ACTIVE');
        expect(snapshot.value).toBe('original'); // próximo ciclo redetecta
        expect(metrics.getConcurrencySkipCounts().SLOT_SYNC_SKIPPED_GLOBAL_SYNC_ACTIVE).toBe(1);
        guard.release('clinic-A', 'GLOBAL_SYNC');
    });

    it('SLOT_SYNC × GLOBAL_SYNC — global sync skipado por slot sync ativo, run skipped', async () => {
        guard.tryAcquire('clinic-A', 'SLOT_SYNC');
        const run = makeRun();
        const gs = await runGlobalSync(guard, metrics, 'clinic-A', run);
        expect(gs.ran).toBe(false);
        expect(gs.skipReason).toBe('GLOBAL_SYNC_SKIPPED_SLOT_SYNC_ACTIVE');
        expect(run.status).toBe('skipped');
        guard.release('clinic-A', 'SLOT_SYNC');
    });

    it('segundo GLOBAL_SYNC da mesma clínica é rejeitado', async () => {
        let release!: () => void;
        const block = new Promise<void>(r => (release = r));
        const run1 = makeRun();
        const gs1 = runGlobalSync(guard, metrics, 'clinic-A', run1, () => block);

        const run2 = makeRun();
        const gs2 = await runGlobalSync(guard, metrics, 'clinic-A', run2);
        expect(gs2.ran).toBe(false);
        expect(gs2.skipReason).toBe('GLOBAL_SYNC_SKIPPED_GLOBAL_SYNC_ACTIVE');
        expect(run2.status).toBe('skipped');

        release();
        expect((await gs1).ran).toBe(true);
        expect(run1.status).toBe('completed');
    });

    it('global sync chamando SlotSync internamente NÃO se auto-bloqueia', async () => {
        const run = makeRun();
        const internalCalls = jest.fn();
        const gs = await runGlobalSync(guard, metrics, 'clinic-A', run, async (internalSlotSync) => {
            await internalSlotSync();
            internalCalls();
        });
        expect(gs.ran).toBe(true);
        expect(internalCalls).toHaveBeenCalledTimes(1);
        expect(run.status).toBe('completed');
        expect(guard.getActiveSubsystem('clinic-A')).toBeNull();
    });

    it('exceção no global sync libera o guard (release em finally) e run vira failed', async () => {
        const run = makeRun();
        await expect(
            runGlobalSync(guard, metrics, 'clinic-A', run, async () => { throw new Error('boom'); }),
        ).rejects.toThrow('boom');
        expect(run.status).toBe('failed');
        expect(guard.getActiveSubsystem('clinic-A')).toBeNull();
        // Próxima execução adquire normalmente
        expect((await runGlobalSync(guard, metrics, 'clinic-A', makeRun())).ran).toBe(true);
    });
});

describe('WP-04 — SLOT_SYNC × outros subsistemas (ambas direções)', () => {
    let guard: ClinicConcurrencyGuard;
    let metrics: DoctoraliaMetricsService;
    beforeEach(() => {
        guard = new ClinicConcurrencyGuard();
        metrics = new DoctoraliaMetricsService();
    });

    it('SLOT_SYNC × POLLING — poll skipado com motivo SLOT_SYNC', async () => {
        guard.tryAcquire('clinic-A', 'SLOT_SYNC');
        const poll = await runPoll(guard, metrics, 'clinic-A');
        expect(poll.ran).toBe(false);
        expect(poll.skipReason).toBe('POLL_SKIPPED_SLOT_SYNC_ACTIVE');
        expect(metrics.getConcurrencySkipCounts().POLL_SKIPPED_SLOT_SYNC_ACTIVE).toBe(1);
        guard.release('clinic-A', 'SLOT_SYNC');
    });

    it('POLLING × SLOT_SYNC — watcher skipado por poll ativo, snapshot intacto', async () => {
        let release!: () => void;
        const block = new Promise<void>(r => (release = r));
        const poll = runPoll(guard, metrics, 'clinic-A', () => block);

        const snapshot = { value: 'original' };
        const res = await runSlotSyncWatch(guard, metrics, 'clinic-A', snapshot);
        expect(res.ran).toBe(false);
        expect(res.skipReason).toBe('SLOT_SYNC_SKIPPED_POLL_ACTIVE');
        expect(snapshot.value).toBe('original');
        expect(metrics.getConcurrencySkipCounts().SLOT_SYNC_SKIPPED_POLL_ACTIVE).toBe(1);

        release();
        expect((await poll).ran).toBe(true);
    });

    it('SLOT_SYNC × SAFETY_SWEEP — sweep skipado com motivo SLOT_SYNC', async () => {
        guard.tryAcquire('clinic-A', 'SLOT_SYNC');
        const sweep = await runSweep(guard, metrics, 'clinic-A');
        expect(sweep.ran).toBe(false);
        expect(sweep.skipReason).toBe('SWEEP_SKIPPED_SLOT_SYNC_ACTIVE');
        guard.release('clinic-A', 'SLOT_SYNC');
    });

    it('SAFETY_SWEEP × SLOT_SYNC — watcher skipado por sweep ativo', async () => {
        guard.tryAcquire('clinic-A', 'SAFETY_SWEEP');
        const snapshot = { value: 'original' };
        const res = await runSlotSyncWatch(guard, metrics, 'clinic-A', snapshot);
        expect(res.ran).toBe(false);
        expect(res.skipReason).toBe('SLOT_SYNC_SKIPPED_SWEEP_ACTIVE');
        expect(snapshot.value).toBe('original');
        guard.release('clinic-A', 'SAFETY_SWEEP');
    });

    it('segundo SLOT_SYNC da mesma clínica é rejeitado', async () => {
        let release!: () => void;
        const block = new Promise<void>(r => (release = r));
        const snap1 = { value: 'original' };
        const ss1 = runSlotSyncWatch(guard, metrics, 'clinic-A', snap1, () => block);

        const snap2 = { value: 'original' };
        const ss2 = await runSlotSyncWatch(guard, metrics, 'clinic-A', snap2);
        expect(ss2.ran).toBe(false);
        expect(ss2.skipReason).toBe('SLOT_SYNC_SKIPPED_SLOT_SYNC_ACTIVE');
        expect(snap2.value).toBe('original');

        release();
        expect((await ss1).ran).toBe(true);
        expect(snap1.value).toBe('updated');
    });

    it('exceção no watcher libera o guard e mantém snapshot intacto', async () => {
        const snapshot = { value: 'original' };
        await expect(
            runSlotSyncWatch(guard, metrics, 'clinic-A', snapshot, async () => { throw new Error('fetch failed'); }),
        ).rejects.toThrow('fetch failed');
        expect(snapshot.value).toBe('original');
        expect(guard.getActiveSubsystem('clinic-A')).toBeNull();
        expect((await runSlotSyncWatch(guard, metrics, 'clinic-A', snapshot)).ran).toBe(true);
    });
});

describe('WP-04 — independência entre clínicas', () => {
    it('GLOBAL_SYNC em A não bloqueia GLOBAL_SYNC/SLOT_SYNC/POLLING em B', async () => {
        const guard = new ClinicConcurrencyGuard();
        const metrics = new DoctoraliaMetricsService();
        guard.tryAcquire('clinic-A', 'GLOBAL_SYNC');

        expect((await runGlobalSync(guard, metrics, 'clinic-B', makeRun())).ran).toBe(true);
        expect((await runSlotSyncWatch(guard, metrics, 'clinic-B', { value: 'x' })).ran).toBe(true);
        expect((await runPoll(guard, metrics, 'clinic-B')).ran).toBe(true);

        guard.release('clinic-A', 'GLOBAL_SYNC');
    });
});

describe('WP-04 — métricas dos novos cruzamentos', () => {
    it('todos os 16 contadores existem zerados e aparecem no baseline', () => {
        const metrics = new DoctoraliaMetricsService();
        const counts = metrics.getConcurrencySkipCounts();
        expect(Object.keys(counts)).toHaveLength(16);
        for (const v of Object.values(counts)) expect(v).toBe(0);

        metrics.recordConcurrencySkip('GLOBAL_SYNC_SKIPPED_POLL_ACTIVE', 'c1');
        metrics.recordConcurrencySkip('SLOT_SYNC_SKIPPED_GLOBAL_SYNC_ACTIVE', 'c1');
        metrics.recordConcurrencySkip('POLL_SKIPPED_GLOBAL_SYNC_ACTIVE', 'c1');
        metrics.recordConcurrencySkip('SWEEP_SKIPPED_SLOT_SYNC_ACTIVE', 'c1');

        const baseline = metrics.getBaseline() as any;
        expect(baseline.concurrencyGuard.GLOBAL_SYNC_SKIPPED_POLL_ACTIVE).toBe(1);
        expect(baseline.concurrencyGuard.SLOT_SYNC_SKIPPED_GLOBAL_SYNC_ACTIVE).toBe(1);
        expect(baseline.concurrencyGuard.POLL_SKIPPED_GLOBAL_SYNC_ACTIVE).toBe(1);
        expect(baseline.concurrencyGuard.SWEEP_SKIPPED_SLOT_SYNC_ACTIVE).toBe(1);
        // Contadores WP-02 preservados
        expect(baseline.concurrencyGuard.POLL_SKIPPED_POLL_ACTIVE).toBe(0);
    });

    it('reset() zera os novos contadores', () => {
        const metrics = new DoctoraliaMetricsService();
        metrics.recordConcurrencySkip('GLOBAL_SYNC_SKIPPED_SLOT_SYNC_ACTIVE', 'c1');
        metrics.reset();
        expect(metrics.getConcurrencySkipCounts().GLOBAL_SYNC_SKIPPED_SLOT_SYNC_ACTIVE).toBe(0);
    });
});
