import { BookingSyncService } from './booking-sync.service';
const LEGACY_VISMED_BASE_URL = 'https://app.vissmed.com.br/api-vissmed-4';
const INCREMENTAL_VISMED_BASE_URL = 'https://app.vissmed.com.br/api-docctor-3';

import { ClinicConcurrencyGuard } from './clinic-concurrency-guard';
import { DoctoraliaMetricsService } from '../metrics/doctoralia-metrics.service';
import { DoctoraliaCircuitOpenError } from '../integrations/doctoralia-circuit-breaker';
import { DoctoraliaQueueFullError } from '../integrations/doctoralia-queue.errors';
import { ClaimDeferError } from './booking-claim.service';

const conn = {
    clinicId: 'clinic-ingestion',
    provider: 'doctoralia',
    status: 'connected',
    clientId: 'client',
    clientSecret: 'secret',
    domain: 'www.doctoralia.com.br',
};

const notification = (id = 'booking-anon-1') => ({
    name: 'slot-booked',
    data: {
        visit_booking: {
            id,
            start_at: '2026-08-20T09:00:00-03:00',
            end_at: '2026-08-20T09:30:00-03:00',
            duration: 30,
            patient: { name: 'Paciente', surname: 'Anonimizado' },
        },
        doctor: { id: 'doctor-anon' },
        facility: { id: 'facility-anon' },
        address: { id: 'address-anon' },
    },
});

function buildService() {
    const client = {
        getNotifications: jest.fn().mockResolvedValue({ _items: [] }),
        getAddresses: jest.fn().mockResolvedValue({ _items: [] }),
        getBookings: jest.fn().mockResolvedValue({ _items: [] }),
    };
    const prisma = {
        integrationConnection: {
            findFirst: jest.fn().mockResolvedValue(conn),
        },
        bookingSync: {
            upsert: jest.fn(),
            findUnique: jest.fn(),
            findMany: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        doctoraliaDoctor: {
            findUnique: jest.fn().mockResolvedValue(null),
        },
        mapping: {
            findFirst: jest.fn().mockResolvedValue(null),
        },
    } as any;
    const queue = {
        enqueueBatch: jest.fn().mockResolvedValue({ count: 0 }),
        enqueue: jest.fn(),
        registerHandler: jest.fn(),
        registerDeadLetterHandler: jest.fn(),
    };
    const rateLimiter = { acquire: jest.fn().mockResolvedValue(undefined) };
    const claim = {
        withClaim: jest.fn((_clinicId, _bookingId, callback) =>
            callback(new AbortController().signal),
        ),
    };
    const guard = new ClinicConcurrencyGuard();
    const metrics = new DoctoraliaMetricsService();
    const service = new BookingSyncService(
        prisma,
        { createClient: jest.fn().mockReturnValue(client) } as any,
        {} as any,
        queue as any,
        rateLimiter as any,
        {} as any,
        guard,
        claim as any,
    );
    return { service, prisma, queue, rateLimiter, guard, client, metrics, claim };
}

describe('BookingSyncService — reconciliação Doctoralia com vínculos atuais', () => {
    const clinicId = conn.clinicId;
    const startAt = new Date('2026-08-20T12:00:00.000Z');
    const unlinked = (doctorId: string, id = `sync-${doctorId}`) => ({
        id,
        clinicId,
        doctoraliaDoctorId: doctorId,
        doctoraliaBookingId: null,
        doctoraliaAddressId: 'historical-address',
        doctoraliaFacilityId: 'historical-facility',
        vismedAppointmentId: `vismed-${id}`,
        status: 'BOOKED',
        startAt,
    });

    function setup(records: any[]) {
        const built = buildService();
        built.prisma.bookingSync.findMany
            .mockResolvedValueOnce(records)
            .mockResolvedValue([]);
        return built;
    }

    it('usa somente facility atual e endereços atuais, buscando endereços uma vez por médico', async () => {
        const { service, prisma, client } = setup([
            unlinked('doctor-1', 'sync-1'),
            { ...unlinked('doctor-1', 'sync-2'), startAt: new Date(startAt.getTime() + 60_000) },
        ]);
        prisma.doctoraliaDoctor.findUnique.mockResolvedValue({ doctoraliaFacilityId: 'current-facility' });
        client.getAddresses.mockResolvedValue({ _items: [{ id: 'current-address' }] });

        await (service as any).reconcileUnlinkedWithDoctoralia(clinicId);

        expect(client.getAddresses).toHaveBeenCalledTimes(1);
        expect(client.getAddresses).toHaveBeenCalledWith('current-facility', 'doctor-1');
        expect(client.getBookings).toHaveBeenCalledWith(
            'current-facility', 'doctor-1', 'current-address', expect.any(String), expect.any(String),
        );
        expect(client.getBookings).not.toHaveBeenCalledWith(
            'historical-facility', expect.anything(), 'historical-address', expect.anything(), expect.anything(),
        );
    });

    it.each([
        ['médico ausente', null, { _items: [{ id: 'address-1' }] }, false],
        ['facility vazia', { doctoraliaFacilityId: ' ' }, { _items: [{ id: 'address-1' }] }, false],
        ['endereços vazios', { doctoraliaFacilityId: 'facility-1' }, { _items: [] }, true],
    ])('encerra somente o grupo quando há %s', async (_label, doctor, addresses, callsAddresses) => {
        const { service, prisma, client } = setup([unlinked('doctor-1')]);
        prisma.doctoraliaDoctor.findUnique.mockResolvedValue(doctor);
        client.getAddresses.mockResolvedValue(addresses);

        await (service as any).reconcileUnlinkedWithDoctoralia(clinicId);

        expect(client.getAddresses).toHaveBeenCalledTimes(callsAddresses ? 1 : 0);
        expect(client.getBookings).not.toHaveBeenCalled();
        expect(prisma.bookingSync.update).not.toHaveBeenCalled();
    });

    it('isola erro de endereços de um médico e continua com o próximo', async () => {
        const { service, prisma, client } = setup([
            unlinked('doctor-fails'),
            unlinked('doctor-ok'),
        ]);
        prisma.doctoraliaDoctor.findUnique
            .mockResolvedValueOnce({ doctoraliaFacilityId: 'facility-fails' })
            .mockResolvedValueOnce({ doctoraliaFacilityId: 'facility-ok' });
        client.getAddresses
            .mockRejectedValueOnce(new Error('403 with patient data that must not be logged'))
            .mockResolvedValueOnce({ _items: [{ id: 'address-ok' }] });

        await (service as any).reconcileUnlinkedWithDoctoralia(clinicId);

        expect(client.getBookings).toHaveBeenCalledWith(
            'facility-ok', 'doctor-ok', 'address-ok', expect.any(String), expect.any(String),
        );
    });

    it('isola erro no lookup local de um médico e continua com o próximo', async () => {
        const { service, prisma, client } = setup([
            unlinked('doctor-fails'),
            unlinked('doctor-ok'),
        ]);
        prisma.doctoraliaDoctor.findUnique
            .mockRejectedValueOnce(new Error('database unavailable'))
            .mockResolvedValueOnce({ doctoraliaFacilityId: 'facility-ok' });
        client.getAddresses.mockResolvedValue({ _items: [{ id: 'address-ok' }] });

        await (service as any).reconcileUnlinkedWithDoctoralia(clinicId);

        expect(client.getAddresses).toHaveBeenCalledTimes(1);
        expect(client.getBookings).toHaveBeenCalledWith(
            'facility-ok', 'doctor-ok', 'address-ok', expect.any(String), expect.any(String),
        );
    });

    it('isola falha de endereço e vincula o match válido sem atravessar clínica', async () => {
        const record = unlinked('doctor-1');
        const { service, prisma, client } = setup([record]);
        prisma.doctoraliaDoctor.findUnique.mockResolvedValue({ doctoraliaFacilityId: 'facility-1' });
        client.getAddresses.mockResolvedValue({ _items: [{ id: 'address-fails' }, { id: 'address-ok' }] });
        client.getBookings
            .mockRejectedValueOnce(new Error('forbidden'))
            .mockResolvedValueOnce({
                _items: [{ id: 'booking-1', start_at: startAt.toISOString() }],
            });

        await (service as any).reconcileUnlinkedWithDoctoralia(clinicId);

        expect(prisma.bookingSync.updateMany).toHaveBeenCalledWith({
            where: {
                id: record.id,
                clinicId,
                doctoraliaDoctorId: 'doctor-1',
                doctoraliaBookingId: null,
                status: { in: ['BOOKED', 'CONFIRMED'] },
            },
            data: {
                doctoraliaBookingId: 'booking-1',
                doctoraliaAddressId: 'address-ok',
                doctoraliaFacilityId: 'facility-1',
                syncedToDoctoralia: true,
            },
        });
    });

    it('não adota quando o registro muda entre a seleção e a persistência', async () => {
        const record = unlinked('doctor-1');
        const { service, prisma, client } = setup([record]);
        prisma.doctoraliaDoctor.findUnique.mockResolvedValue({ doctoraliaFacilityId: 'facility-1' });
        prisma.bookingSync.updateMany.mockResolvedValue({ count: 0 });
        client.getAddresses.mockResolvedValue({ _items: [{ id: 'address-1' }] });
        client.getBookings.mockResolvedValue({
            _items: [{ id: 'booking-1', start_at: startAt.toISOString() }],
        });

        await (service as any).reconcileUnlinkedWithDoctoralia(clinicId);

        expect(record.doctoraliaBookingId).toBeNull();
    });
});

describe('BookingSyncService — ingestão Doctoralia confiável', () => {
    it('poll de notifications atravessa poll VisMed longo e o booking alcança handleSlotBooked', async () => {
        const { service, prisma, queue, rateLimiter, guard, client } = buildService();
        const body = notification();
        client.getNotifications.mockResolvedValue({ _items: [body] });
        queue.enqueueBatch.mockResolvedValue({ count: 1 });

        expect(guard.tryAcquire(conn.clinicId, 'POLLING')).toBe(true);
        await (service as any).pollClinic(conn);

        expect(rateLimiter.acquire).toHaveBeenCalledWith('doctoralia');
        expect(client.getNotifications).toHaveBeenCalledWith(100);
        expect(queue.enqueueBatch).toHaveBeenCalledTimes(1);
        expect(guard.isActive(conn.clinicId, 'POLLING')).toBe(true);
        expect(guard.isActive(conn.clinicId, 'NOTIFICATION_POLL')).toBe(false);

        const queued = queue.enqueueBatch.mock.calls[0][0][0];
        prisma.bookingSync.upsert.mockResolvedValue({
            id: 'sync-anon-1',
            clinicId: conn.clinicId,
            doctoraliaBookingId: body.data.visit_booking.id,
            status: 'PROCESSING',
        });
        prisma.bookingSync.findUnique.mockResolvedValue({
            id: 'sync-anon-1',
            clinicId: conn.clinicId,
            doctoraliaBookingId: body.data.visit_booking.id,
            status: 'PROCESSING',
        });
        await (service as any).handleSlotBooked(
            queued.clinicId,
            queued.payload.data,
            queued.payload.raw,
        );

        expect(prisma.bookingSync.upsert).toHaveBeenCalledTimes(1);
        expect(prisma.bookingSync.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'sync-anon-1' },
        }));
        guard.release(conn.clinicId, 'POLLING');
    });

    it('dois polls de notifications da mesma clínica nunca se sobrepõem', async () => {
        const { service, guard, client, metrics } = buildService();
        let release!: (value: any) => void;
        client.getNotifications.mockImplementationOnce(
            () => new Promise(resolve => { release = resolve; }),
        );

        const first = (service as any).pollClinic(conn);
        while (client.getNotifications.mock.calls.length === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }
        await (service as any).pollClinic(conn);

        expect(client.getNotifications).toHaveBeenCalledTimes(1);
        expect(guard.isActive(conn.clinicId, 'NOTIFICATION_POLL')).toBe(true);
        expect((metrics.getBaseline() as any).polling.notificationIngestion.singleFlightSkips).toBe(1);

        release({ _items: [] });
        await first;
        expect(guard.isActive(conn.clinicId, 'NOTIFICATION_POLL')).toBe(false);
    });

    it('telemetria separa recebidas, aceitas, rejeitadas, inseridas e deduplicadas', async () => {
        const { service, queue, client, metrics } = buildService();
        client.getNotifications.mockResolvedValue({
            _items: [
                notification('booking-anon-1'),
                notification('booking-anon-2'),
                { name: 'unsupported-event', data: {} },
            ],
        });
        queue.enqueueBatch.mockResolvedValue({ count: 1 });

        await (service as any).pollClinic(conn);

        const ingestion = (metrics.getBaseline() as any).polling.notificationIngestion;
        expect(ingestion).toMatchObject({
            received: 3,
            accepted: 2,
            rejected: 1,
            inserted: 1,
            deduplicated: 1,
            enqueueErrors: 0,
        });
    });

    it('falha de enqueue fica observável e libera o single-flight', async () => {
        const { service, queue, client, metrics, guard } = buildService();
        client.getNotifications.mockResolvedValue({ _items: [notification()] });
        queue.enqueueBatch.mockRejectedValue(Object.assign(new Error('database unavailable'), { code: 'P1001' }));

        await expect((service as any).pollClinic(conn)).resolves.toBeUndefined();

        const ingestion = (metrics.getBaseline() as any).polling.notificationIngestion;
        expect(ingestion).toMatchObject({
            received: 1,
            accepted: 1,
            inserted: 0,
            enqueueErrors: 1,
        });
        expect(guard.isActive(conn.clinicId, 'NOTIFICATION_POLL')).toBe(false);
    });

    it.each([
        new DoctoraliaQueueFullError('LOW', 500),
        new DoctoraliaCircuitOpenError('www.doctoralia.com.br', 'test', 30_000),
    ])('backpressure/circuit breaker continuam no caminho e não deixam o guard preso (%s)', async (error) => {
        const { service, queue, client, rateLimiter, guard } = buildService();
        client.getNotifications.mockRejectedValue(error);

        await expect((service as any).pollClinic(conn)).resolves.toBeUndefined();

        expect(rateLimiter.acquire).toHaveBeenCalledWith('doctoralia');
        expect(client.getNotifications).toHaveBeenCalledTimes(1);
        expect(queue.enqueueBatch).not.toHaveBeenCalled();
        expect(guard.isActive(conn.clinicId, 'NOTIFICATION_POLL')).toBe(false);
    });

    it('P2002 só resulta em already_synced quando o registro idempotente é confirmado', async () => {
        const { service, prisma } = buildService();
        const body = notification();
        prisma.bookingSync.upsert.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
        prisma.bookingSync.findUnique.mockResolvedValue({ id: 'existing-sync' });

        await expect(
            (service as any).handleSlotBooked(conn.clinicId, body.data, body),
        ).resolves.toEqual({ processed: false, reason: 'already_synced' });
    });

    it('P2002 sem registro correspondente é erro observável e segue para retry', async () => {
        const { service, prisma, metrics } = buildService();
        const body = notification();
        const conflict = Object.assign(new Error('unique'), { code: 'P2002' });
        prisma.bookingSync.upsert.mockRejectedValue(conflict);
        prisma.bookingSync.findUnique.mockResolvedValue(null);

        await expect(
            (service as any).handleSlotBooked(conn.clinicId, body.data, body),
        ).rejects.toBe(conflict);
        expect((metrics.getBaseline() as any).bookingReservationErrors).toEqual({
            total: 1,
            byCode: { P2002: 1 },
        });
    });

    it('erro Prisma não-idempotente no primeiro upsert nunca é mascarado', async () => {
        const { service, prisma, metrics } = buildService();
        const body = notification();
        const dbError = Object.assign(new Error('database unavailable'), { code: 'P1001' });
        prisma.bookingSync.upsert.mockRejectedValue(dbError);

        await expect(
            (service as any).handleSlotBooked(conn.clinicId, body.data, body),
        ).rejects.toBe(dbError);
        expect(prisma.bookingSync.findUnique).not.toHaveBeenCalled();
        expect((metrics.getBaseline() as any).bookingReservationErrors).toEqual({
            total: 1,
            byCode: { P1001: 1 },
        });
    });

    it('claim ocupado adia o booking, faz zero POST e nunca retorna already_synced', async () => {
        const { service, prisma, claim } = buildService();
        const body = notification();
        prisma.bookingSync.upsert.mockResolvedValue({
            id: 'sync-claim-busy',
            status: 'PROCESSING',
        });
        claim.withClaim.mockRejectedValueOnce(new ClaimDeferError('lock_occupied'));
        const createAppointment = jest.fn();
        (service as any).vismedService = { createAppointment };

        await expect(
            (service as any).handleSlotBooked(conn.clinicId, body.data, body),
        ).rejects.toMatchObject({ reason: 'lock_occupied' });

        expect(createAppointment).not.toHaveBeenCalled();
        expect(prisma.bookingSync.update).not.toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'FAILED' }),
        }));
    });

    // ──────────────────────────────────────────────────────────────────────────
    // NEW TESTS: slot-booked protected flow
    // ──────────────────────────────────────────────────────────────────────────

    describe('authoritative reread under claim', () => {
        it('rereads the booking record inside the claim before acting on it', async () => {
            const { service, prisma, claim } = buildService();
            const body = notification();

            const reserved = { id: 'sync-reread-1', status: 'PROCESSING', vismedAttemptAt: null };
            const fresh = { id: 'sync-reread-1', status: 'PROCESSING', vismedAttemptAt: null };
            prisma.bookingSync.upsert.mockResolvedValue(reserved);
            // findUnique is the authoritative reread; returns terminal state so no further work
            prisma.bookingSync.findUnique.mockResolvedValue({ ...fresh, status: 'BOOKED' });

            let capturedFindUniqueCalls = 0;
            const origWithClaim = claim.withClaim.getMockImplementation();
            claim.withClaim.mockImplementationOnce(async (clinicId, bookingId, callback, options) => {
                const result = await callback(new AbortController().signal);
                capturedFindUniqueCalls = prisma.bookingSync.findUnique.mock.calls.length;
                return result;
            });

            const result = await (service as any).handleSlotBooked(conn.clinicId, body.data, body);

            // findUnique must have been called inside the claim
            expect(capturedFindUniqueCalls).toBeGreaterThanOrEqual(1);
            // terminal state BOOKED causes already_synced without any external action
            expect(result).toEqual({ processed: false, reason: 'already_synced' });
        });

        it('returns already_synced when reread reveals BOOKED without calling vismed', async () => {
            const { service, prisma, claim } = buildService();
            const body = notification();
            prisma.bookingSync.upsert.mockResolvedValue({ id: 'sync-booked', status: 'PROCESSING' });
            prisma.bookingSync.findUnique.mockResolvedValue({ id: 'sync-booked', status: 'BOOKED' });

            const createAppt = jest.fn();
            (service as any).vismedService = { createAppointment: createAppt };

            const result = await (service as any).handleSlotBooked(conn.clinicId, body.data, body);

            expect(result).toEqual({ processed: false, reason: 'already_synced' });
            expect(createAppt).not.toHaveBeenCalled();
        });

        it('returns already_synced when reread reveals CANCELLED', async () => {
            const { service, prisma } = buildService();
            const body = notification();
            prisma.bookingSync.upsert.mockResolvedValue({ id: 'sync-cancelled', status: 'PROCESSING' });
            prisma.bookingSync.findUnique.mockResolvedValue({ id: 'sync-cancelled', status: 'CANCELLED' });

            const createAppt = jest.fn();
            (service as any).vismedService = { createAppointment: createAppt };

            const result = await (service as any).handleSlotBooked(conn.clinicId, body.data, body);
            expect(result).toEqual({ processed: false, reason: 'already_synced' });
            expect(createAppt).not.toHaveBeenCalled();
        });
    });

    describe('PROCESSING with VisMed preflight found → adopts without POST', () => {
        async function setupPreflightFound(prismaExtra: any = {}) {
            const { service, prisma, claim, rateLimiter } = buildService();
            const body = notification();

            const reservedRec = {
                id: 'sync-processing-1',
                status: 'PROCESSING',
                vismedAttemptAt: null,
            };
            prisma.bookingSync.upsert.mockResolvedValue(reservedRec);
            // authoritative reread returns PROCESSING — triggers preflight
            prisma.bookingSync.findUnique.mockResolvedValue({
                ...reservedRec,
                ...prismaExtra,
            });

            // Wire a LINKED mapping so preflight path is entered
            prisma.mapping.findFirst.mockResolvedValue({
                id: 'map-1',
                vismedId: 'vdoc-uuid-1',
            });

            return { service, prisma, claim, rateLimiter, body, reservedRec };
        }

        it('adopts existing VisMed appointment and performs zero create POST', async () => {
            const { service, prisma, rateLimiter, body, reservedRec } = await setupPreflightFound();
            const createAppt = jest.fn();
            (service as any).vismedService = { createAppointment: createAppt };

            // Spy on the private preflight to return 'found'
            const preflightSpy = jest
                .spyOn(service as any, 'preflightVismedAppointment')
                .mockResolvedValue({ state: 'found', vismedAppointmentId: 'vm-appt-999' });
            // resolveSkippedAlertForBooking may be called; mock it
            jest.spyOn(service as any, 'resolveSkippedAlertForBooking').mockResolvedValue(undefined);

            const result = await (service as any).handleSlotBooked(conn.clinicId, body.data, body);

            expect(preflightSpy).toHaveBeenCalledTimes(1);
            expect(createAppt).not.toHaveBeenCalled();
            // Final update sets BOOKED with adopted vismedAppointmentId
            expect(prisma.bookingSync.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: reservedRec.id },
                    data: expect.objectContaining({
                        status: 'BOOKED',
                        vismedAppointmentId: 'vm-appt-999',
                        syncedToVismed: true,
                    }),
                }),
            );
            expect(result).toMatchObject({ processed: true });
        });

        it('triggers preflight when PROCESSING status is found under claim', async () => {
            const { service, prisma, body } = await setupPreflightFound();
            (service as any).vismedService = { createAppointment: jest.fn() };

            const preflightSpy = jest
                .spyOn(service as any, 'preflightVismedAppointment')
                .mockResolvedValue({ state: 'found', vismedAppointmentId: 'vm-appt-888' });
            jest.spyOn(service as any, 'resolveSkippedAlertForBooking').mockResolvedValue(undefined);

            await (service as any).handleSlotBooked(conn.clinicId, body.data, body);

            expect(preflightSpy).toHaveBeenCalledTimes(1);
        });

        it('triggers preflight when vismedAttemptAt is set even on FAILED status', async () => {
            const { service, prisma, body, reservedRec } = await setupPreflightFound();
            // Override reread to FAILED with vismedAttemptAt set
            prisma.bookingSync.findUnique.mockResolvedValue({
                ...reservedRec,
                status: 'FAILED',
                vismedAttemptAt: new Date('2026-08-19T10:00:00Z'),
            });
            (service as any).vismedService = { createAppointment: jest.fn() };

            const preflightSpy = jest
                .spyOn(service as any, 'preflightVismedAppointment')
                .mockResolvedValue({ state: 'confirmed_absent' });
            // buildVismedCreatePayload will fail without full DB setup — mock createVismedAppointment
            jest.spyOn(service as any, 'createVismedAppointment').mockResolvedValue({ idpacienteagendamento: 'vm-new-1' });
            jest.spyOn(service as any, 'verifyVismedAppointmentExists').mockResolvedValue('confirmed');
            jest.spyOn(service as any, 'resolveSkippedAlertForBooking').mockResolvedValue(undefined);

            await (service as any).handleSlotBooked(conn.clinicId, body.data, body);

            expect(preflightSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('PROCESSING confirmed_absent → exactly one create + post-create verify under claim', () => {
        it('performs exactly one createVismedAppointment and then verifies, all within the claim', async () => {
            const { service, prisma, claim } = buildService();
            const body = notification();

            const reservedRec = { id: 'sync-proc-absent-1', status: 'PROCESSING', vismedAttemptAt: null };
            prisma.bookingSync.upsert.mockResolvedValue(reservedRec);
            prisma.bookingSync.findUnique.mockResolvedValue(reservedRec);
            prisma.mapping.findFirst.mockResolvedValue({ id: 'map-1', vismedId: 'vdoc-uuid-1' });

            const preflightSpy = jest
                .spyOn(service as any, 'preflightVismedAppointment')
                .mockResolvedValue({ state: 'confirmed_absent' });
            const createSpy = jest
                .spyOn(service as any, 'createVismedAppointment')
                .mockResolvedValue({ idpacienteagendamento: 'vm-new-100' });
            const verifySpy = jest
                .spyOn(service as any, 'verifyVismedAppointmentExists')
                .mockResolvedValue('confirmed');
            jest.spyOn(service as any, 'resolveSkippedAlertForBooking').mockResolvedValue(undefined);

            // Track what is live inside the claim callback
            let createCallsDuringClaim = 0;
            let verifyCallsDuringClaim = 0;
            claim.withClaim.mockImplementationOnce(async (cId, bId, callback) => {
                const result = await callback(new AbortController().signal);
                createCallsDuringClaim = createSpy.mock.calls.length;
                verifyCallsDuringClaim = verifySpy.mock.calls.length;
                return result;
            });

            const result = await (service as any).handleSlotBooked(conn.clinicId, body.data, body);

            expect(createSpy).toHaveBeenCalledTimes(1);
            expect(verifySpy).toHaveBeenCalledTimes(1);
            expect(createCallsDuringClaim).toBe(1);
            expect(verifyCallsDuringClaim).toBe(1);
            expect(result).toMatchObject({ processed: true, vismedCreated: true });
            expect(prisma.bookingSync.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 'sync-proc-absent-1' },
                    data: expect.objectContaining({ status: 'BOOKED', vismedAppointmentId: 'vm-new-100' }),
                }),
            );
        });
    });

    describe('preflight unknown → zero POST, state nonterminal for retry', () => {
        async function runWithPreflightUnknown(reason: string) {
            const { service, prisma } = buildService();
            const body = notification();

            const reservedRec = { id: 'sync-unknown-1', status: 'PROCESSING', vismedAttemptAt: null };
            prisma.bookingSync.upsert.mockResolvedValue(reservedRec);
            prisma.bookingSync.findUnique.mockResolvedValue(reservedRec);
            prisma.mapping.findFirst.mockResolvedValue({ id: 'map-1', vismedId: 'vdoc-uuid-1' });

            const createAppt = jest.fn();
            (service as any).vismedService = { createAppointment: createAppt };

            jest.spyOn(service as any, 'preflightVismedAppointment')
                .mockResolvedValue({ state: 'unknown', reason });

            const err = await (service as any)
                .handleSlotBooked(conn.clinicId, body.data, body)
                .catch((e: any) => e);

            return { err, createAppt, prisma };
        }

        it('partial_read unknown → zero POST', async () => {
            const { err, createAppt } = await runWithPreflightUnknown('partial_read');
            expect(createAppt).not.toHaveBeenCalled();
            expect(err).toBeDefined();
            expect(err.name).toBe('VismedPreflightUnknownError');
        });

        it('multiple_matches unknown → zero POST', async () => {
            const { err, createAppt } = await runWithPreflightUnknown('multiple_matches');
            expect(createAppt).not.toHaveBeenCalled();
            expect(err).toBeDefined();
            expect(err.name).toBe('VismedPreflightUnknownError');
        });

        it('ambiguous_patient unknown → zero POST', async () => {
            const { err, createAppt } = await runWithPreflightUnknown('ambiguous_patient');
            expect(createAppt).not.toHaveBeenCalled();
            expect(err?.name).toBe('VismedPreflightUnknownError');
        });

        it('missing_connection unknown → zero POST', async () => {
            const { err, createAppt } = await runWithPreflightUnknown('missing_connection');
            expect(createAppt).not.toHaveBeenCalled();
            expect(err?.name).toBe('VismedPreflightUnknownError');
        });

        it('preflight unknown does not write FAILED — leaves state nonterminal for retry', async () => {
            const { err, prisma } = await runWithPreflightUnknown('partial_read');
            // FAILED must not be written (would prevent retry from re-preflighting)
            expect(prisma.bookingSync.update).not.toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: 'FAILED' }),
                }),
            );
            expect(err?.name).toBe('VismedPreflightUnknownError');
        });

        it('INCREMENTAL fail-closed no fluxo slot-booked quando a leitura não destrutiva falha: zero POST e zero FAILED', async () => {
            const { service, prisma } = buildService();
            const body = notification();
            const reservedRec = {
                id: 'sync-incremental-partial-read',
                status: 'PROCESSING',
                vismedAttemptAt: null,
            };
            prisma.bookingSync.upsert.mockResolvedValue(reservedRec);
            prisma.bookingSync.findUnique.mockResolvedValue(reservedRec);
            prisma.mapping.findFirst.mockResolvedValue({
                id: 'map-incremental',
                vismedId: 'vdoc-incremental',
            });
            prisma.integrationConnection.findFirst.mockResolvedValue({
                clinicId: conn.clinicId,
                provider: 'vismed',
                domain: INCREMENTAL_VISMED_BASE_URL,
                vismedAppointmentFeedMode: 'INCREMENTAL',
            });
            prisma.vismedDoctor = {
                findUnique: jest.fn().mockResolvedValue({ vismedId: 123 }),
            };
            prisma.vismedUnit = {
                findMany: jest.fn().mockResolvedValue([{ vismedId: 11 }]),
            };
            const getAgendamentos = jest.fn().mockRejectedValue(new Error('timeout'));
            const createAppointment = jest.fn();
            (service as any).vismedService = { getAgendamentos, createAppointment };

            await expect(
                (service as any).handleSlotBooked(conn.clinicId, body.data, body),
            ).rejects.toMatchObject({
                name: 'VismedPreflightUnknownError',
                code: 'VISMED_PREFLIGHT_UNKNOWN',
            });

            expect(getAgendamentos).toHaveBeenCalledWith(
                11,
                INCREMENTAL_VISMED_BASE_URL,
                expect.objectContaining({ syncMode: 'readonly' }),
            );
            expect(createAppointment).not.toHaveBeenCalled();
            expect(prisma.bookingSync.update).not.toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: 'FAILED' }),
                }),
            );
        });
    });

    describe('FAILED without vismedAttemptAt → preserves retry/create without preflight', () => {
        it('does not run preflight when status is FAILED and vismedAttemptAt is null', async () => {
            const { service, prisma } = buildService();
            const body = notification();

            const reservedRec = {
                id: 'sync-failed-nopreflight',
                status: 'FAILED',
                vismedAttemptAt: null,
            };
            prisma.bookingSync.upsert.mockResolvedValue(reservedRec);
            prisma.bookingSync.findUnique.mockResolvedValue(reservedRec);
            prisma.mapping.findFirst.mockResolvedValue({ id: 'map-1', vismedId: 'vdoc-uuid-1' });

            const preflightSpy = jest.spyOn(service as any, 'preflightVismedAppointment');
            jest.spyOn(service as any, 'createVismedAppointment').mockResolvedValue({ idpacienteagendamento: 'vm-retry-1' });
            jest.spyOn(service as any, 'verifyVismedAppointmentExists').mockResolvedValue('confirmed');
            jest.spyOn(service as any, 'resolveSkippedAlertForBooking').mockResolvedValue(undefined);

            await (service as any).handleSlotBooked(conn.clinicId, body.data, body);

            expect(preflightSpy).not.toHaveBeenCalled();
        });

        it('FAILED without vismedAttemptAt sets status to PROCESSING before POST', async () => {
            const { service, prisma } = buildService();
            const body = notification();

            const reservedRec = {
                id: 'sync-failed-promote',
                status: 'FAILED',
                vismedAttemptAt: null,
            };
            prisma.bookingSync.upsert.mockResolvedValue(reservedRec);
            prisma.bookingSync.findUnique.mockResolvedValue(reservedRec);
            prisma.mapping.findFirst.mockResolvedValue({ id: 'map-1', vismedId: 'vdoc-uuid-1' });

            jest.spyOn(service as any, 'createVismedAppointment').mockResolvedValue({ idpacienteagendamento: 'vm-retry-2' });
            jest.spyOn(service as any, 'verifyVismedAppointmentExists').mockResolvedValue('confirmed');
            jest.spyOn(service as any, 'resolveSkippedAlertForBooking').mockResolvedValue(undefined);

            await (service as any).handleSlotBooked(conn.clinicId, body.data, body);

            // Should call update to set PROCESSING before POST, and then the final BOOKED update
            const updateCalls = prisma.bookingSync.update.mock.calls;
            const processingUpdate = updateCalls.find(
                (call: any[]) => call[0]?.data?.status === 'PROCESSING',
            );
            expect(processingUpdate).toBeDefined();
        });
    });

    describe('claim pool_busy / lock_occupied → zero POST, never already_synced', () => {
        it.each([
            ['pool_busy'],
            ['lock_occupied'],
        ] as const)('claim %s defers with zero POST and never resolves already_synced', async (reason) => {
            const { service, prisma, claim } = buildService();
            const body = notification();

            prisma.bookingSync.upsert.mockResolvedValue({ id: 'sync-claim-1', status: 'PROCESSING' });
            claim.withClaim.mockRejectedValueOnce(new ClaimDeferError(reason));
            const createAppt = jest.fn();
            (service as any).vismedService = { createAppointment: createAppt };

            let caught: any;
            try {
                await (service as any).handleSlotBooked(conn.clinicId, body.data, body);
            } catch (e) {
                caught = e;
            }

            expect(caught).toBeDefined();
            expect(caught).toBeInstanceOf(ClaimDeferError);
            expect(caught.reason).toBe(reason);
            expect(createAppt).not.toHaveBeenCalled();
            // Must not resolve as already_synced
            expect(caught?.reason).not.toBe('already_synced');
        });
    });

    describe('mode worker passed by registered queue handler; fail-fast by direct webhook', () => {
        it('registered slot-booked queue handler invokes handleSlotBooked with claimMode worker', async () => {
            const { service, queue } = buildService();

            // Trigger registerJobHandlers (called in onModuleInit)
            (service as any).registerJobHandlers();

            // Find the registered handler for 'slot-booked'
            const registerHandlerCalls: any[] = queue.registerHandler.mock.calls;
            const slotBooked = registerHandlerCalls.find((c) => c[0] === 'slot-booked');
            expect(slotBooked).toBeDefined();
            const handler = slotBooked[1];

            // Spy on the private method to capture options
            const handleSpy = jest.spyOn(service as any, 'handleSlotBooked').mockResolvedValue({});

            const fakePayload = {
                data: notification().data,
                raw: notification(),
            };
            await handler(fakePayload, 'clinic-q');

            expect(handleSpy).toHaveBeenCalledWith(
                'clinic-q',
                fakePayload.data,
                fakePayload.raw,
                { claimMode: 'worker' },
            );
        });

        it('direct handleSlotBooked call (webhook path) defaults to fail-fast mode', async () => {
            const { service, prisma, claim } = buildService();
            const body = notification();

            prisma.bookingSync.upsert.mockResolvedValue({ id: 'sync-ff', status: 'PROCESSING' });
            prisma.bookingSync.findUnique.mockResolvedValue({ id: 'sync-ff', status: 'BOOKED' });

            // Capture the options passed to withClaim
            let capturedOptions: any;
            claim.withClaim.mockImplementationOnce(async (cId, bId, callback, options) => {
                capturedOptions = options;
                return callback(new AbortController().signal);
            });

            await (service as any).handleSlotBooked(conn.clinicId, body.data, body);

            // No explicit claimMode means fail-fast
            expect(capturedOptions?.mode).toBe('fail-fast');
        });

        it('worker mode is forwarded to withClaim when claimMode=worker', async () => {
            const { service, prisma, claim } = buildService();
            const body = notification();

            prisma.bookingSync.upsert.mockResolvedValue({ id: 'sync-worker', status: 'PROCESSING' });
            prisma.bookingSync.findUnique.mockResolvedValue({ id: 'sync-worker', status: 'BOOKED' });

            let capturedOptions: any;
            claim.withClaim.mockImplementationOnce(async (cId, bId, callback, options) => {
                capturedOptions = options;
                return callback(new AbortController().signal);
            });

            await (service as any).handleSlotBooked(conn.clinicId, body.data, body, { claimMode: 'worker' });

            expect(capturedOptions?.mode).toBe('worker');
        });
    });

    describe('session loss scenarios', () => {
        it('session loss before POST → zero POST', async () => {
            const { service, prisma, claim } = buildService();
            const body = notification();

            const reservedRec = { id: 'sync-session-1', status: 'PROCESSING', vismedAttemptAt: null };
            prisma.bookingSync.upsert.mockResolvedValue(reservedRec);
            prisma.bookingSync.findUnique.mockResolvedValue({ ...reservedRec, status: 'FAILED' });
            prisma.mapping.findFirst.mockResolvedValue({ id: 'map-1', vismedId: 'vdoc-uuid-1' });

            const createAppt = jest.fn();
            (service as any).vismedService = { createAppointment: createAppt };

            // Simulate session loss: withClaim callback receives an already-aborted signal
            claim.withClaim.mockImplementationOnce(async (_cId, _bId, callback) => {
                const controller = new AbortController();
                controller.abort(); // signal is aborted before callback proceeds
                throw new ClaimDeferError('session_lost', 'Claim session lost before VisMed POST');
            });

            const err = await (service as any)
                .handleSlotBooked(conn.clinicId, body.data, body)
                .catch((e: any) => e);

            expect(err).toBeInstanceOf(ClaimDeferError);
            expect(err.reason).toBe('session_lost');
            expect(createAppt).not.toHaveBeenCalled();
        });

        it('session loss after POST surfaces uncertain state (ClaimDeferError session_lost)', async () => {
            const { service, prisma, claim } = buildService();
            const body = notification();

            const reservedRec = { id: 'sync-session-2', status: 'PROCESSING', vismedAttemptAt: null };
            prisma.bookingSync.upsert.mockResolvedValue(reservedRec);
            // FAILED so no preflight (vismedAttemptAt null)
            prisma.bookingSync.findUnique.mockResolvedValue({ ...reservedRec, status: 'FAILED', vismedAttemptAt: null });
            prisma.mapping.findFirst.mockResolvedValue({ id: 'map-1', vismedId: 'vdoc-uuid-1' });

            jest.spyOn(service as any, 'createVismedAppointment').mockResolvedValue({ idpacienteagendamento: 'vm-uncertain-1' });
            jest.spyOn(service as any, 'verifyVismedAppointmentExists').mockResolvedValue('confirmed');

            // The claim callback succeeds but the claim itself raises session_lost after
            claim.withClaim.mockImplementationOnce(async (_cId, _bId, callback) => {
                // Run callback so createVismedAppointment is called
                await callback(new AbortController().signal);
                // But then the lock/unlock was uncertain
                throw new ClaimDeferError('session_lost', 'Booking advisory unlock was ambiguous');
            });

            const err = await (service as any)
                .handleSlotBooked(conn.clinicId, body.data, body)
                .catch((e: any) => e);

            expect(err).toBeInstanceOf(ClaimDeferError);
            expect(err.reason).toBe('session_lost');
        });

        it('next execution after session loss preflights before any new create when vismedAttemptAt is set', async () => {
            const { service, prisma } = buildService();
            const body = notification();

            // Simulate a record that has vismedAttemptAt set (previous attempt was uncertain)
            const reservedRec = {
                id: 'sync-session-3',
                status: 'PROCESSING',
                vismedAttemptAt: new Date('2026-08-19T10:00:00Z'),
            };
            prisma.bookingSync.upsert.mockResolvedValue(reservedRec);
            prisma.bookingSync.findUnique.mockResolvedValue(reservedRec);
            prisma.mapping.findFirst.mockResolvedValue({ id: 'map-1', vismedId: 'vdoc-uuid-1' });

            const preflightSpy = jest
                .spyOn(service as any, 'preflightVismedAppointment')
                .mockResolvedValue({ state: 'confirmed_absent' });
            const createSpy = jest
                .spyOn(service as any, 'createVismedAppointment')
                .mockResolvedValue({ idpacienteagendamento: 'vm-after-session-loss' });
            jest.spyOn(service as any, 'verifyVismedAppointmentExists').mockResolvedValue('confirmed');
            jest.spyOn(service as any, 'resolveSkippedAlertForBooking').mockResolvedValue(undefined);

            await (service as any).handleSlotBooked(conn.clinicId, body.data, body);

            // preflight MUST run before the new create
            expect(preflightSpy).toHaveBeenCalledTimes(1);
            // create runs because preflight returned confirmed_absent
            expect(createSpy).toHaveBeenCalledTimes(1);
            // preflight was called before create
            expect(preflightSpy.mock.invocationCallOrder[0])
                .toBeLessThan(createSpy.mock.invocationCallOrder[0]);
        });

        it('session loss during POST marks state via ClaimDeferError and not FAILED', async () => {
            const { service, prisma, claim } = buildService();
            const body = notification();

            const reservedRec = { id: 'sync-during-post', status: 'FAILED', vismedAttemptAt: null };
            prisma.bookingSync.upsert.mockResolvedValue(reservedRec);
            prisma.bookingSync.findUnique.mockResolvedValue(reservedRec);
            prisma.mapping.findFirst.mockResolvedValue({ id: 'map-1', vismedId: 'vdoc-uuid-1' });

            // createVismedAppointment starts but then the signal aborts mid-call
            const controller = new AbortController();
            jest.spyOn(service as any, 'createVismedAppointment').mockImplementationOnce(
                async () => {
                    // abort is triggered during the "call"
                    controller.abort();
                    throw new ClaimDeferError('session_lost', 'Claim session lost after VisMed POST');
                },
            );

            claim.withClaim.mockImplementationOnce(async (_cId, _bId, callback) => {
                return callback(controller.signal);
            });

            const err = await (service as any)
                .handleSlotBooked(conn.clinicId, body.data, body)
                .catch((e: any) => e);

            // The thrown error must be a ClaimDeferError (session_lost), not a generic error
            expect(err).toBeInstanceOf(ClaimDeferError);
            expect(err.reason).toBe('session_lost');
            // FAILED must not be written by the catch block since ClaimDeferError is re-thrown directly
            expect(prisma.bookingSync.update).not.toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: 'FAILED' }),
                }),
            );
        });
    });

    it('consolida de forma transacional um BookingSync VisMed órfão confirmado no preflight', async () => {
        const { service, prisma } = buildService();
        const original = {
            id: 'sync-original',
            clinicId: conn.clinicId,
            doctoraliaBookingId: 'booking-anon-1',
            status: 'PROCESSING',
        };
        const orphan = {
            id: 'sync-vismed-orphan',
            clinicId: conn.clinicId,
            doctoraliaBookingId: null,
            doctoraliaBreakId: null,
            vismedAppointmentId: 'vismed-confirmed-1',
        };
        const tx = {
            $queryRaw: jest.fn().mockResolvedValue([{ id: original.id }, { id: orphan.id }]),
            bookingSync: {
                findUnique: jest.fn(({ where }: any) =>
                    Promise.resolve(where.id === original.id ? original : orphan),
                ),
                delete: jest.fn().mockResolvedValue(orphan),
                update: jest.fn().mockResolvedValue({ ...original, status: 'BOOKED' }),
            },
        };
        prisma.$transaction = jest.fn((callback: any) => callback(tx));

        await (service as any).adoptRecoveredVismedOrphan(
            original,
            orphan.id,
            orphan.vismedAppointmentId,
            'vismed-doctor-uuid',
        );

        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
        expect(tx.bookingSync.delete).toHaveBeenCalledWith({ where: { id: orphan.id } });
        expect(tx.bookingSync.update).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: original.id,
                status: 'PROCESSING',
                doctoraliaBookingId: original.doctoraliaBookingId,
            }),
            data: expect.objectContaining({
                vismedAppointmentId: orphan.vismedAppointmentId,
                status: 'BOOKED',
                syncedToVismed: true,
            }),
        }));
    });

    describe('classificação real do preflight VisMed', () => {
        function setupActualPreflight(responses: Array<any[] | Error>) {
            const built = buildService();
            const { service, prisma } = built;
            prisma.integrationConnection.findFirst.mockResolvedValue({
                clinicId: conn.clinicId,
                provider: 'vismed',
                domain: LEGACY_VISMED_BASE_URL,
            });
            prisma.vismedDoctor = {
                findUnique: jest.fn().mockResolvedValue({ id: 'vdoc-uuid', vismedId: 123 }),
            };
            prisma.vismedUnit = {
                findMany: jest.fn().mockResolvedValue(
                    responses.map((_, index) => ({ vismedId: index + 1 })),
                ),
            };
            prisma.bookingSync.findUnique.mockResolvedValue(null);
            const getAgendamentos = jest.fn();
            for (const response of responses) {
                if (response instanceof Error) getAgendamentos.mockRejectedValueOnce(response);
                else getAgendamentos.mockResolvedValueOnce(response);
            }
            (service as any).vismedService = { getAgendamentos };
            return { ...built, getAgendamentos };
        }

        it('retorna found para uma presença inequívoca', async () => {
            const { service } = setupActualPreflight([[
                {
                    idpacienteagendamento: 456,
                    idprofissional: 123,
                    dataagendamento: '2026-08-20',
                    horarioagendamento: '09:00',
                    nomepaciente: 'Paciente Anonimizado',
                },
            ]]);

            await expect((service as any).preflightVismedAppointment(
                conn.clinicId,
                'vdoc-uuid',
                notification().data.visit_booking,
                'sync-original',
                new AbortController().signal,
            )).resolves.toEqual({
                state: 'found',
                vismedAppointmentId: '456',
                orphanBookingSyncId: undefined,
            });
        });

        it('retorna confirmed_absent somente quando todas as unidades respondem arrays completos', async () => {
            const { service } = setupActualPreflight([[], []]);

            await expect((service as any).preflightVismedAppointment(
                conn.clinicId,
                'vdoc-uuid',
                notification().data.visit_booking,
                'sync-original',
                new AbortController().signal,
            )).resolves.toEqual({ state: 'confirmed_absent' });
        });

        it('retorna unknown quando qualquer unidade falha', async () => {
            const { service } = setupActualPreflight([[], new Error('timeout')]);

            await expect((service as any).preflightVismedAppointment(
                conn.clinicId,
                'vdoc-uuid',
                notification().data.visit_booking,
                'sync-original',
                new AbortController().signal,
            )).resolves.toEqual({ state: 'unknown', reason: 'partial_read' });
        });

        it('retorna unknown quando há mais de um match conservador', async () => {
            const match = (id: number) => ({
                idpacienteagendamento: id,
                idprofissional: 123,
                dataagendamento: '2026-08-20',
                horarioagendamento: '09:00',
                nomepaciente: 'Paciente Anonimizado',
            });
            const { service } = setupActualPreflight([[match(456), match(457)]]);

            await expect((service as any).preflightVismedAppointment(
                conn.clinicId,
                'vdoc-uuid',
                notification().data.visit_booking,
                'sync-original',
                new AbortController().signal,
            )).resolves.toEqual({ state: 'unknown', reason: 'multiple_matches' });
        });

        it('no INCREMENTAL usa readonly e preserva a classificação conservadora', async () => {
            const { service, prisma, getAgendamentos } = setupActualPreflight([[]]);
            prisma.integrationConnection.findFirst.mockResolvedValue({
                clinicId: conn.clinicId,
                provider: 'vismed',
                domain: INCREMENTAL_VISMED_BASE_URL,
                vismedAppointmentFeedMode: 'INCREMENTAL',
            });

            await expect((service as any).preflightVismedAppointment(
                conn.clinicId,
                'vdoc-uuid',
                notification().data.visit_booking,
                'sync-original',
                new AbortController().signal,
            )).resolves.toEqual({ state: 'confirmed_absent' });

            expect(getAgendamentos).toHaveBeenCalledWith(
                1,
                INCREMENTAL_VISMED_BASE_URL,
                expect.objectContaining({
                    dataini: '20/08/2026',
                    datafim: '20/08/2026',
                    profissional: 123,
                    syncMode: 'readonly',
                }),
            );
        });

        it('no INCREMENTAL retorna found para um único match sem consumir a pendência', async () => {
            const { service, prisma, getAgendamentos } = setupActualPreflight([[
                {
                    idpacienteagendamento: 456,
                    idprofissional: 123,
                    dataagendamento: '2026-08-20',
                    horarioagendamento: '09:00',
                    nomepaciente: 'Paciente Anonimizado',
                },
            ]]);
            prisma.integrationConnection.findFirst.mockResolvedValue({
                clinicId: conn.clinicId,
                provider: 'vismed',
                domain: INCREMENTAL_VISMED_BASE_URL,
                vismedAppointmentFeedMode: 'INCREMENTAL',
            });

            await expect((service as any).preflightVismedAppointment(
                conn.clinicId,
                'vdoc-uuid',
                notification().data.visit_booking,
                'sync-original',
                new AbortController().signal,
            )).resolves.toEqual({
                state: 'found',
                vismedAppointmentId: '456',
                orphanBookingSyncId: undefined,
            });
            expect(getAgendamentos).toHaveBeenCalledWith(
                1,
                INCREMENTAL_VISMED_BASE_URL,
                expect.objectContaining({ syncMode: 'readonly' }),
            );
        });

        it.each([
            ['resposta inválida', [{ invalid: true }], 'partial_read'],
            ['timeout', [new Error('timeout')], 'partial_read'],
        ])('no INCREMENTAL mantém %s como unknown', async (_label, responses, reason) => {
            const { service, prisma } = setupActualPreflight(responses as Array<any[] | Error>);
            prisma.integrationConnection.findFirst.mockResolvedValue({
                clinicId: conn.clinicId,
                provider: 'vismed',
                domain: INCREMENTAL_VISMED_BASE_URL,
                vismedAppointmentFeedMode: 'INCREMENTAL',
            });

            await expect((service as any).preflightVismedAppointment(
                conn.clinicId,
                'vdoc-uuid',
                notification().data.visit_booking,
                'sync-original',
                new AbortController().signal,
            )).resolves.toEqual({ state: 'unknown', reason });
        });

        it('no INCREMENTAL mantém a verificação pós-POST como unverified sem consumir o feed', async () => {
            const { service, prisma, getAgendamentos } = setupActualPreflight([[]]);
            prisma.integrationConnection.findFirst.mockResolvedValue({
                clinicId: conn.clinicId,
                provider: 'vismed',
                domain: INCREMENTAL_VISMED_BASE_URL,
                vismedAppointmentFeedMode: 'INCREMENTAL',
            });

            await expect((service as any).verifyVismedAppointmentExists(
                conn.clinicId,
                'vdoc-uuid',
                'created-id-1',
                notification().data.visit_booking,
                new AbortController().signal,
            )).resolves.toBe('unverified');

            expect(getAgendamentos).not.toHaveBeenCalled();
        });

        it('no LEGACY preserva a leitura completa do feed para confirmar ausência pós-POST', async () => {
            const { service, getAgendamentos } = setupActualPreflight([[]]);

            await expect((service as any).verifyVismedAppointmentExists(
                conn.clinicId,
                'vdoc-uuid',
                'missing-legacy-id',
                notification().data.visit_booking,
                new AbortController().signal,
            )).resolves.toBe('not_found');

            expect(getAgendamentos).toHaveBeenCalledTimes(1);
        });
    });
});
