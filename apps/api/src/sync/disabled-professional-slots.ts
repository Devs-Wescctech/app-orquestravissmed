import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { managedClearPayload, managedSlotState, SlotScope } from './managed-slot-ranges';

/** Only owned availability is removed. No booking or calendar-break API is used. */
export class DisabledProfessionalSlots {
    constructor(private readonly prisma: PrismaService) {}

    async clear(clinicId: string, localDoctorId: string, facilityId: string, doctorId: string,
        client: any, stillExcluded: () => Promise<boolean>, now = new Date()) {
        const states = await this.prisma.slotPushState.findMany({ where: { doctoraliaDoctorId: doctorId } });
        let cleared = 0;
        let pending = 0;
        for (const state of states) {
            const scope: SlotScope = { clinicId, facilityId, doctorId, addressId: state.addressId };
            const raw: any = state.managedState;
            if (raw?.ranges?.length === 0 && raw.clinicId === clinicId && raw.facilityId === facilityId
                && raw.doctorId === doctorId && raw.addressId === state.addressId) continue;
            const dates = Array.isArray(raw?.ranges) ? raw.ranges.flatMap(r => [r?.start?.slice?.(0, 10), r?.end?.slice?.(0, 10)]).filter(Boolean) : [];
            const payload = managedClearPayload(raw, state.availabilityHash, scope, dates);
            if (!payload) { pending++; continue; }
            // Preserve all past time; trim today's ongoing interval without broadening its bounds.
            const nowBrt = new Date(now.getTime() - 3 * 3600_000).toISOString().slice(0, 19) + '-03:00';
            payload.slots = payload.slots.filter(s => Date.parse(s.end) > now.getTime()).map(s => ({
                ...s, start: Date.parse(s.start) < now.getTime() ? nowBrt : s.start,
            }));
            if (!payload.slots.length) continue;
            const current = await this.prisma.mapping.findFirst({ where: { clinicId, entityType: 'DOCTOR',
                vismedId: localDoctorId, externalId: doctorId, status: 'LINKED' } });
            const shared = await this.prisma.mapping.findMany({ where: { entityType: 'DOCTOR', externalId: doctorId,
                status: 'LINKED', OR: [{ clinicId: { not: clinicId } }, { vismedId: { not: localDoctorId } }] }, select: { id: true } });
            if (!current || shared.length || !await stillExcluded()) { pending++; continue; }
            try {
                await client.replaceSlots(facilityId, doctorId, state.addressId, payload);
                const hash = createHash('sha256').update('[]').digest('hex');
                // Keep the old evidence after any failed/uncertain HTTP call for the next cycle.
                await this.prisma.slotPushState.upsert({
                    where: { doctoraliaDoctorId_addressId: { doctoraliaDoctorId: doctorId, addressId: state.addressId } },
                    create: { doctoraliaDoctorId: doctorId, addressId: state.addressId, availabilityHash: hash, managedState: managedSlotState(scope, hash, []) },
                    update: { availabilityHash: hash, managedState: managedSlotState(scope, hash, []), lastSyncedAt: new Date() },
                });
                cleared++;
            } catch { pending++; }
        }
        return { cleared, pending };
    }
}
