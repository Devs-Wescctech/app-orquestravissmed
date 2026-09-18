// Authorized disposable Doctoralia sandbox only. No bookings, DB or service changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Logger } = require('@nestjs/common');
const { DocplannerClient } = require('../apps/api/dist/integrations/docplanner.service');
const { reconcileManagedRemoval } = require('../apps/api/dist/sync/managed-slot-reconciler');
const { managedSlotState } = require('../apps/api/dist/sync/managed-slot-ranges');
const { periodsHash, snapshotMatches } = require('../apps/api/dist/sync/managed-period-replacement');
assert.ok(process.argv.includes('--authorized-sandbox'));
Logger.overrideLogger(false);
const f = '140548', d = '1396868', a = '1750984';
const dates = ['2026-09-24', '2026-09-25'];
const root = `/api/v3/integration/facilities/${f}/doctors/${d}/addresses/${a}`;
const client = new DocplannerClient({ get: () => undefined });
client.setBaseUrl('https://www.doctoralia.com.br');
const originalFetch = global.fetch;
let owned = [], attempted = false;
global.fetch = async (input, options = {}) => {
  const u = new URL(String(input)), method = (options.method || 'GET').toUpperCase();
  assert.equal(u.origin, 'https://www.doctoralia.com.br');
  const write = method === 'PUT' && u.pathname === `${root}/slots`;
  assert.ok((method === 'POST' && u.pathname === '/oauth/v2/token') ||
    (method === 'GET' && (u.pathname === '/api/v3/integration/facilities' || u.pathname.startsWith(`${root}/`))) || write);
  if (write) {
    const body = JSON.parse(options.body);
    assert.ok(body.slots.length > 0 && body.slots.length <= owned.length);
    for (const p of body.slots) {
      const known = owned.find(o => o.start === p.start && o.end === p.end);
      assert.ok(known);
      assert.ok(p.address_services.length === 0 || JSON.stringify(p.address_services) === JSON.stringify(known.address_services));
    }
    attempted = true;
  }
  const response = await originalFetch(input, options);
  if (write) console.log('Sandbox PUT status', response.status);
  return response;
};
const bounds = date => [`${date}T00:00:00-03:00`, `${date}T23:59:59-03:00`];
const read = date => client.getSlotsForReconciliation(f, d, a, ...bounds(date));
async function verify(date, expected) {
  for (let i = 0; i < 8; i++) {
    const actual = await read(date);
    if (snapshotMatches(actual, expected)) return;
    if (i === 7) {
      console.log('Mismatch synthetic starts/services', JSON.stringify(actual._items?.map(s => ({ start: s.start, ids: s.address_services?._items?.map(x => x.id) }))));
      throw new Error('SnapshotMismatch');
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
async function main() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../app-orquestravissmed/explore_api.js'), 'utf8');
  const setting = name => source.match(new RegExp('const\\s+' + name + '\\s*=\\s*[\'\"]([^\'\"]+)[\'\"]'))?.[1];
  await client.authenticate(setting('CLIENT_ID'), setting('CLIENT_SECRET'));
  const facilities = await client.getFacilities();
  assert.equal(facilities._items.length, 1);
  assert.equal(String(facilities._items[0].id), f);
  assert.equal(facilities._items[0].name, 'Medical Center Bruno Mendes Test');
  const services = await client.getServices(f, d, a);
  assert.ok(Array.isArray(services._items)); assert.ok(!services._links?.next);
  const ids = services._items.map(s => String(s.id)).filter(x => /^[1-9]\d*$/.test(x));
  console.log('Sandbox existing service IDs', JSON.stringify(ids));
  if (process.argv.includes('--catalog-only')) return;
  assert.ok(ids.includes('6018375') && (ids.length >= 2 || process.argv.includes('--single-service')), 'Two existing sandbox services required unless single-service selected');
  const secondId = ids.find(x => x !== '6018375');
  for (const date of dates) {
    assert.ok(snapshotMatches(await read(date), []), 'Sandbox date must start empty');
    for (const method of ['getBookings', 'getCalendarBreaks']) {
      const result = await client[method](f, d, a, ...bounds(date));
      assert.deepEqual(result._items, []); assert.ok(!result._links?.next);
      assert.ok(result.total === undefined || result.total === 0);
    }
  }
  const period = (date, start, end, duration, serviceIds = ['6018375']) => ({
    start: `${date}T${start}:00-03:00`, end: `${date}T${end}:00-03:00`,
    address_services: serviceIds.map(address_service_id => ({ address_service_id, duration })),
  });
  owned = [period(dates[0], '08:10', '08:30', 20), period(dates[0], '09:10', '09:30', 20),
    period(dates[0], '10:10', '10:40', 30, secondId ? ['6018375', secondId] : ['6018375']), period(dates[1], '11:10', '11:40', 30)];
  await client.replaceSlots(f, d, a, { slots: owned });
  for (const date of dates) await verify(date, owned.filter(p => p.start.startsWith(date)));
  const scope = { clinicId: 'synthetic-expanded', facilityId: f, doctorId: d, addressId: a };
  const hash = periodsHash(owned);
  let saved;
  assert.equal(await reconcileManagedRemoval({ state: managedSlotState(scope, hash, owned), hash, scope,
    targets: [owned[0]], client, authorized: async () => true, persist: async remaining => { saved = remaining; } }), true);
  assert.deepEqual(saved, owned.slice(1));
  for (const date of dates) await verify(date, saved.filter(p => p.start.startsWith(date)));
  console.log(`PASS: selected 20-minute period removed; other 20-minute period, ${secondId ? 'two-service' : 'single-service'} 30-minute period and next date preserved`);
}
main().catch(e => { console.error('Expanded probe failed:', e.name, e.code || ''); process.exitCode = 1; }).finally(async () => {
  if (attempted) {
    try {
      await client.replaceSlots(f, d, a, { slots: owned.map(p => ({ start: p.start, end: p.end, address_services: [] })) });
      for (const date of dates) await verify(date, []);
      console.log('PASS: both sandbox dates restored empty');
    } catch { console.error('RESTORATION NOT VERIFIED'); process.exitCode = 2; }
  }
});
