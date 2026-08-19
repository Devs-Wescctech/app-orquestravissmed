import { BookingSyncService } from './booking-sync.service';
import { ClinicConcurrencyGuard } from './clinic-concurrency-guard';
import { DoctoraliaMetricsService } from '../metrics/doctoralia-metrics.service';
import { DoctoraliaCircuitOpenError } from '../integrations/doctoralia-circuit-breaker';
import { DoctoraliaQueueFullError } from '../integrations/doctoralia-queue.errors';

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
    };
    const prisma = {
        integrationConnection: {
            findFirst: jest.fn().mockResolvedValue(conn),
        },
        bookingSync: {
            upsert: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
    );
    return { service, prisma, queue, rateLimiter, guard, client, metrics };
}

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
});