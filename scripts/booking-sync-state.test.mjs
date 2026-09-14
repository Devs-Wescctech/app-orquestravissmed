import test from 'node:test';
import assert from 'node:assert/strict';
import { getBookingSyncState } from '../apps/web/src/lib/booking-sync-state.ts';

const blocked = {
    origin: 'VISMED', status: 'BOOKED', vismedAppointmentId: 'local-1',
    doctoraliaBreakId: 'break-1', syncedToDoctoralia: true,
};

test('16 confirmed VissMed blocks count as synchronized without Doctoralia bookings', () => {
    const records = Array.from({ length: 16 }, () => getBookingSyncState(blocked));
    assert.equal(records.filter(r => r.syncedToVismed && r.syncedToDoctoralia).length, 16);
    assert.equal(records.filter(r => !r.syncedToVismed || !r.syncedToDoctoralia).length, 0);
    assert.ok(records.every(r => r.doctoraliaBreakConfirmed));
});

for (const [name, patch] of [
    ['missing block', { doctoraliaBreakId: null }],
    ['move pending', { syncedToDoctoralia: false }],
    ['no confirmation', { syncedToDoctoralia: undefined }],
    ['synchronization error', { syncError: 'move failed' }],
    ['failed record', { status: 'FAILED' }],
    ['cancelled record', { status: 'CANCELLED' }],
    ['different origin', { origin: 'DOCTORALIA' }],
]) {
    test(`${name} must not claim a confirmed block`, () => {
        const state = getBookingSyncState({ ...blocked, ...patch });
        assert.equal(state.doctoraliaBreakConfirmed, false);
        assert.equal(state.syncedToDoctoralia, false);
    });
}

test('real Doctoralia booking keeps its existing ID-based synchronization', () => {
    const state = getBookingSyncState({ origin: 'DOCTORALIA', status: 'BOOKED', doctoraliaBookingId: 'remote-1', vismedAppointmentId: 'local-1' });
    assert.equal(state.syncedToDoctoralia, true);
    assert.equal(state.syncedToVismed, true);
    assert.equal(state.doctoraliaBreakConfirmed, false);
});

test('Doctoralia booking awaiting VissMed remains pending', () => {
    assert.equal(getBookingSyncState({ origin: 'DOCTORALIA', status: 'BOOKED', doctoraliaBookingId: 'remote-1' }).syncedToVismed, false);
});

test('booking ID does not turn an unconfirmed block into a confirmed one', () => {
    const state = getBookingSyncState({ ...blocked, doctoraliaBookingId: 'remote-1', syncedToDoctoralia: false });
    assert.equal(state.syncedToDoctoralia, true);
    assert.equal(state.doctoraliaBreakConfirmed, false);
});
