// Authorized disposable Doctoralia sandbox only. Optional temporary service, always removed.
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
let owned = [], attempted = false, temporaryId, temporaryPayload, originalServiceIds;
global.fetch = async (input, options = {}) => {
  const u = new URL(String(input)), method = (options.method || 'GET').toUpperCase();
  assert.equal(u.origin, 'https://www.doctoralia.com.br');
  const write = method === 'PUT' && u.pathname === `${root}/slots`;
  const createService = method === 'POST' && u.pathname === `${root}/services` && process.argv.includes('--temporary-service');
  const removeService = method === 'DELETE' && temporaryId && u.pathname === `${root}/services/${temporaryId}`;
  assert.ok((method === 'POST' && u.pathname === '/oauth/v2/token') ||
    (method === 'GET' && (u.pathname === '/api/v3/integration/facilities' || u.pathname === '/api/v3/integration/services' || u.pathname.startsWith(`${root}/`))) || write || createService || removeService);
  if (createService) assert.deepEqual(JSON.parse(options.body), temporaryPayload);
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
  const attempts = process.argv.includes('--extended-readback') ? 20 : 8;
  for (let i = 0; i < attempts; i++) {
    const actual = await read(date);
    if (snapshotMatches(actual, expected)) return;
    if (i === attempts - 1) {
      console.log('Mismatch synthetic starts/services', JSON.stringify(actual._items?.map(s => ({ start: s.start, ids: s.address_services?._items?.map(x => x.id) }))));
      throw new Error('SnapshotMismatch');
    }
    await new Promise(resolve => setTimeout(resolve, process.argv.includes('--extended-readback') ? 2000 : 1000));
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
  originalServiceIds = [...ids].sort();
  console.log('Sandbox existing service IDs', JSON.stringify(ids));
  if (process.argv.includes('--catalog-only')) {
    const catalog = await client.getServicesDictionary();
    console.log('Consultation candidates', JSON.stringify(catalog._items.filter(s => /consulta/i.test(s.name)).slice(0, 8).map(s => ({ id: s.id, name: s.name }))));
    return;
  }
  assert.ok(ids.includes('6018375'));
  let secondId = ids.find(x => x !== '6018375');
  for (const date of dates) {
    assert.ok(snapshotMatches(await read(date), []), 'Sandbox date must start empty');
    for (const method of ['getBookings', 'getCalendarBreaks']) {
      const result = await client[method](f, d, a, ...bounds(date));
      assert.deepEqual(result._items, []); assert.ok(!result._links?.next);
      assert.ok(result.total === undefined || result.total === 0);
    }
  }
  if (!secondId && process.argv.includes('--temporary-service')) {
    const catalog = await client.getServicesDictionary();
    assert.ok(Array.isArray(catalog._items));
    const existing = new Set(services._items.map(s => String(s.service_id)));
    const selected = catalog._items.find(s => String(s.id) === '286' && s.name === 'Consulta especializada' && !existing.has(String(s.id)));
    assert.ok(selected, 'Existing consultation catalog service required');
    temporaryPayload = { service_id: String(selected.id), description: 'Synthetic selective-removal QA 2026-09-18', default_duration: 30, is_visible: true, price: 0 };
    const created = await client.request('POST', `${root}/services`, temporaryPayload);
    temporaryId = String(created.id);
    assert.ok(/^[1-9]\d*$/.test(temporaryId) && !originalServiceIds.includes(temporaryId));
    secondId = temporaryId;
    console.log('Temporary sandbox service created', temporaryId);
    const confirmed = await client.getServices(f, d, a);
    const entry = confirmed._items.find(s => String(s.id) === temporaryId);
    assert.ok(entry && entry.is_visible === true && String(entry.service_id) === temporaryPayload.service_id);
    console.log('Confirmed temporary service', JSON.stringify({ id: entry.id, service_id: entry.service_id, is_visible: entry.is_visible, default_duration: entry.default_duration }));
  }
  assert.ok(secondId || process.argv.includes('--single-service'), 'Second service required');
  const period = (date, start, end, duration, serviceIds = ['6018375']) => ({
    start: `${date}T${start}:00-03:00`, end: `${date}T${end}:00-03:00`,
    address_services: serviceIds.map(address_service_id => ({ address_service_id, duration })),
  });
  owned = [period(dates[0], '08:10', '08:30', 20), period(dates[0], '09:10', '09:30', 20),
    period(dates[0], '10:10', '10:40', 30, secondId ? ['6018375', secondId] : ['6018375']), period(dates[1], '11:10', '11:40', 30)];
  await client.replaceSlots(f, d, a, { slots: owned });
  console.log('Submitted synthetic slot services', JSON.stringify(owned.map(p => ({ start: p.start, services: p.address_services }))));
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
  if (temporaryId && process.exitCode !== 2) {
    try {
      await client.deleteAddressService(f, d, a, temporaryId);
      const remaining = await client.getServices(f, d, a);
      assert.ok(!remaining._links?.next);
      assert.deepEqual(remaining._items.map(s => String(s.id)).sort(), originalServiceIds);
      console.log('PASS: temporary service removed and original service IDs restored');
    } catch { console.error('SERVICE RESTORATION NOT VERIFIED', temporaryId); process.exitCode = 2; }
  }
});
