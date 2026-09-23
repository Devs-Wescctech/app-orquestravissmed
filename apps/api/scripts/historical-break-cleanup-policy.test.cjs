'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessLocal, assessSource, assessRemote } = require('./historical-break-cleanup-policy.cjs');

const now = new Date('2026-09-23T12:00:00Z');
const cutoff = new Date('2026-09-18T00:00:00Z');
const record = {
  id: 'booking-1', origin: 'VISMED', status: 'BOOKED',
  createdAt: new Date('2026-09-17T12:00:00Z'),
  startAt: new Date('2026-09-25T12:00:00Z'), endAt: new Date('2026-09-25T13:00:00Z'),
  clinicId: 'clinic-1', vismedAppointmentId: 'vismed-1', doctoraliaBreakId: 'break-1',
  doctoraliaFacilityId: 'facility-1', doctoraliaDoctorId: 'doctor-1', doctoraliaAddressId: 'address-1',
  rawPayload: { tipo_servico: 'Exame' },
};
const receipt = { action: 'CALENDAR_BREAK_CREATION', entityId: 'booking-1', details: {
  state: 'OWNED', clinicId: 'clinic-1', facilityId: 'facility-1', doctorId: 'doctor-1',
  addressId: 'address-1', breakId: 'break-1',
} };

test('accepts only an owned, exclusive, future historical exam break', () => {
  assert.equal(assessLocal(record, receipt, 1, 0, now, cutoff), null);
  assert.equal(assessLocal({ ...record, rawPayload: { tipo_servico: 'Procedimento' } }, receipt, 1, 0, now, cutoff), null);
});

test('preserves ambiguous, changed, shared and overlapping records', () => {
  assert.equal(assessLocal(record, null, 1, 0, now, cutoff), 'unproven_ownership');
  assert.equal(assessLocal(record, receipt, 2, 0, now, cutoff), 'shared_break');
  assert.equal(assessLocal(record, receipt, 1, 1, now, cutoff), 'overlapping_record');
  assert.equal(assessLocal({ ...record, rawPayload: { tipo_servico: 'Consulta' } }, receipt, 1, 0, now, cutoff), 'not_exam_or_procedure');
  assert.equal(assessLocal({ ...record, createdAt: cutoff }, receipt, 1, 0, now, cutoff), 'not_proven_before_filter');
  assert.equal(assessLocal({ ...record, endAt: now }, receipt, 1, 0, now, cutoff), 'past_break');
  assert.equal(assessLocal(record, { ...receipt, details: { ...receipt.details, doctorId: 'other' } }, 1, 0, now, cutoff), 'unproven_ownership');
});

test('requires fresh Vissmed identity and excluded type', () => {
  assert.equal(assessSource(record, [{ idpacienteagendamento: 'vismed-1', tipo_servico: 'Exame' }]), null);
  assert.equal(assessSource(record, [{ idpacienteagendamento: 'vismed-1', tipo_servico: 'Consulta' }]), 'source_type_changed');
  assert.equal(assessSource(record, [{ idpacienteagendamento: 'other', tipo_servico: 'Exame' }]), 'source_id_mismatch');
  assert.equal(assessSource(record, []), 'invalid_source_response');
});

test('requires exact remote break ID and times', () => {
  const remote = { id: 'break-1', since: '2026-09-25T09:00:00-03:00', till: '2026-09-25T10:00:00-03:00' };
  assert.equal(assessRemote(record, remote), null);
  assert.equal(assessRemote(record, { ...remote, id: 'other' }), 'remote_id_mismatch');
  assert.equal(assessRemote(record, { ...remote, till: '2026-09-25T10:30:00-03:00' }), 'remote_time_mismatch');
  assert.equal(assessRemote(record, {}), 'remote_id_mismatch');
});
