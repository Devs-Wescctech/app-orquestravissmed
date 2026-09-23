'use strict';

const TYPE_LABELS = Object.freeze({ consulta: 'Consulta', exame: 'Exame', procedimento: 'Procedimento' });
const typeOf = (payload) => {
  const value = typeof payload?.tipo_servico === 'string' ? payload.tipo_servico.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(TYPE_LABELS, value) ? TYPE_LABELS[value] : null;
};
const flagOf = (value) => value === '1' || value === 1 || value === true ? '1'
  : value === '0' || value === 0 || value === false ? '0' : null;

function assessLocal(record, now, cutoff, includePast = false) {
  if (!record || record.origin !== 'VISMED' || !record.createdAt || record.createdAt >= cutoff) return 'not_legacy_vismed';
  if (typeOf(record.rawPayload)) return 'already_classified';
  if (!record.rawPayload || typeof record.rawPayload !== 'object' || Array.isArray(record.rawPayload)) return 'invalid_local_payload';
  if (!record.vismedAppointmentId || !record.clinicId) return 'missing_source_identity';
  if (!includePast && (!['BOOKED', 'CONFIRMED'].includes(record.status) || !record.endAt || record.endAt <= now)) return 'not_active_future';
  return null;
}

function assessSource(record, response) {
  if (!Array.isArray(response) || response.length !== 1 || !response[0] || typeof response[0] !== 'object') {
    return { reason: 'invalid_source_response' };
  }
  const source = response[0];
  const id = String(record.vismedAppointmentId);
  if (String(source.idpacienteagendamento) !== id
    || (record.rawPayload.idpacienteagendamento != null && String(record.rawPayload.idpacienteagendamento) !== id)) {
    return { reason: 'source_id_mismatch' };
  }
  const type = typeOf(source);
  if (!type) return { reason: 'unknown_source_type' };
  const doctor = record.rawPayload.idprofissional;
  if (doctor == null || String(doctor) !== String(source.idprofissional)) return { reason: 'source_doctor_mismatch' };
  const date = source.dataagendamento;
  const time = source.horarioagendamento;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || typeof time !== 'string' || !/^\d{2}:\d{2}(?::\d{2})?$/.test(time)) return { reason: 'invalid_source_time' };
  const start = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}-03:00`);
  if (!Number.isFinite(start) || start !== record.startAt.getTime()) return { reason: 'source_time_mismatch' };
  const endTime = source.horarioagendamentofinal;
  if (endTime != null && endTime !== '') {
    if (typeof endTime !== 'string' || !/^\d{2}:\d{2}(?::\d{2})?$/.test(endTime)) return { reason: 'invalid_source_end_time' };
    const end = Date.parse(`${date}T${endTime.length === 5 ? `${endTime}:00` : endTime}-03:00`);
    if (!Number.isFinite(end) || end !== record.endAt.getTime()) return { reason: 'source_end_time_mismatch' };
  }
  if (['BOOKED', 'CONFIRMED'].includes(record.status) && [true, 1, '1'].includes(source.cancelado)) {
    return { reason: 'active_record_cancelled_at_source' };
  }
  const flag = flagOf(source.mostrarnadoctoralia);
  if (type === 'Consulta' && flag === null) return { reason: 'unknown_professional_flag' };
  const payload = { ...record.rawPayload, tipo_servico: type };
  if (flag !== null) payload.mostrarnadoctoralia = flag;
  return { reason: null, type, flag, payload };
}

function needsRecovery(record, type, flag, now = new Date()) {
  return type === 'Consulta' && flag === '1'
    && !record.doctoraliaBreakId && !record.doctoraliaBookingId
    && ['BOOKED', 'CONFIRMED'].includes(record.status) && record.endAt > now;
}

module.exports = { assessLocal, assessSource, needsRecovery, typeOf };
