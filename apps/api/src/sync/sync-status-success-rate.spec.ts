/**
 * Regressão — successRate ("Saúde de Sincronismo") do endpoint GET /sync/:clinicId/status.
 *
 * Runs com status 'skipped' (ex.: ClinicConcurrencyGuard rejeitou sync global) são
 * comportamento esperado, não erro: devem ficar FORA do denominador do successRate.
 * completed = sucesso, failed = falha; skipped não reduz o percentual.
 */
import { SyncController } from './sync.controller';

const CLINIC = 'clinic-A';
const SUPER_ADMIN_REQ = { user: { roles: [{ role: 'SUPER_ADMIN' }] } };

function run(status: string, extra: any = {}) {
    return {
        id: `run-${Math.random().toString(36).slice(2, 8)}`,
        type: 'full',
        status,
        startedAt: new Date('2026-08-10T10:00:00Z'),
        endedAt: status === 'running' ? null : new Date('2026-08-10T10:05:00Z'),
        totalRecords: 10,
        metrics: null,
        events: [],
        ...extra,
    };
}

function makeController(historyRuns: any[]) {
    const prisma = {
        syncRun: {
            // 1ª chamada: lastRuns (take 5, include events); 2ª: allHistoryRuns (take 10)
            findMany: jest.fn()
                .mockResolvedValueOnce(historyRuns.slice(0, 5))
                .mockResolvedValueOnce(historyRuns.slice(0, 10)),
            findFirst: jest.fn().mockResolvedValue(null),
        },
        mapping: { findMany: jest.fn().mockResolvedValue([]) },
        professionalUnifiedMapping: { count: jest.fn().mockResolvedValue(0) },
        vismedUnit: { count: jest.fn().mockResolvedValue(0) },
        vismedDoctor: { count: jest.fn().mockResolvedValue(0) },
        vismedSpecialty: { count: jest.fn().mockResolvedValue(0) },
        vismedInsurance: { count: jest.fn().mockResolvedValue(0) },
        integrationConnection: { findFirst: jest.fn().mockResolvedValue(null) },
        syncEvent: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const controller = new SyncController(
        {} as any, prisma, {} as any, {} as any, {} as any, {} as any,
    );
    return controller;
}

describe('successRate exclui runs skipped do denominador', () => {
    it('skipped intercalados não reduzem o percentual (3 completed + 2 skipped = 100%)', async () => {
        const controller = makeController([
            run('completed'), run('skipped'), run('completed'), run('skipped'), run('completed'),
        ]);
        const res = await controller.getSyncStatus(CLINIC, SUPER_ADMIN_REQ);
        expect(res.successRate).toBe(100);
    });

    it('failed continua contando como falha (2 completed + 2 failed + 2 skipped = 50%)', async () => {
        const controller = makeController([
            run('completed'), run('failed'), run('skipped'),
            run('completed'), run('failed'), run('skipped'),
        ]);
        const res = await controller.getSyncStatus(CLINIC, SUPER_ADMIN_REQ);
        expect(res.successRate).toBe(50);
    });

    it('somente skipped → 0% sem divisão por zero', async () => {
        const controller = makeController([run('skipped'), run('skipped')]);
        const res = await controller.getSyncStatus(CLINIC, SUPER_ADMIN_REQ);
        expect(res.successRate).toBe(0);
    });

    it('running não conta como sucesso mas fica no denominador (1 completed + 1 running = 50%)', async () => {
        const controller = makeController([run('running'), run('completed')]);
        const res = await controller.getSyncStatus(CLINIC, SUPER_ADMIN_REQ);
        expect(res.successRate).toBe(50);
    });
});
