import { PushSyncService } from './push-sync.service';

describe('global sync eligibility', () => {
    it.each(['excluded', 'unknown'])('does not provision an %s professional; exclusion reaches cleanup even without shifts/unit', async state => {
        const prisma: any = {
            clinic: { findUnique: jest.fn().mockResolvedValue({ id: 'clinic' }) },
            mapping: { findMany: jest.fn().mockResolvedValue([{ vismedId: 'local' }]) },
            professionalUnifiedMapping: { findMany: jest.fn().mockResolvedValue([{
                vismedDoctor: { id: 'local', vismedId: 6983, specialties: [], unit: null },
                doctoraliaDoctor: { doctoraliaFacilityId: 'f', doctoraliaDoctorId: 'd' },
            }]) },
            integrationConnection: { findFirst: jest.fn().mockResolvedValue({ clientId: '52' }) },
            syncEvent: { create: jest.fn() },
        };
        const slots: any = { generateDateRange: jest.fn().mockReturnValue([]), syncSlotsForDoctor: jest.fn().mockResolvedValue({ success: true }) };
        const availability: any = { getProfessionalEligibility: jest.fn().mockResolvedValue({ state }), buildForClinic: jest.fn() };
        const cache: any = { getOrFetch: jest.fn() };
        await new PushSyncService(prisma, slots, availability, cache).pushToDoctoralia('clinic', 'run', {} as any);
        expect(cache.getOrFetch).not.toHaveBeenCalled();
        expect(availability.buildForClinic).not.toHaveBeenCalled();
        if (state === 'excluded') expect(slots.syncSlotsForDoctor).toHaveBeenCalledWith('local', expect.anything(), 'run', 30, 'clinic');
        else expect(slots.syncSlotsForDoctor).not.toHaveBeenCalled();
    });
});
