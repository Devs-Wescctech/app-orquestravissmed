#!/usr/bin/env node
'use strict';

// Run in the API container after publication. Dry-run by default; no patient data is logged.
const { PrismaClient } = require('@prisma/client');
const { VismedService } = require('../dist/integrations/vismed/vismed.service');
const { assessLocal, assessSource, needsRecovery, typeOf } = require('./legacy-appointment-type-policy.cjs');
const { persistClassification } = require('./legacy-appointment-type-write.cjs');

const CUTOFF = new Date('2026-09-18T00:00:00Z');
const prisma = new PrismaClient();
const vismed = new VismedService();
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const includePast = args.includes('--include-past');
const idsArg = args.find((arg) => arg.startsWith('--ids='));
const afterArg = args.find((arg) => arg.startsWith('--after='));
const limitArg = args.find((arg) => arg.startsWith('--limit='));
const ids = idsArg ? [...new Set(idsArg.slice(6).split(',').map((id) => id.trim()).filter(Boolean))] : [];
const limit = limitArg ? Number(limitArg.slice(8)) : 20;
if (args.some((arg) => !['--apply', '--include-past'].includes(arg)
    && !['--ids=', '--after=', '--limit='].some((prefix) => arg.startsWith(prefix)))
  || !Number.isInteger(limit) || limit < 1 || limit > 100
  || (apply && (!ids.length || ids.length > 20 || afterArg))
  || (idsArg && (!ids.length || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))))) {
  console.error('Usage: backfill-legacy-appointment-types.cjs [--limit=1..100] [--after=UUID] [--include-past] [--ids=UUID,...] [--apply --ids=UUID,...]');
  process.exit(2);
}

async function candidates() {
  if (ids.length) return ids.map((id) => ({ id }));
  const now = new Date();
  const selected = [];
  let after = afterArg ? afterArg.slice(8) : null;
  while (selected.length < limit) {
    const page = await prisma.bookingSync.findMany({
      where: {
        origin: 'VISMED', createdAt: { lt: CUTOFF },
        ...(includePast ? {} : { status: { in: ['BOOKED', 'CONFIRMED'] }, endAt: { gt: now } }),
        ...(after ? { id: { gt: after } } : {}),
      },
      select: { id: true, rawPayload: true }, orderBy: { id: 'asc' }, take: 500,
    });
    if (!page.length) break;
    for (const record of page) {
      if (!typeOf(record.rawPayload)) selected.push({ id: record.id });
      if (selected.length === limit) break;
    }
    after = page[page.length - 1].id;
  }
  return selected;
}

async function assess(id) {
  const record = await prisma.bookingSync.findUnique({ where: { id } });
  const localReason = assessLocal(record, new Date(), CUTOFF, includePast);
  if (localReason) return { record, reason: localReason };
  const receipt = await prisma.auditLog.findUnique({ where: { id: `legacy-type:${id}` } });
  if (receipt) return { record, reason: 'already_backfilled' };
  const connection = await prisma.integrationConnection.findFirst({
    where: { clinicId: record.clinicId, provider: 'vismed', status: { not: 'disconnected' } },
    select: { domain: true },
  });
  if (!connection) return { record, reason: 'vismed_connection_missing' };
  try {
    const response = await vismed.getAgendamentoById(record.vismedAppointmentId, connection.domain || undefined);
    return { record, connection, ...assessSource(record, response) };
  } catch {
    return { record, reason: 'source_read_error' };
  }
}

async function applyOne(id) {
  const result = await assess(id);
  if (result.reason) throw new Error(`${id}: ${result.reason}`);
  const { recoveryReviewNeeded } = await persistClassification(prisma, result);
  console.log(JSON.stringify({ id, result: 'classified', type: result.type, recoveryReviewNeeded }));
}

async function main() {
  const records = await candidates();
  const reviewed = [];
  for (const record of records) {
    const result = await assess(record.id);
    reviewed.push({ id: record.id, reason: result.reason || null, type: result.type || null,
      recoveryReviewNeeded: !result.reason && needsRecovery(result.record, result.type, result.flag) });
    // Keep the one-off audit below the normal integration request rate.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const row of reviewed) console.log(JSON.stringify({ ...row, result: row.reason || 'eligible' }));
  if (!apply) return;
  if (reviewed.some((row) => row.reason)) throw new Error('Apply aborted: one or more requested IDs are not eligible.');
  for (const id of ids) await applyOne(id);
}

main().catch((error) => { console.error(String(error.message || error).slice(0, 200)); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
