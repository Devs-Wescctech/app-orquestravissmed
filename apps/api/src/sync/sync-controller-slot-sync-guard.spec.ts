/**
 * WP-04 — SLOT_SYNC disparado pelo usuário (SyncController) sob o ClinicConcurrencyGuard.
 *
 * Exercita os endpoints REAIS do controller (syncSlotsForDoctor e syncAllSlots)
 * com dependências stubadas: quando qualquer subsistema está ativo para a clínica,
 * o endpoint responde 409 (ConflictException) SEM nenhuma chamada externa
 * (nem getDoctoraliaClient nem SlotSyncService), registra a métrica com o motivo
 * correto e libera o guard em finally (sucesso e exceção).
 */
import { ConflictException } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { ClinicConcurrencyGuard, ConcurrencySubsystem } from '../bookings/clinic-concurrency-guard';
import { DoctoraliaMetricsService, concurrencyActorOf } from '../metrics/doctoralia-metrics.service';

const CLINIC = 'clinic-A';
const SUPER_ADMIN_REQ = { user: { roles: [{ role: 'SUPER_ADMIN' }] } };

function makeController(guard: ClinicConcurrencyGuard) {
    const createClient = jest.fn().mockReturnValue({ fake: 'client' });
    const prisma = {
        integrationConnection: {
            findFirst: jest.fn().mockResolvedValue({ clinicId: CLINIC, clientId: 'id', clientSecret: 's', domain: null }),
        },
        mapping: {
            findFirst: jest.fn().mockResolvedValue({ id: 'map-1', vismedId: 'doc-1' }),
            findMany: jest.fn().mockResolvedValue([]),
        },
    } as any;
    const docplanner = { createClient } as any;
    const slotSync = {
        syncSlotsForDoctor: jest.fn().mockResolvedValue({ success: true, message: 'ok' }),
        syncAllSlots: jest.fn().mockResolvedValue({ success: true, message: 'ok' }),
    } as any;
    const controller = new SyncController(
        {} as any /* syncService */,
        prisma,
        docplanner,
        slotSync,
        {} as any /* pushSync */,
        guard,
    );
    return { controller, slotSync, createClient, prisma };
}

// Reduz o sleep de 1s dos endpoints para não atrasar a suíte.
beforeAll(() => {
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any) => { fn(); return 0 as any; }) as any);
});
afterAll(() => jest.restoreAllMocks());

describe('WP-04 — SyncController.syncSlotsForDoctor sob o guard (caminho real)', () => {
    let guard: ClinicConcurrencyGuard;
    let metrics: DoctoraliaMetricsService;

    beforeEach(() => {
        guard = new ClinicConcurrencyGuard();
        metrics = new DoctoraliaMetricsService(); // registra singleton global
    });

    const blockers: ConcurrencySubsystem[] = ['GLOBAL_SYNC', 'POLLING', 'SAFETY_SWEEP', 'SLOT_SYNC'];

    it.each(blockers)('%s ativo → 409, sem chamada externa, métrica com motivo correto', async (blocker) => {
        const { controller, slotSync, createClient } = makeController(guard);
        guard.tryAcquire(CLINIC, blocker);

        await expect(
            controller.syncSlotsForDoctor(CLINIC, 'doc-1', 30, SUPER_ADMIN_REQ),
        ).rejects.toThrow(ConflictException);

        expect(createClient).not.toHaveBeenCalled();
        expect(slotSync.syncSlotsForDoctor).not.toHaveBeenCalled();
        const key = `SLOT_SYNC_SKIPPED_${concurrencyActorOf(blocker)}_ACTIVE` as const;
        expect(metrics.getConcurrencySkipCounts()[key]).toBe(1);

        guard.release(CLINIC, blocker);
    });

    it('Task 133: reserva de prioridade pendente → 409 com SLOT_SYNC_SKIPPED_GLOBAL_SYNC_PENDING (nunca motivo enganoso)', async () => {
        const { controller, slotSync, createClient } = makeController(guard);
        guard.requestPriority(CLINIC, () => {});

        await expect(
            controller.syncSlotsForDoctor(CLINIC, 'doc-1', 30, SUPER_ADMIN_REQ),
        ).rejects.toThrow(/GLOBAL_SYNC_PENDING/);

        expect(createClient).not.toHaveBeenCalled();
        expect(slotSync.syncSlotsForDoctor).not.toHaveBeenCalled();
        const counts = metrics.getConcurrencySkipCounts();
        expect(counts.SLOT_SYNC_SKIPPED_GLOBAL_SYNC_PENDING).toBe(1);
        expect(counts.SLOT_SYNC_SKIPPED_SLOT_SYNC_ACTIVE).toBe(0);

        guard.clearPriority(CLINIC);
    });

    it('clínica livre → executa, chama SlotSyncService e libera o guard em finally', async () => {
        const { controller, slotSync } = makeController(guard);

        const res = await controller.syncSlotsForDoctor(CLINIC, 'doc-1', 30, SUPER_ADMIN_REQ);
        expect(res).toEqual({ success: true, message: 'ok' });
        expect(slotSync.syncSlotsForDoctor).toHaveBeenCalledTimes(1);
        expect(guard.getActiveSubsystem(CLINIC)).toBeNull(); // released

        // enquanto executa, o guard fica ativo (GLOBAL_SYNC seria bloqueado)
        let release!: () => void;
        slotSync.syncSlotsForDoctor.mockImplementationOnce(
            () => new Promise(r => { release = () => r({ success: true, message: 'ok' }); }),
        );
        const inflight = controller.syncSlotsForDoctor(CLINIC, 'doc-1', 30, SUPER_ADMIN_REQ);
        await new Promise(r => setImmediate(r));
        expect(guard.isActive(CLINIC, 'SLOT_SYNC')).toBe(true);
        expect(guard.tryAcquire(CLINIC, 'GLOBAL_SYNC')).toBe(false);
        release();
        await inflight;
        expect(guard.getActiveSubsystem(CLINIC)).toBeNull();
    });

    it('exceção do SlotSyncService libera o guard (release em finally)', async () => {
        const { controller, slotSync } = makeController(guard);
        slotSync.syncSlotsForDoctor.mockRejectedValueOnce(new Error('doctoralia down'));

        await expect(
            controller.syncSlotsForDoctor(CLINIC, 'doc-1', 30, SUPER_ADMIN_REQ),
        ).rejects.toThrow('doctoralia down');
        expect(guard.getActiveSubsystem(CLINIC)).toBeNull();

        // próxima execução adquire normalmente
        await expect(controller.syncSlotsForDoctor(CLINIC, 'doc-1', 30, SUPER_ADMIN_REQ)).resolves.toBeDefined();
    });

    it('clínicas diferentes são independentes — B executa com GLOBAL_SYNC ativo em A', async () => {
        const { controller, prisma } = makeController(guard);
        prisma.integrationConnection.findFirst.mockResolvedValue({ clinicId: 'clinic-B', clientId: 'id', clientSecret: 's', domain: null });
        guard.tryAcquire(CLINIC, 'GLOBAL_SYNC');

        await expect(controller.syncSlotsForDoctor('clinic-B', 'doc-1', 30, SUPER_ADMIN_REQ)).resolves.toBeDefined();
        guard.release(CLINIC, 'GLOBAL_SYNC');
    });
});

describe('WP-04 — SyncController.syncAllSlots sob o guard (caminho real)', () => {
    let guard: ClinicConcurrencyGuard;
    let metrics: DoctoraliaMetricsService;

    beforeEach(() => {
        guard = new ClinicConcurrencyGuard();
        metrics = new DoctoraliaMetricsService();
    });

    it('GLOBAL_SYNC ativo → 409 sem chamadas externas', async () => {
        const { controller, slotSync, createClient } = makeController(guard);
        guard.tryAcquire(CLINIC, 'GLOBAL_SYNC');

        await expect(controller.syncAllSlots(CLINIC, 30, SUPER_ADMIN_REQ)).rejects.toThrow(ConflictException);
        expect(createClient).not.toHaveBeenCalled();
        expect(slotSync.syncAllSlots).not.toHaveBeenCalled();
        expect(metrics.getConcurrencySkipCounts().SLOT_SYNC_SKIPPED_GLOBAL_SYNC_ACTIVE).toBe(1);

        guard.release(CLINIC, 'GLOBAL_SYNC');
    });

    it('clínica livre → executa e libera o guard', async () => {
        const { controller, slotSync } = makeController(guard);
        await expect(controller.syncAllSlots(CLINIC, 30, SUPER_ADMIN_REQ)).resolves.toBeDefined();
        expect(slotSync.syncAllSlots).toHaveBeenCalledTimes(1);
        expect(guard.getActiveSubsystem(CLINIC)).toBeNull();
    });

    it('exceção libera o guard', async () => {
        const { controller, slotSync } = makeController(guard);
        slotSync.syncAllSlots.mockRejectedValueOnce(new Error('boom'));
        await expect(controller.syncAllSlots(CLINIC, 30, SUPER_ADMIN_REQ)).rejects.toThrow('boom');
        expect(guard.getActiveSubsystem(CLINIC)).toBeNull();
    });
});
