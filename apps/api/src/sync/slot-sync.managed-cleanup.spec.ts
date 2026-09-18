import { SlotSyncService } from './slot-sync.service';
import { managedSlotState } from './managed-slot-ranges';
import { Logger } from '@nestjs/common';
import { ClinicAvailability } from './vismed-availability.service';

const scope = { clinicId: 'clinic-a', facilityId: 'f', doctorId: 'd', addressId: 'a' };
const date = '2026-09-12';
const ranges = [{ start: `${date}T08:00:00-03:00`, end: `${date}T12:00:00-03:00` }];
function fixture() {
    let state: any = { availabilityHash: 'prior-hash', managedState: managedSlotState(scope, 'prior-hash', ranges) };
    const events: any[] = [];
    const prisma: any = {
        vismedDoctor: { findUnique: jest.fn(async () => ({ id: 'v', vismedId: 1, name: 'Fixture',
            specialties: [{ specialty: { idEmpresaGestora: 52, vismedId: 10, mappings: [] } }],
            unifiedMappings: [{ doctoraliaDoctor: { doctoraliaDoctorId: 'd', doctoraliaFacilityId: 'f' } }],
        })) },
        mapping: { findFirst: jest.fn(async () => ({ status: 'LINKED', externalId: 'd' })), findMany: jest.fn(async () => []) },
        integrationConnection: { findFirst: jest.fn(async () => ({ clientId: '52' })) },
        syncEvent: { create: jest.fn(async ({ data }) => { events.push(data); return data; }) },
        slotPushState: { findUnique: jest.fn(async () => state), upsert: jest.fn(async ({ update }) => { state = update; return state; }) },
    };
    const client: any = { getCacheIdentity: () => 'www.doctoralia.com.br|fixture', getAddresses: jest.fn(async () => ({ _items: [{ id: 'a' }] })),
        getServices: jest.fn(async () => ({ _items: [{ id: '5', service_id: '291' }] })), replaceSlots: jest.fn(async () => ({ _status: 201 })),
        enableCalendar: jest.fn(), getAddressInsuranceProviders: jest.fn(async () => ({ _items: [] })) };
    const cache: any = { getOrFetch: async (_key, _ttl, fetch) => fetch() };
    const eligibility = jest.fn().mockResolvedValue({ state: 'enabled' });
    const service = new SlotSyncService(prisma, { getProfessionalEligibility: eligibility } as any, cache);
    jest.spyOn(service, 'generateDateRange').mockReturnValue([date]);
    const availability: any = { isComplete: jest.fn(() => true), getRanges: jest.fn(() => []), getInferredStep: () => 30 };
    return { service, prisma, client, availability, eligibility, events, getState: () => state, setState: (s: any) => { state = s; } };
}
describe('slot cleanup integration', () => {
    beforeAll(() => Logger.overrideLogger(false));
    it('preserves existing availability if eligibility becomes unknown before empty-source cleanup', async () => {
        const f = fixture(); f.eligibility.mockResolvedValueOnce({ state: 'enabled' }).mockResolvedValue({ state: 'unknown' });
        await f.service.syncSlotsForDoctor('v', f.client, 'run', 30, 'clinic-a', f.availability);
        expect(f.client.replaceSlots).not.toHaveBeenCalled();
        expect(f.prisma.slotPushState.upsert).not.toHaveBeenCalled();
    });
    it('does not publish scheduleDay ranges when current eligibility is unknown', async () => {
        const f = fixture(); f.eligibility.mockResolvedValue({ state: 'unknown' });
        f.availability.getRanges.mockReturnValue([{ start: '08:00', end: '12:00' }]);
        await f.service.syncSlotsForDoctor('v', f.client, 'run', 30, 'clinic-a', f.availability);
        expect(f.client.replaceSlots).not.toHaveBeenCalled();
        expect(f.client.getServices).not.toHaveBeenCalled();
        expect(f.events.some(e => e.action === 'professional_eligibility_unknown')).toBe(true);
    });
    it('does not activate or publish when eligibility changes during schedule calculation', async () => {
        const f = fixture(); f.eligibility.mockResolvedValueOnce({ state: 'enabled' }).mockResolvedValue({ state: 'excluded' });
        f.availability.getRanges.mockReturnValue([{ start: '08:00', end: '12:00' }]);
        await f.service.syncSlotsForDoctor('v', f.client, 'run', 30, 'clinic-a', f.availability);
        expect(f.client.enableCalendar).not.toHaveBeenCalled();
        expect(f.client.replaceSlots).not.toHaveBeenCalled();
    });
    it('exclusion removes owned future availability even if scheduleDay still returns it', async () => {
        const f = fixture(); f.eligibility.mockResolvedValue({ state: 'excluded' });
        const future = [{ start: '2030-01-02T08:00:00-03:00', end: '2030-01-02T12:00:00-03:00' }];
        f.setState({ addressId: 'a', availabilityHash: 'prior-hash', managedState: managedSlotState(scope, 'prior-hash', future) });
        f.prisma.slotPushState.findMany = jest.fn(async () => [f.getState()]);
        f.prisma.mapping.findMany.mockResolvedValue([]);
        f.availability.getRanges.mockReturnValue([{ start: '08:00', end: '12:00' }]);
        await f.service.syncSlotsForDoctor('v', f.client, 'run', 30, 'clinic-a', f.availability);
        expect(f.client.replaceSlots).toHaveBeenCalledWith('f', 'd', 'a', { slots: [{ ...future[0], address_services: [] }] });
        expect(f.client.enableCalendar).not.toHaveBeenCalled();
        expect(f.client.getServices).not.toHaveBeenCalled();
    });
    it('reports the empty source and period without writing or deleting an unmanaged calendar', async () => {
        const f = fixture(); f.setState(null);
        const availability = new ClinicAvailability();
        await f.service.syncSlotsForDoctor('v', f.client, 'run', 30, 'clinic-a', availability);
        expect(f.client.replaceSlots).not.toHaveBeenCalled();
        expect(f.prisma.slotPushState.upsert).not.toHaveBeenCalled();
        const event = f.events.find(e => e.action === 'skipped_empty');
        expect(event.message).toContain(date);
        expect(event.message).toContain('não apareceu');
        expect(event.message).toContain('Nenhum horário enviado ou removido');
    });
    it('clears exact managed periods only after a complete source snapshot and persists after success', async () => {
        const f = fixture();
        const result = await f.service.syncSlotsForDoctor('v', f.client, 'run', 30, 'clinic-a', f.availability);
        expect(result.success).toBe(true);
        expect(f.client.replaceSlots).toHaveBeenCalledWith('f', 'd', 'a', { slots: [{ ...ranges[0], address_services: [] }] });
        expect(f.getState().managedState.ranges).toEqual([]);
        expect(f.events.some(e => e.action === 'cleared')).toBe(true);
    });
    it('does not advance hash after API rejection, so a later cycle can retry', async () => {
        const f = fixture(); f.client.replaceSlots.mockRejectedValue(new Error('API error'));
        const result = await f.service.syncSlotsForDoctor('v', f.client, 'run', 30, 'clinic-a', f.availability);
        expect(result.success).toBe(false);
        expect(f.getState().availabilityHash).toBe('prior-hash');
        expect(f.prisma.slotPushState.upsert).not.toHaveBeenCalled();
    });
    it('does not clear a legacy hash with no interval evidence', async () => {
        const f = fixture(); f.setState({ availabilityHash: 'legacy' });
        await f.service.syncSlotsForDoctor('v', f.client, 'run', 30, 'clinic-a', f.availability);
        expect(f.client.replaceSlots).not.toHaveBeenCalled();
        expect(f.events.some(e => e.action === 'managed_scope_pending')).toBe(true);
    });
    it('does not treat source failure as an empty calendar', async () => {
        const f = fixture(); f.availability.isComplete.mockReturnValue(false);
        await f.service.syncSlotsForDoctor('v', f.client, 'run', 30, 'clinic-a', f.availability);
        expect(f.client.replaceSlots).not.toHaveBeenCalled();
        expect(f.events.some(e => e.action === 'skipped_incomplete')).toBe(true);
    });
    it.each([{ status: 'UNLINKED', externalId: 'd' }, { status: 'LINKED', externalId: 'different-doctor' }])(
        'does not clear when the current clinic mapping no longer authorizes the doctor: %j', async mapping => {
            const f = fixture(); f.prisma.mapping.findFirst.mockResolvedValue(mapping);
            await f.service.syncSlotsForDoctor('v', f.client, 'run', 30, 'clinic-a', f.availability);
            expect(f.client.replaceSlots).not.toHaveBeenCalled();
            expect(f.prisma.slotPushState.upsert).not.toHaveBeenCalled();
            expect(f.events.some(e => e.action === 'managed_scope_pending')).toBe(true);
        });
    it('uses configured address plans when publishing new availability', async () => {
        const f = fixture(); f.setState(null);
        f.prisma.mapping.findMany.mockResolvedValue([{ externalId: '7' }]);
        f.client.getAddressInsuranceProviders.mockResolvedValue({ _items: [{ insurance_provider_id: '7', insurance_plans: { _items: [{ insurance_plan_id: '72' }] } }] });
        f.availability.getRanges.mockReturnValue([{ start: '08:00', end: '12:00' }]);
        // Isolate the service's choice of address plans from date conversion.
        jest.spyOn(f.service, 'buildDaySlotsFromRanges').mockImplementation((_date, _ranges, _services, _tz, _duration, providers, plans) =>
            [{ ...ranges[0], address_services: [{ address_service_id: 5, duration: 30 }], insurance_providers: providers, insurance_plans: plans }]);
        await f.service.syncSlotsForDoctor('v', f.client, 'run', 30, 'clinic-a', f.availability);
        expect(f.client.replaceSlots.mock.calls[0][3].slots[0].insurance_plans).toEqual([72]);
        expect(f.getState().managedState.clinicId).toBe('clinic-a');
    });
});
