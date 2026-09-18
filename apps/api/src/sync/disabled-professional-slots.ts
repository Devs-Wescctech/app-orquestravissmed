import { PrismaService } from '../prisma/prisma.service';

export const UNSAFE_SLOT_CLEANUP_MESSAGE =
  'Limpeza automática suspensa: o PUT da Doctoralia pode remover outros horários. Disponibilidade e evidência preservadas; remoção restrita pendente de solução validada.';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read-only pending assessment. Deliberately has no Doctoralia client capability. */
export class DisabledProfessionalSlots {
  constructor(private readonly prisma: PrismaService) {}

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
