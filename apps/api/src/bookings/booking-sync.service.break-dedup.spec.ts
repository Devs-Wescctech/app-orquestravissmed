/**
 * Unit tests for syncDoctoraliaBreak — break deduplication after timeout / 409
 *
 * Task WP-02 P0a: when addCalendarBreak fails with a network/timeout error the
 * break may already have been created on Doctoralia's side.  Before rethrowing,
 * the system must look for the remote break and adopt it if found unambiguously.
 *
 * Covered scenarios:
 *   (a) POST succeeds           → normal persist, no findRemoteBreakId call
 *   (b) timeout, 0 candidates   → rethrow; no persist
 *   (c) timeout, 1 candidate (since + till correct) → adopt; no rethrow
 *   (d) timeout, 1 candidate (since correct, till wrong) → rethrow; no persist
 *   (e) timeout, 2 candidates   → rethrow; no persist (ambiguous)
 *   (f) 409, 1 candidate        → adopt; existing 409 behaviour preserved
 *   (g) 409, 0 candidates       → warn only; no rethrow (existing 409 behaviour)
 */

import { BookingSyncService } from './booking-sync.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SINCE = '2026-08-10T09:00:00-03:00';
const TILL  = '2026-08-10T09:30:00-03:00';

/** Builds a fake remote break item */
const remoteBreak = (id: string, sinceDeltaMs = 0, tillDeltaMs = 0) => ({
    id,
    since: new Date(new Date(SINCE).getTime() + sinceDeltaMs).toISOString(),
    till:  new Date(new Date(TILL).getTime()  + tillDeltaMs).toISOString(),
});

/** AbortError as thrown by fetch when the 30 s controller fires */
const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

/** 409 HTTP error as thrown by DocplannerClient.request */
const conflictError = () => Object.assign(new Error('Docplanner API Error: 409 Conflict'), { status: 409 });

/** Other HTTP error (e.g. 500) */
const serverError = () => Object.assign(new Error('Docplanner API Error: 500'), { status: 500 });

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

function buildService(overrides: {
    bookingSync?: Partial<Record<string, jest.Mock>>;
    mapping?: any;
    conn?: any;
    addCalendarBreak?: jest.Mock;
    getCalendarBreaks?: jest.Mock;
    updateResult?: any;
}) {
    const rec = {
        id: 'bs-1',
        clinicId: 'clinic-1',
        origin: 'VISMED',
        vismedDoctorId: 'vismed-doc-1',
        status: 'BOOKED',
        startAt: new Date(SINCE),
        endAt:   new Date(TILL),
        doctoraliaBreakId: null,
        syncedToDoctoralia: false,
    };

    const mapping = overrides.mapping ?? {
        clinicId: 'clinic-1',
        entityType: 'DOCTOR',
        status: 'LINKED',
        externalId: 'doc-ext-1',
        vismedId: 'vismed-doc-1',
        conflictData: { facilityId: 'fac-1', address: { id: 'addr-1' } },
    };

    const conn = overrides.conn ?? {
        clinicId: 'clinic-1',
        provider: 'doctoralia',
        status: 'connected',
        clientId: 'cid',
        clientSecret: 'secret',
        domain: 'www.doctoralia.com.br',
    };

    const addCalendarBreak  = overrides.addCalendarBreak  ?? jest.fn().mockResolvedValue({ id: 'new-break-id' });
    const getCalendarBreaks = overrides.getCalendarBreaks ?? jest.fn().mockResolvedValue([]);
    const client = {
        addCalendarBreak,
        getCalendarBreaks,
        moveCalendarBreak: jest.fn(),
        deleteCalendarBreak: jest.fn(),
    };

    const prisma = {
        bookingSync: {
            findUnique: jest.fn().mockResolvedValue(rec),
            update:     jest.fn().mockResolvedValue(rec),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            ...(overrides.bookingSync || {}),
        },
        mapping: { findFirst: jest.fn().mockResolvedValue(mapping) },
        integrationConnection: { findFirst: jest.fn().mockResolvedValue(conn) },
        skippedBookingAlert: { upsert: jest.fn(), updateMany: jest.fn() },
    } as any;

    const docplannerService = { createClient: jest.fn().mockReturnValue(client) };
    const rateLimiter = { acquire: jest.fn().mockResolvedValue(undefined) };

    // Inject minimal stubs for the remaining constructor arguments
    const service = new BookingSyncService(
        prisma,
        docplannerService as any,
        null as any, // vismedService
        null as any, // queueService
        rateLimiter as any,
        null as any, // matchingEngine
    );

    return { service, prisma, client, addCalendarBreak, getCalendarBreaks };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('syncDoctoraliaBreak — break deduplication', () => {
    // Helper to call the private method
    const callSync = (service: BookingSyncService, id = 'bs-1') =>
        (service as any).syncDoctoraliaBreak(id);

    // (a) -----------------------------------------------------------------------
    it('(a) POST succeeds — persists breakId, does NOT call getCalendarBreaks', async () => {
        const { service, client, prisma } = buildService({
            addCalendarBreak: jest.fn().mockResolvedValue({ id: 'created-id' }),
        });

        await callSync(service);

        expect(client.addCalendarBreak).toHaveBeenCalledTimes(1);
        expect(client.getCalendarBreaks).not.toHaveBeenCalled();
        expect(prisma.bookingSync.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ doctoraliaBreakId: 'created-id', syncedToDoctoralia: true }),
            }),
        );
    });

    // (b) -----------------------------------------------------------------------
    it('(b) timeout, 0 candidates — rethrows, no persist', async () => {
        const { service, client, prisma } = buildService({
            addCalendarBreak:  jest.fn().mockRejectedValue(abortError()),
            getCalendarBreaks: jest.fn().mockResolvedValue([]), // empty list
        });

        await expect(callSync(service)).rejects.toMatchObject({ name: 'AbortError' });

        expect(client.getCalendarBreaks).toHaveBeenCalledTimes(1);
        // update should NOT have been called with breakId (only the rateLimiter was acquired)
        const updateCalls: any[] = prisma.bookingSync.update.mock.calls;
        const adoptCall = updateCalls.find(([arg]: any[]) => arg?.data?.doctoraliaBreakId);
        expect(adoptCall).toBeUndefined();
    });

    // (c) -----------------------------------------------------------------------
    it('(c) timeout, 1 candidate (since + till correct) — adopts; does NOT rethrow', async () => {
        const { service, client, prisma } = buildService({
            addCalendarBreak:  jest.fn().mockRejectedValue(abortError()),
            // since within 10s, till within 10s → both within ±60s tolerance
            getCalendarBreaks: jest.fn().mockResolvedValue([remoteBreak('remote-1', 10_000, 5_000)]),
        });

        await expect(callSync(service)).resolves.toBeUndefined();

        expect(client.getCalendarBreaks).toHaveBeenCalledTimes(1);
        const updateCalls: any[] = prisma.bookingSync.update.mock.calls;
        const adoptCall = updateCalls.find(([arg]: any[]) => arg?.data?.doctoraliaBreakId === 'remote-1');
        expect(adoptCall).toBeDefined();
        expect(adoptCall[0].data.syncedToDoctoralia).toBe(true);
    });

    // (d) -----------------------------------------------------------------------
    it('(d) timeout, 1 candidate (since correct, till outside tolerance) — rethrows; no persist', async () => {
        const { service, client, prisma } = buildService({
            addCalendarBreak:  jest.fn().mockRejectedValue(abortError()),
            // since within 10s (ok), till 90s off → outside ±60s tolerance
            getCalendarBreaks: jest.fn().mockResolvedValue([remoteBreak('remote-bad-till', 10_000, 90_000)]),
        });

        await expect(callSync(service)).rejects.toMatchObject({ name: 'AbortError' });

        const updateCalls: any[] = prisma.bookingSync.update.mock.calls;
        const adoptCall = updateCalls.find(([arg]: any[]) => arg?.data?.doctoraliaBreakId);
        expect(adoptCall).toBeUndefined();
    });

    // (e) -----------------------------------------------------------------------
    it('(e) timeout, 2 candidates — rethrows (ambiguous); no persist', async () => {
        const { service, client, prisma } = buildService({
            addCalendarBreak: jest.fn().mockRejectedValue(abortError()),
            getCalendarBreaks: jest.fn().mockResolvedValue([
                remoteBreak('remote-A', 5_000, 5_000),
                remoteBreak('remote-B', 2_000, 2_000),
            ]),
        });

        await expect(callSync(service)).rejects.toMatchObject({ name: 'AbortError' });

        const updateCalls: any[] = prisma.bookingSync.update.mock.calls;
        const adoptCall = updateCalls.find(([arg]: any[]) => arg?.data?.doctoraliaBreakId);
        expect(adoptCall).toBeUndefined();
    });

    // (f) -----------------------------------------------------------------------
    it('(f) 409, 1 candidate — adopts (existing 409 behaviour preserved)', async () => {
        const { service, client, prisma } = buildService({
            addCalendarBreak:  jest.fn().mockRejectedValue(conflictError()),
            getCalendarBreaks: jest.fn().mockResolvedValue([remoteBreak('existing-1', 0, 0)]),
        });

        await expect(callSync(service)).resolves.toBeUndefined();

        const updateCalls: any[] = prisma.bookingSync.update.mock.calls;
        const adoptCall = updateCalls.find(([arg]: any[]) => arg?.data?.doctoraliaBreakId === 'existing-1');
        expect(adoptCall).toBeDefined();
        expect(adoptCall[0].data.syncedToDoctoralia).toBe(true);
    });

    // (g) -----------------------------------------------------------------------
    it('(g) 409, 0 candidates — warns only; does NOT rethrow (existing 409 behaviour)', async () => {
        const { service, client } = buildService({
            addCalendarBreak:  jest.fn().mockRejectedValue(conflictError()),
            getCalendarBreaks: jest.fn().mockResolvedValue([]),
        });

        // must NOT throw
        await expect(callSync(service)).resolves.toBeUndefined();
        expect(client.getCalendarBreaks).toHaveBeenCalledTimes(1);
    });

    // (h) -----------------------------------------------------------------------
    it('(h) non-timeout HTTP error (500) — rethrows without calling getCalendarBreaks', async () => {
        const { service, client } = buildService({
            addCalendarBreak: jest.fn().mockRejectedValue(serverError()),
        });

        await expect(callSync(service)).rejects.toMatchObject({ status: 500 });
        expect(client.getCalendarBreaks).not.toHaveBeenCalled();
    });

    // (i) -----------------------------------------------------------------------
    it('(i) network error (no status) — treated as timeout; rethrows when 0 candidates', async () => {
        const networkErr = new Error('fetch failed');
        const { service, client } = buildService({
            addCalendarBreak:  jest.fn().mockRejectedValue(networkErr),
            getCalendarBreaks: jest.fn().mockResolvedValue([]),
        });

        await expect(callSync(service)).rejects.toBe(networkErr);
        expect(client.getCalendarBreaks).toHaveBeenCalledTimes(1);
    });
});
