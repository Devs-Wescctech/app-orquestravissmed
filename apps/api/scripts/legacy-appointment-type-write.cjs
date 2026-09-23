'use strict';

const { needsRecovery } = require('./legacy-appointment-type-policy.cjs');

async function persistClassification(prisma, assessment) {
  const { record, type, flag, payload } = assessment;
  const recoveryReviewNeeded = needsRecovery(record, type, flag);
  await prisma.$transaction(async (tx) => {
    const changed = await tx.bookingSync.updateMany({
      where: {
        id: record.id, clinicId: record.clinicId, origin: 'VISMED',
        vismedAppointmentId: record.vismedAppointmentId,
        status: record.status, updatedAt: record.updatedAt,
      },
      data: { rawPayload: payload },
    });
    if (changed.count !== 1) throw new Error('record_changed_during_backfill');
    await tx.auditLog.create({ data: {
      id: `legacy-type:${record.id}`, action: 'LEGACY_APPOINTMENT_TYPE_BACKFILL',
      entity: 'BookingSync', entityId: record.id,
      details: {
        source: 'vismed_get_agendamento_by_id', type, professionalDoctoraliaEnabled: flag,
        previousTypePresent: Object.prototype.hasOwnProperty.call(record.rawPayload, 'tipo_servico'),
        previousType: record.rawPayload.tipo_servico ?? null,
        previousFlagPresent: Object.prototype.hasOwnProperty.call(record.rawPayload, 'mostrarnadoctoralia'),
        previousFlag: record.rawPayload.mostrarnadoctoralia ?? null,
        recoveryReviewNeeded,
      },
    } });
  });
  return { recoveryReviewNeeded };
}

module.exports = { persistClassification };
