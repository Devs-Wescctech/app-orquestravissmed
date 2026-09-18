// Explicitly authorized Doctoralia sandbox only. Never runs from application startup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Logger } = require('@nestjs/common');
const { PrismaClient } = require('@prisma/client');
const { DocplannerClient } = require('../apps/api/dist/integrations/docplanner.service');
const { DisabledProfessionalSlots } = require('../apps/api/dist/sync/disabled-professional-slots');
const { managedSlotState } = require('../apps/api/dist/sync/managed-slot-ranges');
assert.ok(process.argv.includes('--execute-authorized-sandbox'), 'Explicit sandbox execution required');
const db = new URL(process.env.DATABASE_URL || '');
assert.equal(db.hostname, '127.0.0.1'); assert.equal(db.port, '55439'); assert.equal(db.pathname, '/sync_test');
Logger.overrideLogger(false);
const scope = { clinicId: 'eligibility-sandbox-20260918', facilityId: '140548', doctorId: '1396868', addressId: '1750984' };
const date = '2026-09-21';
const range = { start: `${date}T08:10:00-03:00`, end: `${date}T08:40:00-03:00` };
const control = { start: `${date}T09:10:00-03:00`, end: `${date}T09:40:00-03:00` };
const root = `/api/v3/integration/facilities/${scope.facilityId}/doctors/${scope.doctorId}/addresses/${scope.addressId}`;
const prisma = new PrismaClient();
const client = new DocplannerClient({ get: () => undefined });
client.setBaseUrl('https://www.doctoralia.com.br');
const realFetch = global.fetch;
let writes = 0, attempted = false, restored = false;
let phase = 'preflight';
global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = (options.method || 'GET').toUpperCase();
    assert.equal(url.origin, 'https://www.doctoralia.com.br');
    const auth = method === 'POST' && url.pathname === '/oauth/v2/token';
    const reads = ['/api/v3/integration/facilities', `/api/v3/integration/facilities/${scope.facilityId}/doctors/${scope.doctorId}/addresses`, ...['calendar', 'services', 'slots', 'bookings', 'breaks'].map(s => `${root}/${s}`)];
    const put = method === 'PUT' && url.pathname === `${root}/slots`;
    assert.ok(auth || (method === 'GET' && reads.includes(url.pathname)) || put, 'Outside authorized test scope');
    if (put) {
        const body = JSON.parse(options.body);
        assert.ok(body.slots.length > 0 && body.slots.length <= 2);
        for (const slot of body.slots) {
            assert.ok([range, control].some(r => r.start === slot.start && r.end === slot.end));
            assert.ok(slot.address_services.length === 0 || (slot.address_services.length === 1 && String(slot.address_services[0].address_service_id) === '6018375'));
        }
        writes++; attempted = true;
    }
    return realFetch(input, { ...options, signal: options.signal || AbortSignal.timeout(30000) });
};
const dayStart = `${date}T00:00:00-03:00`, dayEnd = `${date}T23:59:59-03:00`;
async function items(method) {
    const result = await client[method](scope.facilityId, scope.doctorId, scope.addressId, dayStart, dayEnd);
    assert.ok(Array.isArray(result._items)); assert.ok(!result._links?.next);
    return result._items;
}
async function waitSlots(expected) {
    let last;
    for (let n = 0; n < 8; n++) {
        const actual = (await items('getSlots')).map(s => s.start).sort();
        last = actual;
        if (JSON.stringify(actual) === JSON.stringify([...expected].sort())) return;
        await new Promise(resolve => setTimeout(resolve, 1500));
    }
    console.log(JSON.stringify({ phase, expectedStarts: expected, observedStarts: last }));
    throw new Error('Sandbox slots did not reach expected state');
}
async function main() {
    const source = fs.readFileSync(path.resolve(__dirname, '../../app-orquestravissmed/explore_api.js'), 'utf8');
    const setting = name => source.match(new RegExp('const\\s+' + name + '\\s*=\\s*[\'"]([^\'"]+)[\'"]'))?.[1];
    assert.ok(setting('CLIENT_ID') && setting('CLIENT_SECRET'), 'Sandbox credentials unavailable');
    await client.authenticate(setting('CLIENT_ID'), setting('CLIENT_SECRET'));
    const facilities = await client.getFacilities();
    assert.equal(facilities._items.length, 1);
    assert.equal(String(facilities._items[0].id), scope.facilityId);
    assert.equal(facilities._items[0].name, 'Medical Center Bruno Mendes Test');
    const addresses = await client.getAddresses(scope.facilityId, scope.doctorId);
    assert.ok(addresses._items.some(a => String(a.id) === scope.addressId));
    const calendar = await client.getCalendar(scope.facilityId, scope.doctorId, scope.addressId);
    assert.equal(calendar.status, 'enabled');
    const services = await client.getServices(scope.facilityId, scope.doctorId, scope.addressId);
    assert.ok(services._items.some(s => String(s.id) === '6018375' && s.is_visible === true));
    for (const method of ['getSlots', 'getBookings', 'getCalendarBreaks']) assert.equal((await items(method)).length, 0, 'Sandbox day is not empty');
    await prisma.clinic.create({ data: { id: scope.clinicId, name: 'Synthetic eligibility sandbox' } });
    await prisma.mapping.create({ data: { clinicId: scope.clinicId, entityType: 'DOCTOR', vismedId: 'synthetic-local', externalId: scope.doctorId, status: 'LINKED' } });
    const data = { doctoraliaDoctorId: scope.doctorId, addressId: scope.addressId, availabilityHash: 'sandbox-proof', managedState: managedSlotState(scope, 'sandbox-proof', [range]) };
    await prisma.slotPushState.create({ data });
    phase = 'create';
    await client.replaceSlots(scope.facilityId, scope.doctorId, scope.addressId, { slots: [range, control].map(r => ({ ...r, address_services: [{ address_service_id: '6018375', duration: 30 }] })) });
    await waitSlots([range.start, control.start]);
    const cleaner = new DisabledProfessionalSlots(prisma);
    const args = [scope.clinicId, 'synthetic-local', scope.facilityId, scope.doctorId, client];
    const before = writes;
    assert.deepEqual(await cleaner.clear(...args, async () => false), { cleared: 0, pending: 1 });
    assert.equal(writes, before);
    phase = 'scoped-clear';
    assert.deepEqual(await cleaner.clear(...args, async () => true), { cleared: 1, pending: 0 });
    await waitSlots([control.start]);
    const after = writes;
    assert.deepEqual(await new DisabledProfessionalSlots(prisma).clear(...args, async () => true), { cleared: 0, pending: 0 });
    assert.equal(writes, after);
    for (const method of ['getBookings', 'getCalendarBreaks']) assert.equal((await items(method)).length, 0);
    assert.equal((await client.getCalendar(scope.facilityId, scope.doctorId, scope.addressId)).status, calendar.status);
    console.log('PASS: real PUT, unknown-state preservation, scoped cleanup, unrelated interval preserved, durable idempotency, calendar unchanged.');
}
main().catch(error => { console.error(`Sandbox test failed (${error.name}); no credentials or patient data logged.`); process.exitCode = 1; }).finally(async () => {
    if (attempted) {
        phase = 'recovery';
        try {
            await client.replaceSlots(scope.facilityId, scope.doctorId, scope.addressId, { slots: [range, control].map(r => ({ ...r, address_services: [] })) });
            await waitSlots([]); restored = true;
        } catch { console.error('RECOVERY NOT VERIFIED: preserve local journal and inspect sandbox intervals.'); process.exitCode = 2; }
    }
    if (!attempted || restored) {
        await prisma.slotPushState.deleteMany({ where: { doctoraliaDoctorId: scope.doctorId, addressId: scope.addressId } });
        await prisma.clinic.deleteMany({ where: { id: scope.clinicId } });
    }
    await prisma.$disconnect();
    console.log(JSON.stringify({ attempted, restored, writes, scope, date }));
});
