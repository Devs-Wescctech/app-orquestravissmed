// Authorized sandbox only: no database and no bookings/cancellations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Logger } = require('@nestjs/common');
const { DocplannerClient } = require('../apps/api/dist/integrations/docplanner.service');
const { reconcileManagedRemoval } = require('../apps/api/dist/sync/managed-slot-reconciler');
const { managedSlotState } = require('../apps/api/dist/sync/managed-slot-ranges');
const { periodsHash } = require('../apps/api/dist/sync/managed-period-replacement');
assert.ok(process.argv.includes('--authorized-sandbox'));
Logger.overrideLogger(false);
const f = '140548', d = '1396868', a = '1750984';
const date = '2026-09-22';
const root = `/api/v3/integration/facilities/${f}/doctors/${d}/addresses/${a}`;
const first = { start: `${date}T08:10:00-03:00`, end: `${date}T08:40:00-03:00`, address_services: [{ address_service_id: '6018375', duration: 30 }] };
const second = { ...first, start: `${date}T09:10:00-03:00`, end: `${date}T09:40:00-03:00` };
const client = new DocplannerClient({ get: () => undefined });
client.setBaseUrl('https://www.doctoralia.com.br');
const fetchOriginal = global.fetch;
let attempted = false;
global.fetch = async (input, options = {}) => {
  const u = new URL(String(input)), m = (options.method || 'GET').toUpperCase();
  assert.equal(u.origin, 'https://www.doctoralia.com.br');
  const auth = m === 'POST' && u.pathname === '/oauth/v2/token';
  const read = m === 'GET' && (u.pathname === '/api/v3/integration/facilities' || u.pathname.startsWith(`${root}/`));
  const write = m === 'PUT' && u.pathname === `${root}/slots`;
  assert.ok(auth || read || write);
  if (write) {
    const payload = JSON.parse(options.body);
    assert.ok(payload.slots.length >= 1 && payload.slots.length <= 2);
    for (const slot of payload.slots) {
      assert.ok([first, second].some(s => s.start === slot.start && s.end === slot.end));
      assert.ok(slot.address_services.length === 0 || JSON.stringify(slot.address_services) === JSON.stringify(first.address_services));
    }
    attempted = true;
    console.log('PUT', JSON.stringify(payload));
  }
  const response = await fetchOriginal(input, options);
  if (write) console.log('status', response.status);
  return response;
};
const start = `${date}T00:00:00-03:00`, end = `${date}T23:59:59-03:00`;
async function slots() {
  const result = await client.request('GET', `${root}/slots?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&with[]=slot.services`);
  assert.ok(Array.isArray(result._items)); assert.ok(!result._links?.next);
  return result._items;
}
async function settle(expected) {
  for (let i = 0; i < 12; i++) {
    const result = await slots();
    const actual = result.map(s => s.start).sort();
    if (JSON.stringify(actual) === JSON.stringify([...expected].sort())) return result;
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('Unexpected slot result');
}
async function main() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../app-orquestravissmed/explore_api.js'), 'utf8');
  const setting = name => source.match(new RegExp('const\\s+' + name + '\\s*=\\s*[\'"]([^\'"]+)[\'"]'))?.[1];
  await client.authenticate(setting('CLIENT_ID'), setting('CLIENT_SECRET'));
  const facilities = await client.getFacilities();
  assert.equal(facilities._items.length, 1); assert.equal(String(facilities._items[0].id), f);
  assert.equal(facilities._items[0].name, 'Medical Center Bruno Mendes Test');
  assert.deepEqual(await slots(), []);
  for (const method of ['getBookings', 'getCalendarBreaks']) {
    const result = await client[method](f, d, a, start, end);
    assert.ok(Array.isArray(result._items)); assert.equal(result._items.length, 0); assert.ok(!result._links?.next);
  }
  await client.replaceSlots(f, d, a, { slots: [first, second] });
  console.log('expanded synthetic slots', JSON.stringify(await settle([first.start, second.start])));
  const scope = { clinicId: 'synthetic-local', facilityId: f, doctorId: d, addressId: a };
  const hash = periodsHash([first, second]);
  let persisted;
  const result = await reconcileManagedRemoval({ state: managedSlotState(scope, hash, [first, second]), hash, scope, targets: [first], client,
    authorized: async () => true, persist: async remaining => { persisted = remaining; } });
  assert.equal(result, true);
  assert.deepEqual(persisted, [second]);
  await settle([second.start]);
  console.log('PASS production reconciler removes first, preserves second, verifies read-back and persists only remaining configuration');
}
main().catch(e => { console.error('Probe failed:', e.name); process.exitCode = 1; }).finally(async () => {
  if (attempted) {
    try {
      await client.replaceSlots(f, d, a, { slots: [first, second].map(s => ({ ...s, address_services: [] })) });
      await settle([]); console.log('Sandbox restored empty');
    } catch { console.error('RESTORATION NOT VERIFIED'); process.exitCode = 2; }
  }
});
