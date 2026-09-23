'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessLocal, assessSource, needsRecovery } = require('./legacy-appointment-type-policy.cjs');

const now = new Date('2026-09-23T12:00:00Z');
const cutoff = new Date('2026-09-18T00:00:00Z');
const record = {
  id: 'booking-1', origin: 'VISMED', clinicId: 'clinic-1', status: 'BOOKED',
  vismedAppointmentId: '123', createdAt: new Date('2026-09-17T12:00:00Z'),
  startAt: new Date('2026-09-25T12:00:00Z'), endAt: new Date('2026-09-25T12:30:00Z'),
  rawPayload: { idpacienteagendamento: 123, idprofissional: 456, originalField: 'retained' },
};
const source = {
  idpacienteagendamento: 123, idprofissional: 456,
  dataagendamento: '2026-09-25', horarioagendamento: '09:00',
  tipo_servico: 'Consulta', mostrarnadoctoralia: '1', cancelado: '0',
};

test('classifies a matching legacy consultation while preserving old payload fields', () => {
  assert.equal(assessLocal(record, now, cutoff), null);
  const result = assessSource(record, [source]);
  assert.equal(result.reason, null);
  assert.equal(result.type, 'Consulta');
  assert.equal(result.flag, '1');
  assert.deepEqual(result.payload, { ...record.rawPayload, tipo_servico: 'Consulta', mostrarnadoctoralia: '1' });
});

test('classifies an exam but does not invent a missing professional flag', () => {
  const { mostrarnadoctoralia, ...exam } = { ...source, tipo_servico: 'Exame' };
  const result = assessSource(record, [exam]);
  assert.equal(result.reason, null);
  assert.equal(result.type, 'Exame');
  assert.equal(Object.hasOwn(result.payload, 'mostrarnadoctoralia'), false);
});

test('holds stale, incomplete or ambiguous local records', () => {
  assert.equal(assessLocal({ ...record, rawPayload: { ...record.rawPayload, tipo_servico: 'Consulta' } }, now, cutoff), 'already_classified');
  assert.equal(assessLocal({ ...record, rawPayload: null }, now, cutoff), 'invalid_local_payload');
  assert.equal(assessLocal({ ...record, createdAt: cutoff }, now, cutoff), 'not_legacy_vismed');
  assert.equal(assessLocal({ ...record, endAt: now }, now, cutoff), 'not_active_future');
  assert.equal(assessLocal({ ...record, endAt: now }, now, cutoff, true), null);
});

test('requires exact source identity, professional and start time', () => {
  assert.equal(assessSource(record, [] ).reason, 'invalid_source_response');
  assert.equal(assessSource(record, [{ ...source, idpacienteagendamento: 999 }]).reason, 'source_id_mismatch');
  assert.equal(assessSource(record, [{ ...source, idprofissional: 999 }]).reason, 'source_doctor_mismatch');
  assert.equal(assessSource(record, [{ ...source, horarioagendamento: '10:00' }]).reason, 'source_time_mismatch');
  assert.equal(assessSource(record, [{ ...source, horarioagendamento: 'bad' }]).reason, 'invalid_source_time');
  assert.equal(assessSource(record, [{ ...source, horarioagendamentofinal: '09:45' }]).reason, 'source_end_time_mismatch');
  assert.equal(assessSource(record, [{ ...source, horarioagendamentofinal: 'bad' }]).reason, 'invalid_source_end_time');
});

test('holds cancelled active records and consultations without current enablement', () => {
  assert.equal(assessSource(record, [{ ...source, cancelado: '1' }]).reason, 'active_record_cancelled_at_source');
  assert.equal(assessSource(record, [{ ...source, mostrarnadoctoralia: undefined }]).reason, 'unknown_professional_flag');
  const result = assessSource(record, [{ ...source, mostrarnadoctoralia: '0' }]);
  assert.equal(result.reason, null);
  assert.equal(result.flag, '0');
  assert.equal(needsRecovery(record, 'Consulta', '0', now), false);
  assert.equal(needsRecovery(record, 'Consulta', '1', now), true);
  assert.equal(needsRecovery({ ...record, doctoraliaBreakId: 'break-1' }, 'Consulta', '1', now), false);
});
