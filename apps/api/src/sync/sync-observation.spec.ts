import { observeSync, differentialUpsert, recordOutcome, classifySyncEvents, beginSyncStage } from './sync-observation';

function fixture(events: any[] = []) {
    const run: any = { status: 'completed', metrics: { last_active_doctors: ['1'] }, totalRecords: 13583 };
    const prisma: any = { syncRun: { findUnique: jest.fn(async () => run), update: jest.fn(async ({ data }) => Object.assign(run, data)) },
        syncEvent: { findMany: jest.fn(async () => events) } };
    return { run, prisma };
}

describe('Sync report and differential writes', () => {
    it('counts professional cleanup pending as an agenda warning', () => {
        expect(classifySyncEvents([{ entityType: 'SLOT_SYNC', action: 'professional_cleanup_pending' }]))
            .toEqual({ errors: 0, warnings: 1, agendas: { professional_cleanup_pending: 1 } });
    });
    it('counts each doctor once and keeps earlier created/updated outcome', async () => {
        const { run, prisma } = fixture();
        await observeSync(prisma, 'run', async () => {
            recordOutcome('doctors', '1', 'updated');
            recordOutcome('doctors', '1', 'unchanged');
            recordOutcome('doctors', '2', 'created');
            recordOutcome('doctors', '2', 'unchanged');
            beginSyncStage('push_to_doctoralia');
        });
        expect(run.totalRecords).toBe(2);
        expect(run.metrics.report.categories.doctors).toEqual({ verified: 2, created: 1, updated: 1, unchanged: 0, errors: 0 });
        expect(run.metrics.last_active_doctors).toEqual(['1']);
        expect(run.metrics.report.stages.map(s => s.name)).toEqual(['initializing', 'push_to_doctoralia']);
    });

    it('does not write unchanged business fields just to update syncedAt', async () => {
        const model = { findUnique: jest.fn(async () => ({ id: '1', name: 'Clinic', syncedAt: new Date(0) })), upsert: jest.fn() };
        await differentialUpsert(model, 'doctors', { where: { id: '1' }, update: { name: 'Clinic', syncedAt: new Date() }, create: {} });
        expect(model.upsert).not.toHaveBeenCalled();
    });

    it('writes actual change and counts failure instead of success', async () => {
        const { run, prisma } = fixture();
        const model = { findUnique: jest.fn(async () => ({ name: 'Old' })), upsert: jest.fn(async () => { throw new Error('write failed'); }) };
        await expect(observeSync(prisma, 'run', () => differentialUpsert(model, 'services', { where: { id: '1' }, update: { name: 'New' }, create: {} }))).rejects.toThrow('write failed');
        expect(run.metrics.report.categories.services.errors).toBe(1);
        expect(run.status).toBe('completed_with_warnings');
    });

    it.each(['error', 'fetch_error', 'regression_warning', 'plan_pending', 'managed_scope_pending', 'skipped_incomplete'])(
        'does not label a completed run as full success when it contains %s', async action => {
            const { run, prisma } = fixture([{ entityType: 'SLOT_SYNC', action }]);
            await observeSync(prisma, 'run', async () => undefined);
            expect(run.status).toBe('completed_with_warnings');
        });

    it('preserves failed/skipped state and separates unchanged slots from actual sends', async () => {
        const { run, prisma } = fixture();
        run.status = 'failed';
        await observeSync(prisma, 'run', async () => undefined);
        expect(run.status).toBe('failed');
        const summary = classifySyncEvents(['created', 'unchanged', 'error'].map(action => ({ entityType: 'SLOT_SYNC', action })));
        expect(summary.agendas).toEqual({ created: 1, unchanged: 1, error: 1 });
    });

    it('isolates concurrent clinics', async () => {
        const a = fixture(), b = fixture();
        await Promise.all([observeSync(a.prisma, 'a', async () => { recordOutcome('doctors', '1', 'created'); await Promise.resolve(); }),
            observeSync(b.prisma, 'b', async () => { recordOutcome('doctors', '1', 'unchanged'); })]);
        expect(a.run.metrics.report.categories.doctors.created).toBe(1);
        expect(b.run.metrics.report.categories.doctors.created).toBe(0);
    });
});
