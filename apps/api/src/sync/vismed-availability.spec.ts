import { ClinicAvailability, VismedAvailabilityService } from './vismed-availability.service';
import { Logger } from '@nestjs/common';

const date = '2026-09-15';
function fixture(response: unknown) {
    const source = { getScheduleDay: jest.fn().mockResolvedValue(response) };
    const prisma = { integrationConnection: { findFirst: jest.fn().mockResolvedValue({ clientId: '52' }) } };
    return { source, service: new VismedAvailabilityService(prisma as any, source as any) };
}
describe('availability evidence and invalid response protection', () => {
    beforeAll(() => Logger.overrideLogger(false));
    it('distinguishes an absent professional from a professional with an empty list', async () => {
        const absent = await fixture({ schedule: [] }).service.buildForCategories('clinic', [10], [date]);
        const empty = await fixture({ schedule: [{ idprofissional: 1, horarios: [] }] }).service.buildForCategories('clinic', [10], [date]);
        expect(absent!.isComplete([10], [date])).toBe(true);
        expect(absent!.describeEmpty(1, [date])).toContain('não apareceu');
        expect(empty!.describeEmpty(1, [date])).toContain('sem intervalos livres');
    });
    it.each([{}, null, { schedule: {} }, { schedule: [{ idprofissional: 1 }] },
        { schedule: [{ idprofissional: 1, horarios: [{ inicio: '012:0', fim: '13:00' }] }] },
        { schedule: [{ idprofissional: 1, horarios: [{ inicio: '13:00', fim: '12:00' }] }] },
        { schedule: [{ idprofissional: null, horarios: [] }] },
    ])('marks malformed response as incomplete instead of empty: %j', async response => {
        const snapshot = await fixture(response).service.buildForCategories('clinic', [10], [date]);
        expect(snapshot!.isComplete([10], [date])).toBe(false);
    });
    it('preserves valid ranges, inferred duration and deduplicated reads', async () => {
        const f = fixture({ schedule: [{ idprofissional: 1, horarios: [{ inicio: '08:00', fim: '08:30' }, { inicio: '08:30', fim: '09:00' }] }] });
        const snapshot = await f.service.buildForCategories('clinic', [10, 10], [date]);
        expect(f.source.getScheduleDay).toHaveBeenCalledTimes(1);
        expect(snapshot!.getRanges(1, date)).toEqual([{ start: '08:00', end: '09:00' }]);
        expect(snapshot!.getInferredStep(1)).toBe(30);
        expect(snapshot!.describeEmpty(1, [date])).toContain('nenhuma gerou horário válido');
    });
    it('keeps a failed category incomplete even if another category returned valid hours', async () => {
        const f = fixture({ schedule: [] });
        f.source.getScheduleDay.mockResolvedValueOnce({ schedule: [{ idprofissional: 1, horarios: [{ inicio: '08:00', fim: '09:00' }] }] }).mockRejectedValueOnce(new Error('network'));
        const snapshot = await f.service.buildForCategories('clinic', [10, 11], [date]);
        expect(snapshot!.isComplete([10, 11], [date])).toBe(false);
    });
    it('does not infer evidence outside the requested window', () => {
        const snapshot = new ClinicAvailability();
        snapshot.setRanges(1, '2026-09-14', []);
        expect(snapshot.describeEmpty(1, [date])).toContain('não apareceu');
    });
});
