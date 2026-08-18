/**
 * WP3 (Ajustes 1 e 3) — Gate e deduplicação da consistency check do BlockWatcher.
 *
 * Cobre:
 *  (a) Ciclo SEM mudança (`affected` vazio) → ZERO chamadas scheduleDay por causa
 *      da consistency check (buildForPairs nunca chamado).
 *  (b) Mudanças em N médicos que compartilham a mesma combinação categoria+data
 *      → UMA única passada buildForPairs com pares deduplicados (nenhuma chamada
 *      duplicada por clinicId+categoria+data no mesmo ciclo).
 *  (c) Falha re-tentável do executor de breaks → rollback do hash (redetecção
 *      no próximo ciclo).
 */

import { BlockWatcherService } from './block-watcher.service';
import { ClinicAvailability } from './vismed-availability.service';

const CLINIC = { id: 'clinic-1', name: 'Clínica Teste' };

function makeDeps(blocks: any[]) {
    const prisma: any = {
        syncRun: { count: jest.fn(async () => 0) },
        integrationConnection: {
            findFirst: jest.fn(async ({ where }: any) => ({
                id: `conn-${where.provider}`, provider: where.provider, clinicId: CLINIC.id,
                status: 'connected', clientId: '286', clientSecret: 's', domain: null, facilityId: 'fac-1',
            })),
        },
        vismedDoctor: {
            findUnique: jest.fn(async ({ where }: any) => ({ id: `vd-${where.vismedId}`, name: `Dr ${where.vismedId}` })),
            findFirst: jest.fn(async ({ where }: any) => ({
                id: `vd-${where.vismedId}`,
                // Ambos os médicos compartilham a MESMA categoria 100
                specialties: [{ specialty: { vismedId: 100, idEmpresaGestora: 286 } }],
            })),
        },
        auditLog: { create: jest.fn(async ({ data }: any) => data) },
    };
    const vismed: any = { getBloqueiosProfissional: jest.fn(async () => blocks) };
    const docplanner: any = { createClient: jest.fn(() => ({ mock: 'client' })) };
    const slotSync: any = { syncSlotsForDoctor: jest.fn(async () => ({ success: true, message: 'ok', slotsCreated: 1 })) };
    const guard: any = { tryAcquire: jest.fn(() => true), release: jest.fn(), getBlockReason: jest.fn(() => null) };
    const adminBlockBreak: any = {
        loadAllSnapshots: jest.fn(async () => new Map()),
        upsert: jest.fn(async () => ({})),
        reconcileSnapshotForDoctor: jest.fn(async () => ({ cancelledCount: 0 })),
        cancelSnapshotForDoctor: jest.fn(async () => ({ count: 0 })),
    };
    const blockPeriodAudit: any = {
        parseWithAudit: jest.fn(async (raw: any) => {
            // Parser real simplificado: aceita HH:MM válidos, rejeita o resto
            const m = /^(\d{2}):(\d{2})$/;
            if (!m.test(raw.startRaw) || !m.test(raw.endRaw)) return null;
            return {
                since: new Date(`${raw.date}T${raw.startRaw}:00`),
                till: new Date(`${raw.date}T${raw.endRaw}:00`),
                sinceHHMM: raw.startRaw, tillHHMM: raw.endRaw,
            };
        }),
        checkAndLogConsistency: jest.fn(),
    };
    const availabilityService: any = {
        buildForPairs: jest.fn(async () => new ClinicAvailability()),
        buildForCategories: jest.fn(async () => new ClinicAvailability()),
    };
    const blockBreakSync: any = {
        resolveMode: jest.fn(() => 'shadow'),
        syncDoctorBlocks: jest.fn(async () => ({ ok: true, mode: 'shadow', planned: { create: 0, move: 0, delete: 0 }, executed: { create: 0, move: 0, delete: 0 }, failures: 0, skippedUnrecoverable: 0 })),
    };

    const svc = new BlockWatcherService(
        prisma, vismed, docplanner, slotSync, guard,
        adminBlockBreak, blockBreakSync, blockPeriodAudit, availabilityService,
    );
    return { svc, prisma, vismed, availabilityService, blockBreakSync, slotSync };
}

async function runCycle(svc: BlockWatcherService) {
    await (svc as any).watchClinic(CLINIC.id, CLINIC.name);
    // consistency check é fire-and-forget — drena a microtask queue
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
}

const block = (idprofissional: number, date = '2026-09-01') => ({
    idprofissional, idbloqueio: `blk-${idprofissional}-${date}`,
    dataagendamento: date, horarioagendamento: '09:00', horarioagendamentofinal: '11:00',
});

afterEach(() => jest.clearAllMocks());

describe('BlockWatcher — gate da consistency check (Ajuste 1)', () => {
    it('ciclo sem mudança de bloqueio → ZERO chamadas scheduleDay pela consistency check', async () => {
        const blocks = [block(42), block(43)];
        const { svc, availabilityService, blockBreakSync } = makeDeps(blocks);

        // Ciclo 1: tudo é "novo" → affected = {42,43} → consistency roda
        await runCycle(svc);
        expect(availabilityService.buildForPairs).toHaveBeenCalledTimes(1);

        // Ciclo 2: MESMOS bloqueios → affected vazio → NENHUMA chamada adicional
        availabilityService.buildForPairs.mockClear();
        blockBreakSync.syncDoctorBlocks.mockClear();
        await runCycle(svc);
        expect(availabilityService.buildForPairs).not.toHaveBeenCalled();
        expect(availabilityService.buildForCategories).not.toHaveBeenCalled();
        expect(blockBreakSync.syncDoctorBlocks).not.toHaveBeenCalled();
    });
});

describe('BlockWatcher — dedup por clinicId+categoria+data (Ajuste 3)', () => {
    it('N médicos com a mesma categoria+data → UMA passada com pares deduplicados', async () => {
        // 3 médicos, mesma categoria (100), mesma data → 1 par único
        const blocks = [block(42), block(43), block(44)];
        const { svc, availabilityService } = makeDeps(blocks);
        await runCycle(svc);
        expect(availabilityService.buildForPairs).toHaveBeenCalledTimes(1);
        const [clinicId, pairs] = availabilityService.buildForPairs.mock.calls[0];
        expect(clinicId).toBe(CLINIC.id);
        expect(pairs).toEqual([{ categoryId: 100, date: '2026-09-01' }]);
    });

    it('datas distintas geram pares distintos, mas ainda numa única passada', async () => {
        const blocks = [block(42, '2026-09-01'), block(43, '2026-09-02')];
        const { svc, availabilityService } = makeDeps(blocks);
        await runCycle(svc);
        expect(availabilityService.buildForPairs).toHaveBeenCalledTimes(1);
        const pairs = availabilityService.buildForPairs.mock.calls[0][1];
        expect(pairs).toHaveLength(2);
        expect(new Set(pairs.map((p: any) => `${p.categoryId}|${p.date}`)))
            .toEqual(new Set(['100|2026-09-01', '100|2026-09-02']));
    });
});

describe('BlockWatcher — integração com executor de breaks (WP3)', () => {
    it('executor é chamado com os blocos RAW do médico afetado', async () => {
        const blocks = [block(42)];
        const { svc, blockBreakSync } = makeDeps(blocks);
        await runCycle(svc);
        expect(blockBreakSync.syncDoctorBlocks).toHaveBeenCalledTimes(1);
        const arg = blockBreakSync.syncDoctorBlocks.mock.calls[0][0];
        expect(arg.clinicId).toBe(CLINIC.id);
        expect(arg.idprofissional).toBe(42);
        expect(arg.rawBlocks).toEqual(blocks);
    });

    it('modo off → executor NUNCA é chamado (comportamento atual intacto)', async () => {
        const { svc, blockBreakSync, slotSync } = makeDeps([block(42)]);
        blockBreakSync.resolveMode.mockReturnValue('off');
        await runCycle(svc);
        expect(blockBreakSync.syncDoctorBlocks).not.toHaveBeenCalled();
        expect(slotSync.syncSlotsForDoctor).toHaveBeenCalledTimes(1); // re-sync de slots preservado
    });

    it('ativação da flag sobre snapshot estável → reconcilia TODOS os médicos com bloqueios no ciclo seguinte', async () => {
        const blocks = [block(42), block(43)];
        const { svc, blockBreakSync } = makeDeps(blocks);
        // Fase 1: flag off — dois ciclos estabilizam o snapshot sem executor
        blockBreakSync.resolveMode.mockReturnValue('off');
        await runCycle(svc);
        await runCycle(svc);
        expect(blockBreakSync.syncDoctorBlocks).not.toHaveBeenCalled();
        // Fase 2: ativa shadow — sem NENHUMA mudança de hash, o executor roda para todos
        blockBreakSync.resolveMode.mockReturnValue('shadow');
        await runCycle(svc);
        expect(blockBreakSync.syncDoctorBlocks).toHaveBeenCalledTimes(2);
        expect(new Set(blockBreakSync.syncDoctorBlocks.mock.calls.map((c: any) => c[0].idprofissional)))
            .toEqual(new Set([42, 43]));
        // Fase 3: ciclo seguinte no mesmo modo, sem mudança → executor não roda de novo
        blockBreakSync.syncDoctorBlocks.mockClear();
        await runCycle(svc);
        expect(blockBreakSync.syncDoctorBlocks).not.toHaveBeenCalled();
        // Fase 4: promoção shadow → active reconcilia de novo
        blockBreakSync.resolveMode.mockReturnValue('active');
        await runCycle(svc);
        expect(blockBreakSync.syncDoctorBlocks).toHaveBeenCalledTimes(2);
    });

    it('falha re-tentável do executor → hash não commitado → redetecção no próximo ciclo', async () => {
        const blocks = [block(42)];
        const { svc, blockBreakSync } = makeDeps(blocks);
        blockBreakSync.syncDoctorBlocks.mockResolvedValueOnce({
            ok: false, mode: 'active', planned: { create: 1, move: 0, delete: 0 },
            executed: { create: 0, move: 0, delete: 0 }, failures: 1, skippedUnrecoverable: 0,
        });
        await runCycle(svc); // ciclo 1: executor falha → rollback do hash
        blockBreakSync.syncDoctorBlocks.mockClear();
        await runCycle(svc); // ciclo 2: mesmos blocos, mas hash pendente → re-executa
        expect(blockBreakSync.syncDoctorBlocks).toHaveBeenCalledTimes(1);
    });
});
