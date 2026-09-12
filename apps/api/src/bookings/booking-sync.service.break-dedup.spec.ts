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
    rec?: any;
    addCalendarBreak?: jest.Mock;
    getCalendarBreaks?: jest.Mock;
    getCalendarBreak?: jest.Mock;
    moveCalendarBreak?: jest.Mock;
    updateResult?: any;
    legacy?: boolean;
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
        ...(overrides.rec || {}),
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
    const getCalendarBreak  = overrides.getCalendarBreak  ?? jest.fn().mockResolvedValue(null);
    const moveCalendarBreak = overrides.moveCalendarBreak ?? jest.fn().mockResolvedValue({});
    const client = {
        addCalendarBreak,
        getCalendarBreaks,
        getCalendarBreak,
        moveCalendarBreak,
        deleteCalendarBreak: jest.fn(),
    };

    let receipt: any = rec.doctoraliaBreakId && !overrides.legacy ? {
        id: `calendar-break:${rec.id}`, action: 'CALENDAR_BREAK_CREATION', entityId: rec.id,
        details: { state: 'OWNED', breakId: rec.doctoraliaBreakId, clinicId: rec.clinicId,
            facilityId: 'fac-1', doctorId: 'doc-ext-1', addressId: 'addr-1' },
    } : null;
    const prisma = {
        auditLog: {
            findUnique: jest.fn(async () => receipt),
            create: jest.fn(async ({data}) => { if (receipt) throw Object.assign(new Error('duplicate'), {code:'P2002'}); receipt = data; return receipt; }),
            update: jest.fn(async ({data}) => { receipt = { ...receipt, ...data }; return receipt; }),
            deleteMany: jest.fn(async () => { receipt = null; return {count:1}; }),
        },
        bookingSync: {
            findFirst: jest.fn().mockResolvedValue(null),
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
        null as any, // concurrencyGuard
        null as any, // bookingClaimService
    );

    return { service, prisma, client, addCalendarBreak, getCalendarBreaks, getCalendarBreak, moveCalendarBreak };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('syncDoctoraliaBreak — ownership', () => {
    const callSync = (service: BookingSyncService) => (service as any).syncDoctoraliaBreak('bs-1');
    it('persists a direct creation receipt and booking ID', async () => {
        const {service, prisma, client} = buildService({});
        await callSync(service);
        expect(prisma.auditLog.update).toHaveBeenCalledWith(expect.objectContaining({data: {
            details: expect.objectContaining({state:'OWNED',breakId:'new-break-id'}),
        }}));
        expect(prisma.bookingSync.update).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({
            doctoraliaBreakId:'new-break-id', syncedToDoctoralia:true,
        })}));
        expect(client.getCalendarBreaks).not.toHaveBeenCalled();
    });
    it.each([
        ['manual break', [remoteBreak('manual')]],
        ['another patient', [remoteBreak('patient-A')]],
        ['multiple breaks', [remoteBreak('A'), remoteBreak('B')]],
        ['no break', []],
    ])('409 with %s never adopts or reports success', async (_label, items) => {
        const {service, prisma, client} = buildService({addCalendarBreak:jest.fn().mockRejectedValue(conflictError()), getCalendarBreaks:jest.fn().mockResolvedValue(items)});
        await expect(callSync(service)).rejects.toThrow('BREAK_CONFLICT');
        expect(client.getCalendarBreaks).not.toHaveBeenCalled();
        expect(client.deleteCalendarBreak).not.toHaveBeenCalled();
        expect(prisma.bookingSync.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({syncedToDoctoralia:false})}));
        expect(prisma.bookingSync.update.mock.calls.some(([a]:any[]) => a.data.doctoraliaBreakId)).toBe(false);
    });
    it.each([abortError(), new Error('fetch failed'), serverError()])('uncertain failure persists a hold across retries: %s', async error => {
        const {service, prisma, client} = buildService({addCalendarBreak:jest.fn().mockRejectedValue(error),getCalendarBreaks:jest.fn().mockResolvedValue([remoteBreak('manual')])});
        await expect(callSync(service)).rejects.toThrow('BREAK_CREATION_UNCONFIRMED');
        await expect(callSync(service)).rejects.toThrow('BREAK_CREATION_UNCONFIRMED');
        expect(client.addCalendarBreak).toHaveBeenCalledTimes(1);
        expect(client.getCalendarBreaks).not.toHaveBeenCalled();
        expect(prisma.auditLog.deleteMany).not.toHaveBeenCalled();
    });
    it.each([{}, {id:null}, {id:{wrong:true}}])('missing/invalid returned ID remains pending: %j', async response => {
        const {service,client} = buildService({addCalendarBreak:jest.fn().mockResolvedValue(response)});
        await expect(callSync(service)).rejects.toThrow('BREAK_CREATION_UNCONFIRMED');
        await expect(callSync(service)).rejects.toThrow('BREAK_CREATION_UNCONFIRMED');
        expect(client.addCalendarBreak).toHaveBeenCalledTimes(1);
    });
    it('pre-send rejection permits a later safe retry', async () => {
        const error = Object.assign(new Error('queue full'), {name:'DoctoraliaQueueFullError',code:'DOCTORALIA_QUEUE_FULL'});
        const {service,client} = buildService({addCalendarBreak:jest.fn().mockRejectedValueOnce(error).mockResolvedValue({id:'created'})});
        await expect(callSync(service)).rejects.toThrow('BREAK_RETRY_PENDING');
        await expect(callSync(service)).resolves.toBeUndefined();
        expect(client.addCalendarBreak).toHaveBeenCalledTimes(2);
    });
    it('recovers a confirmed creation after local update fails, without another POST', async () => {
        const update = jest.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue({});
        const {service,client} = buildService({bookingSync:{update}});
        await expect(callSync(service)).rejects.toThrow('database unavailable');
        await callSync(service);
        expect(client.addCalendarBreak).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenLastCalledWith(expect.objectContaining({data:expect.objectContaining({doctoraliaBreakId:'new-break-id',syncedToDoctoralia:false})}));
    });
    it.each(['CANCELLED','BOOKED'])('legacy association without proof is preserved on %s', async status => {
        const {service,client,prisma} = buildService({legacy:true,rec:{status,doctoraliaBreakId:'legacy'}});
        await expect(callSync(service)).rejects.toThrow('BREAK_OWNERSHIP_PENDING');
        expect(client.moveCalendarBreak).not.toHaveBeenCalled();
        expect(client.deleteCalendarBreak).not.toHaveBeenCalled();
        expect(prisma.bookingSync.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({syncedToDoctoralia:false})}));
    });
    it('changed doctor/address mapping cannot move a confirmed break', async () => {
        const {service,client} = buildService({rec:{doctoraliaBreakId:'owned'}, mapping:{externalId:'different-doctor',conflictData:{facilityId:'fac-1',address:{id:'different-address'}}}});
        await expect(callSync(service)).rejects.toThrow('BREAK_OWNERSHIP_PENDING');
        expect(client.moveCalendarBreak).not.toHaveBeenCalled();
    });
    it('concurrent attempts send only one POST', async () => {
        const {service,client} = buildService({});
        await Promise.allSettled([callSync(service), callSync(service)]);
        expect(client.addCalendarBreak).toHaveBeenCalledTimes(1);
    });
    it('journal unavailable prevents sending', async () => {
        const {service,client,prisma} = buildService({});
        prisma.auditLog.create.mockRejectedValueOnce(new Error('database unavailable'));
        await expect(callSync(service)).rejects.toThrow('database unavailable');
        expect(client.addCalendarBreak).not.toHaveBeenCalled();
    });
    it('failed receipt persistence leaves a durable hold instead of repeating POST', async () => {
        const {service,client,prisma} = buildService({});
        prisma.auditLog.update.mockRejectedValueOnce(new Error('database unavailable'));
        await expect(callSync(service)).rejects.toThrow('database unavailable');
        await expect(callSync(service)).rejects.toThrow('BREAK_CREATION_UNCONFIRMED');
        expect(client.addCalendarBreak).toHaveBeenCalledTimes(1);
    });
    it('dashboard cancellation preserves an unproven legacy break and records the reason', async () => {
        const {service,client,prisma} = buildService({legacy:true});
        await (service as any).cancelSyncRecord('clinic-1', {id:'bs-1',doctoraliaBreakId:'legacy',doctoraliaFacilityId:'fac-1',doctoraliaDoctorId:'doc-ext-1',doctoraliaAddressId:'addr-1'});
        expect(client.deleteCalendarBreak).not.toHaveBeenCalled();
        expect(prisma.bookingSync.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({syncError:expect.stringContaining('BREAK_OWNERSHIP_PENDING')})}));
    });
    it('404 on cancellation clears the confirmed association safely', async () => {
        const {service,client,prisma} = buildService({rec:{status:'CANCELLED',doctoraliaBreakId:'owned'}});
        client.deleteCalendarBreak.mockRejectedValue(Object.assign(new Error('404'),{status:404}));
        await callSync(service);
        expect(prisma.bookingSync.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({doctoraliaBreakId:null})}));
    });
    it('cancels only a break with creation evidence', async () => {
        const {service,client,prisma} = buildService({rec:{status:'CANCELLED',doctoraliaBreakId:'owned'}});
        await callSync(service);
        expect(client.deleteCalendarBreak).toHaveBeenCalledWith('fac-1','doc-ext-1','addr-1','owned');
        expect(prisma.bookingSync.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({doctoraliaBreakId:null})}));
    });
    it('duplicate association prevents cancellation even with a receipt', async () => {
        const {service,client} = buildService({rec:{status:'CANCELLED',doctoraliaBreakId:'owned'},bookingSync:{findFirst:jest.fn().mockResolvedValue({id:'patient-A'})}});
        await expect(callSync(service)).rejects.toThrow('outro agendamento');
        expect(client.deleteCalendarBreak).not.toHaveBeenCalled();
    });
    it('does not clear the link when remote cancellation fails', async () => {
        const {service,client,prisma} = buildService({rec:{status:'CANCELLED',doctoraliaBreakId:'owned'}});
        client.deleteCalendarBreak.mockRejectedValue(abortError());
        await expect(callSync(service)).rejects.toMatchObject({name:'AbortError'});
        expect(prisma.bookingSync.update).not.toHaveBeenCalled();
        expect(prisma.auditLog.deleteMany).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// WP-10 — move/PATCH idempotency: reconcile ambiguous move via GET-by-ID
// ---------------------------------------------------------------------------

describe('syncDoctoraliaBreak — WP-10 move idempotency', () => {
    const callSync = (service: BookingSyncService, id = 'bs-1') =>
        (service as any).syncDoctoraliaBreak(id);

    const MOVE_REC = { doctoraliaBreakId: 'brk-1' };

    /** Remote break exactly at the move target (as returned by GET-by-ID) */
    const remoteAtTarget = () => ({ id: 'brk-1', since: SINCE, till: TILL });
    /** Remote break still at the OLD position */
    const remoteOld = () => ({
        id: 'brk-1',
        since: '2026-08-09T10:00:00-03:00',
        till:  '2026-08-09T10:30:00-03:00',
    });

    const sameRangeError = () =>
        Object.assign(new Error('Docplanner API Error: 422 — Same Date Range'), { status: 422 });
    const notFoundError = () =>
        Object.assign(new Error('Docplanner API Error: 404 Not Found'), { status: 404 });
    const queueFullError = () =>
        Object.assign(new Error('fila cheia'), { name: 'DoctoraliaQueueFullError', code: 'DOCTORALIA_QUEUE_FULL' });
    const queueTimeoutError = () =>
        Object.assign(new Error('espera esgotada'), { name: 'DoctoraliaQueueTimeoutError', code: 'DOCTORALIA_QUEUE_TIMEOUT' });
    const circuitOpenError = () =>
        Object.assign(new Error('circuito aberto'), { name: 'DoctoraliaCircuitOpenError' });
    const businessError = () =>
        Object.assign(new Error('Docplanner API Error: 400 Bad Request'), { status: 400 });

    it('(m-a) move succeeds — marks synced, no GET, no second PATCH', async () => {
        const { service, client, prisma } = buildService({
            rec: MOVE_REC,
            moveCalendarBreak: jest.fn().mockResolvedValue({}),
        });

        await expect(callSync(service)).resolves.toBeUndefined();

        expect(client.moveCalendarBreak).toHaveBeenCalledTimes(1);
        expect(client.getCalendarBreak).not.toHaveBeenCalled();
        expect(client.addCalendarBreak).not.toHaveBeenCalled();
        expect(prisma.bookingSync.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ syncedToDoctoralia: true }) }),
        );
    });

    it('(m-b) timeout + remote already at target — success, no second PATCH, keeps breakId', async () => {
        const { service, client, prisma } = buildService({
            rec: MOVE_REC,
            moveCalendarBreak: jest.fn().mockRejectedValue(abortError()),
            getCalendarBreak:  jest.fn().mockResolvedValue(remoteAtTarget()),
        });

        await expect(callSync(service)).resolves.toBeUndefined();

        expect(client.moveCalendarBreak).toHaveBeenCalledTimes(1); // no second PATCH
        expect(client.getCalendarBreak).toHaveBeenCalledTimes(1);
        expect(client.getCalendarBreak).toHaveBeenCalledWith('fac-1', 'doc-ext-1', 'addr-1', 'brk-1');
        expect(client.addCalendarBreak).not.toHaveBeenCalled();
        expect(prisma.bookingSync.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ syncedToDoctoralia: true }) }),
        );
        // doctoraliaBreakId must NOT be cleared or replaced
        const clearedCall = prisma.bookingSync.update.mock.calls.find(
            ([arg]: any[]) => arg?.data && 'doctoraliaBreakId' in arg.data,
        );
        expect(clearedCall).toBeUndefined();
    });

    it('(m-c) timeout + remote still at OLD position — rethrows, no persist', async () => {
        const { service, client, prisma } = buildService({
            rec: MOVE_REC,
            moveCalendarBreak: jest.fn().mockRejectedValue(abortError()),
            getCalendarBreak:  jest.fn().mockResolvedValue(remoteOld()),
        });

        await expect(callSync(service)).rejects.toMatchObject({ name: 'AbortError' });

        expect(client.moveCalendarBreak).toHaveBeenCalledTimes(1);
        expect(client.getCalendarBreak).toHaveBeenCalledTimes(1);
        expect(client.addCalendarBreak).not.toHaveBeenCalled();
        expect(prisma.bookingSync.update).not.toHaveBeenCalled();
    });

    it('(m-d) timeout + reconcile GET fails — rethrows, never assumes success', async () => {
        const { service, client, prisma } = buildService({
            rec: MOVE_REC,
            moveCalendarBreak: jest.fn().mockRejectedValue(abortError()),
            getCalendarBreak:  jest.fn().mockRejectedValue(new Error('GET failed')),
        });

        await expect(callSync(service)).rejects.toMatchObject({ name: 'AbortError' });
        expect(client.addCalendarBreak).not.toHaveBeenCalled();
        expect(prisma.bookingSync.update).not.toHaveBeenCalled();
    });

    it('(m-e) timeout + inconsistent GET payload (missing till) — rethrows', async () => {
        const { service, client, prisma } = buildService({
            rec: MOVE_REC,
            moveCalendarBreak: jest.fn().mockRejectedValue(abortError()),
            getCalendarBreak:  jest.fn().mockResolvedValue({ id: 'brk-1', since: SINCE }),
        });

        await expect(callSync(service)).rejects.toMatchObject({ name: 'AbortError' });
        expect(client.addCalendarBreak).not.toHaveBeenCalled();
        expect(prisma.bookingSync.update).not.toHaveBeenCalled();
    });

    it('(m-f) network error (post-send, no status) + remote at target — success', async () => {
        const { service, client, prisma } = buildService({
            rec: MOVE_REC,
            moveCalendarBreak: jest.fn().mockRejectedValue(new Error('read ECONNRESET')),
            getCalendarBreak:  jest.fn().mockResolvedValue(remoteAtTarget()),
        });

        await expect(callSync(service)).resolves.toBeUndefined();
        expect(client.moveCalendarBreak).toHaveBeenCalledTimes(1);
        expect(prisma.bookingSync.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ syncedToDoctoralia: true }) }),
        );
    });

    it('(m-g) 422 Same Date Range — still success, no reconcile GET', async () => {
        const { service, client, prisma } = buildService({
            rec: MOVE_REC,
            moveCalendarBreak: jest.fn().mockRejectedValue(sameRangeError()),
        });

        await expect(callSync(service)).resolves.toBeUndefined();
        expect(client.getCalendarBreak).not.toHaveBeenCalled();
        expect(prisma.bookingSync.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ syncedToDoctoralia: true }) }),
        );
    });

    it('(m-h) 404 on move — still recreates (existing behaviour), no reconcile GET', async () => {
        const { service, client, prisma } = buildService({
            rec: MOVE_REC,
            moveCalendarBreak: jest.fn().mockRejectedValue(notFoundError()),
            addCalendarBreak:  jest.fn().mockResolvedValue({ id: 'recreated-id' }),
        });

        await expect(callSync(service)).resolves.toBeUndefined();

        expect(client.getCalendarBreak).not.toHaveBeenCalled();
        expect(client.addCalendarBreak).toHaveBeenCalledTimes(1);
        const adoptCall = prisma.bookingSync.update.mock.calls.find(
            ([arg]: any[]) => arg?.data?.doctoraliaBreakId === 'recreated-id',
        );
        expect(adoptCall).toBeDefined();
    });

    it.each([
        ['QueueFull', queueFullError()],
        ['QueueTimeout', queueTimeoutError()],
        ['CircuitOpen', circuitOpenError()],
        ['business 4xx', businessError()],
    ])('(m-i) %s — rethrows without reconcile GET', async (_label, err) => {
        const { service, client, prisma } = buildService({
            rec: MOVE_REC,
            moveCalendarBreak: jest.fn().mockRejectedValue(err),
        });

        await expect(callSync(service)).rejects.toBe(err);
        expect(client.getCalendarBreak).not.toHaveBeenCalled();
        expect(client.moveCalendarBreak).toHaveBeenCalledTimes(1);
        expect(client.addCalendarBreak).not.toHaveBeenCalled();
        expect(prisma.bookingSync.update).not.toHaveBeenCalled();
    });
});
