import { SyncController } from './sync.controller';
import { SlotSyncService } from './slot-sync.service';

describe('manual calendar eligibility', () => {
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
