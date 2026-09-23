'use strict';

const EXCLUDED_TYPES = new Set(['exame', 'procedimento']);
const typeOf = (raw) => String(raw?.tipo_servico || '').trim().toLowerCase();

function assessLocal(record, receipt, associationCount, overlapCount, now, cutoff) {
  if (record.origin !== 'VISMED' || !['BOOKED', 'CONFIRMED'].includes(record.status)) return 'inactive_record';
  if (!EXCLUDED_TYPES.has(typeOf(record.rawPayload))) return 'not_exam_or_procedure';
  if (!record.createdAt || record.createdAt >= cutoff) return 'not_proven_before_filter';
  if (!record.endAt || record.endAt <= now) return 'past_break';
  if (!record.vismedAppointmentId || !record.vismedDoctorId || !record.doctoraliaBreakId || !record.clinicId
    || !record.doctoraliaFacilityId || !record.doctoraliaDoctorId || !record.doctoraliaAddressId) return 'missing_scope';
  if (associationCount !== 1) return 'shared_break';
  if (overlapCount !== 0) return 'overlapping_record';
  const expected = {
    clinicId: record.clinicId,
    facilityId: record.doctoraliaFacilityId,
    doctorId: record.doctoraliaDoctorId,
    addressId: record.doctoraliaAddressId,
    breakId: record.doctoraliaBreakId,
  };
  if (receipt?.action !== 'CALENDAR_BREAK_CREATION' || receipt.entityId !== record.id
    || receipt.details?.state !== 'OWNED'
    || Object.entries(expected).some(([key, value]) => receipt.details[key] !== String(value))) return 'unproven_ownership';
  return null;
}

function assessSource(record, response) {
  if (!Array.isArray(response) || response.length !== 1) return 'invalid_source_response';
  const source = response[0];
  if (String(source?.idpacienteagendamento) !== String(record.vismedAppointmentId)) return 'source_id_mismatch';
  if (!EXCLUDED_TYPES.has(typeOf(source))) return 'source_type_changed';
  return null;
}

function assessRemote(record, remote) {
  if (String(remote?.id) !== String(record.doctoraliaBreakId)) return 'remote_id_mismatch';
  const since = Date.parse(remote?.since);
  const till = Date.parse(remote?.till);
  if (!Number.isFinite(since) || !Number.isFinite(till)
    || since !== record.startAt.getTime() || till !== record.endAt.getTime()) return 'remote_time_mismatch';
  return null;
}

function assessSlots(record, response) {
  if (!response || !Array.isArray(response._items) || response._links?.next) return 'invalid_slots_response';
  for (const slot of response._items) {
    const start = Date.parse(slot?.start);
    const end = Date.parse(slot?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return 'invalid_slot_time';
    if (start < record.endAt.getTime() && end > record.startAt.getTime()) return 'overlapping_remote_slot';
  }
  return null;
}

module.exports = { assessLocal, assessSource, assessRemote, assessSlots };
