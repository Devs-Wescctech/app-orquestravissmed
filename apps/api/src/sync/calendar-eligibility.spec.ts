import { SyncController } from './sync.controller';
import { SlotSyncService } from './slot-sync.service';

describe('manual calendar eligibility', () => {
    it('allows activation after a fresh eligible result and denies an absent mapping', async () => {
        const prisma: any = { mapping: { findFirst: jest.fn().mockResolvedValue({ status: 'LINKED', vismedId: 'local' }) },
            vismedDoctor: { findUnique: jest.fn().mockResolvedValue({ vismedId: 6983 }) } };
        const eligibility = jest.fn().mockResolvedValue({ state: 'enabled' });
        const slots = new SlotSyncService(prisma, { getProfessionalEligibility: eligibility } as any, {} as any);
        await expect(slots.assertCalendarEligibility('clinic', 'doctor')).resolves.toBeUndefined();
        prisma.mapping.findFirst.mockResolvedValue(null);
        await expect(slots.assertCalendarEligibility('clinic', 'doctor')).rejects.toThrow('Habilitação');
        expect(eligibility).toHaveBeenCalledTimes(1);
    });
    it.each(['excluded', 'unknown'])('checks eligibility before any provider access (%s)', async state => {
        const prisma: any = {
            mapping: { findFirst: jest.fn().mockResolvedValue({ status: 'LINKED', vismedId: 'local' }) },
            vismedDoctor: { findUnique: jest.fn().mockResolvedValue({ vismedId: 6983 }) },
        };
        const eligibility = jest.fn().mockResolvedValue({ state });
        const slots = new SlotSyncService(prisma, { getProfessionalEligibility: eligibility } as any, {} as any);
        const controller: any = new SyncController({} as any, prisma, {} as any, slots, {} as any, {} as any);
        jest.spyOn(controller, 'validateDoctoraliaDoctorBelongsToClinic').mockResolvedValue({});
        const provider = jest.spyOn(controller, 'getDoctoraliaClient').mockRejectedValue(new Error('must not access provider'));
        await expect(controller.enableCalendar('clinic', 'doctor', { user: { roles: [{ role: 'SUPER_ADMIN' }] } })).rejects.toThrow('Habilitação');
        expect(eligibility).toHaveBeenCalledWith('clinic', 6983);
        expect(provider).not.toHaveBeenCalled();
    });
});
