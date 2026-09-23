'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { persistClassification } = require('./legacy-appointment-type-write.cjs');

const record = {
  id: 'booking-1', clinicId: 'clinic-1', vismedAppointmentId: '123', status: 'BOOKED',
  updatedAt: new Date('2026-09-23T12:00:00Z'), endAt: new Date('2100-09-25T12:30:00Z'),
  rawPayload: { idpacienteagendamento: 123, idprofissional: 456 },
  doctoraliaBreakId: null, doctoraliaBookingId: null,
};
const assessment = { record, type: 'Consulta', flag: '1',
  payload: { ...record.rawPayload, tipo_servico: 'Consulta', mostrarnadoctoralia: '1' } };

test('writes only classified payload and a receipt in the same transaction', async () => {
  const calls = [];
  const tx = {
    bookingSync: { updateMany: async (arg) => { calls.push(['update', arg]); return { count: 1 }; } },
    auditLog: { create: async (arg) => { calls.push(['audit', arg]); } },
  };
  const prisma = { $transaction: async (fn) => fn(tx) };
  assert.deepEqual(await persistClassification(prisma, assessment), { recoveryReviewNeeded: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][1].data, { rawPayload: assessment.payload });
  assert.deepEqual(calls[0][1].where, {
    id: record.id, clinicId: record.clinicId, origin: 'VISMED',
    vismedAppointmentId: record.vismedAppointmentId,
    status: record.status, updatedAt: record.updatedAt,
  });
  assert.equal(calls[1][1].data.id, 'legacy-type:booking-1');
  assert.equal(calls[1][1].data.details.recoveryReviewNeeded, true);
});

test('does not create an audit receipt when the snapshot changed', async () => {
  let audited = false;
  const prisma = { $transaction: async (fn) => fn({
    bookingSync: { updateMany: async () => ({ count: 0 }) },
    auditLog: { create: async () => { audited = true; } },
  }) };
  await assert.rejects(() => persistClassification(prisma, assessment), /record_changed_during_backfill/);
  assert.equal(audited, false);
});
