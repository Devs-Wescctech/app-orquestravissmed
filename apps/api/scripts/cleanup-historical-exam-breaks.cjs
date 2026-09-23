#!/usr/bin/env node
'use strict';

// Run only in the Orquestrador API environment. Dry-run by default.
// No patient fields or credentials are printed.
const { PrismaClient } = require('@prisma/client');
const { VismedService } = require('../dist/integrations/vismed/vismed.service');
const { assessLocal, assessSource, assessRemote, assessSlots } = require('./historical-break-cleanup-policy.cjs');

const FILTER_CUTOFF = new Date('2026-09-18T00:00:00Z'); // conservative: excludes deployment day
const prisma = new PrismaClient();
const vismed = new VismedService();
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const idsArg = args.find((arg) => arg.startsWith('--ids='));
if (args.some((arg) => arg !== '--apply' && !arg.startsWith('--ids=')) || (apply && !idsArg)) {
  console.error('Usage: node cleanup-historical-exam-breaks.cjs [--apply --ids=BOOKING_UUID,BOOKING_UUID]');
  process.exit(2);
}
const ids = idsArg ? [...new Set(idsArg.slice('--ids='.length).split(',').map((id) => id.trim()).filter(Boolean))] : [];
if (apply && (!ids.length || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id)))) {
  console.error('Apply requires explicit BookingSync UUIDs from a reviewed dry-run.');
  process.exit(2);
}

async function localSnapshot(id) {
  const record = await prisma.bookingSync.findUnique({ where: { id } });
  if (!record) return { reason: 'record_missing' };
  const receipt = await prisma.auditLog.findUnique({ where: { id: `calendar-break:${id}` } });
  const associationCount = record.doctoraliaBreakId
    ? await prisma.bookingSync.count({ where: { doctoraliaBreakId: record.doctoraliaBreakId } }) : 0;
  const overlapCount = record.doctoraliaDoctorId && record.doctoraliaAddressId
    ? await prisma.bookingSync.count({ where: {
      id: { not: id }, clinicId: record.clinicId,
      doctoraliaDoctorId: record.doctoraliaDoctorId,
      doctoraliaAddressId: record.doctoraliaAddressId,
      status: { in: ['BOOKED', 'CONFIRMED'] },
      startAt: { lt: record.endAt }, endAt: { gt: record.startAt },
    } }) : 0;
  const reason = assessLocal(record, receipt, associationCount, overlapCount, new Date(), FILTER_CUTOFF);
  return { record, receipt, reason };
}

function doctoraliaUrl(record, domain, resource = 'break') {
  const host = String(domain || 'doctoralia.com.br').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!['doctoralia.com.br', 'www.doctoralia.com.br'].includes(host)) throw new Error('unsupported_doctoralia_domain');
  const parts = [record.doctoraliaFacilityId, record.doctoraliaDoctorId,
    record.doctoraliaAddressId].map(encodeURIComponent);
  const base = `https://www.doctoralia.com.br/api/v3/integration/facilities/${parts[0]}/doctors/${parts[1]}/addresses/${parts[2]}`;
  if (resource === 'break') return `${base}/breaks/${encodeURIComponent(record.doctoraliaBreakId)}`;
  const day = record.startAt.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('invalid_local_date');
  return `${base}/slots?start=${encodeURIComponent(`${day}T00:00:00-03:00`)}&end=${encodeURIComponent(`${day}T23:59:59-03:00`)}`;
}

async function remoteRequest(record, method, resource = 'break') {
  const conn = await prisma.integrationConnection.findFirst({
    where: { clinicId: record.clinicId, provider: 'doctoralia' },
    select: { domain: true, cachedToken: true, tokenExpiresAt: true },
  });
  if (!conn?.cachedToken || !conn.tokenExpiresAt || conn.tokenExpiresAt <= new Date()) {
    throw new Error('no_current_doctoralia_token');
  }
  const response = await fetch(doctoraliaUrl(record, conn.domain, resource), {
    method,
    headers: { Authorization: `Bearer ${conn.cachedToken}`, 'User-Agent': 'Orquestrador/1.0 (VisMed integration)' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`doctoralia_http_${response.status}`);
  return method === 'GET' ? response.json() : null;
}

async function assess(id) {
  const snapshot = await localSnapshot(id);
  if (snapshot.reason) return snapshot;
  const { record } = snapshot;
  const vismedConn = await prisma.integrationConnection.findFirst({
    where: { clinicId: record.clinicId, provider: 'vismed', status: { not: 'disconnected' } },
    select: { domain: true },
  });
  if (!vismedConn) return { ...snapshot, reason: 'vismed_connection_missing' };
  const source = await vismed.getAgendamentoById(record.vismedAppointmentId, vismedConn.domain || undefined);
  const sourceReason = assessSource(record, source);
  if (sourceReason) return { ...snapshot, reason: sourceReason };
  const remote = await remoteRequest(record, 'GET');
  const remoteReason = assessRemote(record, remote);
  if (remoteReason) return { ...snapshot, reason: remoteReason };
  const slots = await remoteRequest(record, 'GET', 'slots');
  return { ...snapshot, reason: assessSlots(record, slots) };
}

async function applyOne(id) {
  // Re-read immediately before DELETE; a dry-run is never sufficient authorization.
  const snapshot = await assess(id);
  if (snapshot.reason) throw new Error(`${id}: ${snapshot.reason}`);
  const { record, receipt } = snapshot;
  await remoteRequest(record, 'DELETE');
  const removedAt = new Date();
  await prisma.$transaction(async (tx) => {
    const changed = await tx.bookingSync.updateMany({
      where: { id, doctoraliaBreakId: record.doctoraliaBreakId, updatedAt: record.updatedAt },
      data: { doctoraliaBreakId: null, syncedToDoctoralia: false, syncError: null },
    });
    if (changed.count !== 1) throw new Error('local_record_changed_after_remote_delete');
    const currentReceipt = await tx.auditLog.findUnique({ where: { id: `calendar-break:${id}` } });
    if (currentReceipt?.action !== receipt.action || currentReceipt.entityId !== receipt.entityId
      || JSON.stringify(currentReceipt.details) !== JSON.stringify(receipt.details)) {
      throw new Error('ownership_receipt_changed_after_remote_delete');
    }
    await tx.auditLog.update({
      where: { id: `calendar-break:${id}` },
      data: { details: { ...receipt.details, state: 'REMOVED', removedAt: removedAt.toISOString(),
        removalReason: 'historical_nonconsultation_cleanup' } },
    });
  });
  console.log(JSON.stringify({ id, result: 'removed', remoteBreakId: record.doctoraliaBreakId }));
}

async function main() {
  const targetIds = ids.length ? ids : (await prisma.bookingSync.findMany({
    where: {
      origin: 'VISMED', status: { in: ['BOOKED', 'CONFIRMED'] },
      doctoraliaBreakId: { not: null }, endAt: { gt: new Date() }, createdAt: { lt: FILTER_CUTOFF },
    },
    select: { id: true, rawPayload: true },
  })).filter((row) => ['exame', 'procedimento'].includes(
    String(row.rawPayload?.tipo_servico || '').trim().toLowerCase(),
  )).map((row) => row.id);
  const reviewed = [];
  for (const id of targetIds) {
    try {
      const result = await assess(id);
      reviewed.push({ id, reason: result.reason || null });
    } catch (error) {
      const code = String(error.message || error);
      reviewed.push({ id, reason: /^(doctoralia_http_\d+|no_current_doctoralia_token|unsupported_doctoralia_domain)$/.test(code)
        ? code : 'source_or_network_error' });
    }
  }
  for (const row of reviewed) console.log(JSON.stringify({ id: row.id, result: row.reason || 'eligible' }));
  if (!apply) return;
  if (reviewed.some((row) => row.reason)) throw new Error('Apply aborted: at least one requested ID is no longer eligible.');
  for (const id of targetIds) await applyOne(id);
}

main().catch((error) => { console.error(String(error.message || error).slice(0, 200)); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
