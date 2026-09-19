import { PrismaService } from '../prisma/prisma.service';
import {
  periodsHash,
  object,
  validPeriods,
} from './managed-period-replacement';
import { managedSlotState } from './managed-slot-ranges';
import { CleanupIssue, CleanupReason } from './cleanup-diagnostics';
import {
  reconcileManagedRemoval,
  ReplacementClient,
} from './managed-slot-reconciler';

export const UNSAFE_SLOT_CLEANUP_MESSAGE =
  'Limpeza pendente: é necessário registro completo e leitura remota compatível, sem reservas, bloqueios ou vínculo compartilhado. Nenhuma reconstrução de horário desconhecido será enviada.';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Verified managed cleanup, with a separate read-only legacy assessment. */
export class DisabledProfessionalSlots {
  constructor(private readonly prisma: PrismaService) {}

  async reconcile(
    clinicId: string,
    localDoctorId: string,
    facilityId: string,
    doctorId: string,
    client: ReplacementClient,
    eligible: () => Promise<boolean>,
    allowedDates?: string[],
    now = new Date(),
    addressId?: string,
  ) {
    const states = await this.prisma.slotPushState.findMany({
      where: {
        doctoraliaDoctorId: doctorId,
        ...(addressId ? { addressId } : {}),
      },
    });
    let cleared = 0,
      pending = 0;
    const issues: CleanupIssue[] = [];
    const report = (addressId: string, code: CleanupReason, date?: string) => {
      pending++;
      issues.push({ addressId, code, writeState: 'not_sent', ...(date ? { date } : {}) });
    };
    for (const initial of states) {
      let state = initial;
      const raw = object(state.managedState);
      if (!Number.isFinite(now.getTime())) { report(state.addressId, 'invalid_clock'); continue; }
      if (!raw) { report(state.addressId, 'journal_missing_periods'); continue; }
      if (raw.version !== 1 || !clinicId || raw.clinicId !== clinicId || raw.facilityId !== facilityId || raw.doctorId !== doctorId || raw.addressId !== state.addressId) {
        report(state.addressId, 'journal_scope_mismatch'); continue;
      }
      if (raw.hash !== state.availabilityHash) { report(state.addressId, 'journal_hash_mismatch'); continue; }
      if (!raw || !validPeriods(raw.periods)) {
        const ranges = raw?.ranges;
        // Only well-formed, correctly scoped legacy evidence can be dismissed as past-only.
        // Preserve the journal unchanged; never infer services/durations from these ranges.
        const pastOnly = raw.periods === undefined && Array.isArray(ranges) && ranges.every(value => {
          const r = object(value);
          if (!r || typeof r.start !== 'string' || typeof r.end !== 'string') return false;
          const start = Date.parse(r.start), end = Date.parse(r.end);
          return Number.isFinite(start) && Number.isFinite(end) && end > start && end <= now.getTime();
        });
        if (!pastOnly) report(state.addressId, raw.periods === undefined ? 'journal_missing_periods' : 'journal_invalid');
        continue;
      }
      if (raw.periodsHash !== periodsHash(raw.periods)) { report(state.addressId, 'journal_hash_mismatch'); continue; }
      const dates = [
        ...new Set(
          raw.periods
            .filter((p) => Date.parse(p.start) >= now.getTime())
            .map((p) => p.start.slice(0, 10)),
        ),
      ];
      for (const date of dates) {
        if (allowedDates && !allowedDates.includes(date)) continue;
        const scope = {
          clinicId,
          facilityId,
          doctorId,
          addressId: state.addressId,
        };
        const currentPeriods = object(state.managedState)?.periods;
        if (!validPeriods(currentPeriods)) {
          report(state.addressId, 'journal_invalid', date);
          break;
        }
        const targets = currentPeriods.filter(
          (p) => p.start.slice(0, 10) === date,
        );
        const authorized = async (): Promise<boolean | CleanupReason> => {
          const current = await this.prisma.mapping.findFirst({
            where: {
              clinicId,
              entityType: 'DOCTOR',
              vismedId: localDoctorId,
              externalId: doctorId,
              status: 'LINKED',
            },
          });
          const shared = await this.prisma.mapping.findMany({
            where: {
              entityType: 'DOCTOR',
              externalId: doctorId,
              status: 'LINKED',
              OR: [
                { clinicId: { not: clinicId } },
                { vismedId: { not: localDoctorId } },
              ],
            },
            select: { id: true },
          });
          const saved = await this.prisma.slotPushState.findUnique({
            where: { id: state.id },
          });
          if (!current) return 'mapping_missing';
          if (shared.length) return 'mapping_shared';
          if (saved?.availabilityHash !== state.availabilityHash) return 'journal_changed';
          if (!(await eligible())) return 'eligibility_changed';
          return true;
        };
        const ok = await reconcileManagedRemoval({
          state: state.managedState,
          hash: state.availabilityHash,
          scope,
          targets,
          client,
          authorized,
          now,
          onPending: diagnostic => issues.push({ addressId: state.addressId, date, ...diagnostic }),
          persist: async (remaining) => {
            const availabilityHash = periodsHash(remaining);
            const managedState = managedSlotState(
              scope,
              availabilityHash,
              remaining,
            );
            const updated = await this.prisma.slotPushState.updateMany({
              where: { id: state.id, availabilityHash: state.availabilityHash },
              data: {
                availabilityHash,
                managedState,
                lastSyncedAt: new Date(),
              },
            });
            if (updated.count !== 1)
              throw new Error('Managed availability changed concurrently');
            state = { ...state, availabilityHash, managedState };
          },
        });
        if (ok) cleared++;
        else pending++;
      }
      if (
        raw.periods.some(
          (p) =>
            Date.parse(p.start) < now.getTime() &&
            Date.parse(p.end) > now.getTime(),
        )
      )
        report(state.addressId, 'period_in_progress');
    }
    return { cleared, pending, issues };
  }

  async assess(
    clinicId: string,
    facilityId: string,
    doctorId: string,
    now = new Date(),
  ): Promise<{ cleared: number; pending: number }> {
    const states = await this.prisma.slotPushState.findMany({
      where: { doctoraliaDoctorId: doctorId },
    });
    let pending = 0;
    for (const state of states) {
      const raw = record(state.managedState);
      if (
        !clinicId ||
        !Number.isFinite(now.getTime()) ||
        !raw ||
        raw.version !== 1 ||
        raw.hash !== state.availabilityHash ||
        raw.clinicId !== clinicId ||
        raw.facilityId !== facilityId ||
        raw.doctorId !== doctorId ||
        raw.addressId !== state.addressId ||
        !Array.isArray(raw.ranges)
      ) {
        pending++;
        continue;
      }
      const ranges: unknown[] = raw.ranges;
      const needsAttention = ranges.some((value) => {
        const range = record(value);
        if (
          !range ||
          typeof range.start !== 'string' ||
          typeof range.end !== 'string'
        )
          return true;
        const start = Date.parse(range.start);
        const end = Date.parse(range.end);
        return (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          end <= start ||
          end > now.getTime()
        );
      });
      if (needsAttention) pending++;
    }
    return { cleared: 0, pending };
  }
}
