import { BookingSafetySweepService } from './booking-safety-sweep.service';
import { ClinicConcurrencyGuard } from './clinic-concurrency-guard';
import { DoctoraliaMetricsService, getDoctoraliaMetricsService } from '../metrics/doctoralia-metrics.service';

describe('BookingSafetySweepService', () => {
    let service: BookingSafetySweepService;
    let prisma: any;
    let docplanner: any;
    let queue: any;
    let rateLimiter: any;
    let client: any;
    let concurrencyGuard: ClinicConcurrencyGuard;

    const conn = {
        clinicId: 'clinic-1',
        provider: 'doctoralia',
        status: 'connected',
        clientId: 'cid',
        clientSecret: 'secret',
        domain: 'www.doctoralia.com.br',
    };

    const mapping = {
        clinicId: 'clinic-1',
        entityType: 'DOCTOR',
        status: 'LINKED',
        externalId: 'doc-123',
        vismedId: 'vismed-uuid',
        conflictData: { facilityId: 'fac-1', address: { id: 'addr-1' } },
    };

    beforeEach(() => {
        // Instancia o serviço de métricas; o construtor registra a instância global via _globalInstance.
        new DoctoraliaMetricsService();
        client = { getBookings: jest.fn() };
        prisma = {
            integrationConnection: { findMany: jest.fn().mockResolvedValue([conn]) },
            mapping: { findMany: jest.fn().mockResolvedValue([mapping]) },
            doctoraliaDoctor: { findMany: jest.fn().mockResolvedValue([]) },
            bookingSync: { findMany: jest.fn() },
        };
        // 1ª chamada em sweepClinic é a lista de bookings conhecidos; a 2ª é a fonte 3 de endereços.
        prisma.bookingSync.findMany.mockImplementation((args: any) =>
            Promise.resolve(args?.select?.doctoraliaBookingId ? [] : []),
        );
        docplanner = { createClient: jest.fn().mockReturnValue(client) };
        queue = { enqueueBatch: jest.fn().mockResolvedValue(undefined) };
        rateLimiter = { acquire: jest.fn().mockResolvedValue(undefined) };
        concurrencyGuard = new ClinicConcurrencyGuard();
        service = new BookingSafetySweepService(prisma, docplanner, queue, rateLimiter, concurrencyGuard);
    });

    const newBooking = (id: string, extra: any = {}) => ({
        id,
        start_at: '2026-08-11T08:00:00-03:00',
        end_at: '2026-08-11T08:30:00-03:00',
        duration: 30,
        patient: { name: 'Paciente', surname: 'Teste' },
        ...extra,
    });

    it('detecta booking novo fora da janela de reconciliação e enfileira pelo handler slot-booked', async () => {
        client.getBookings.mockResolvedValue({ _items: [newBooking('225170337')] });

        const enqueued = await service.sweepClinic(conn);

        expect(enqueued).toBe(1);
        expect(queue.enqueueBatch).toHaveBeenCalledTimes(1);
        const jobs = queue.enqueueBatch.mock.calls[0][0];
        expect(jobs).toHaveLength(1);
        expect(jobs[0].type).toBe('slot-booked');
        expect(jobs[0].clinicId).toBe('clinic-1');
        // Mesma dedupKey do polling normal → notificação atrasada não duplica.
        expect(jobs[0].dedupKey).toBe('clinic-1:slot-booked:225170337');
        expect(jobs[0].payload.data.visit_booking.id).toBe('225170337');
        expect(jobs[0].payload.data.doctor.id).toBe('doc-123');
        expect(jobs[0].payload.data.facility.id).toBe('fac-1');
        expect(jobs[0].payload.data.address.id).toBe('addr-1');
        expect(jobs[0].payload.raw.source).toBe('safety-sweep');
        expect(rateLimiter.acquire).toHaveBeenCalledWith('doctoralia');
    });

    it('não duplica booking já existente em BookingSync (idempotência por doctoraliaBookingId)', async () => {
        prisma.bookingSync.findMany.mockImplementation((args: any) =>
            Promise.resolve(
                args?.select?.doctoraliaBookingId ? [{ doctoraliaBookingId: '225170337' }] : [],
            ),
        );
        client.getBookings.mockResolvedValue({ _items: [newBooking('225170337')] });

        const enqueued = await service.sweepClinic(conn);

        expect(enqueued).toBe(0);
        expect(queue.enqueueBatch).not.toHaveBeenCalled();
    });

    it('não cria booking cancelado na Doctoralia', async () => {
        client.getBookings.mockResolvedValue({
            _items: [
                newBooking('111', { status: 'canceled' }),
                newBooking('222', { cancelled_at: '2026-07-20T10:00:00-03:00' }),
            ],
        });

        const enqueued = await service.sweepClinic(conn);

        expect(enqueued).toBe(0);
        expect(queue.enqueueBatch).not.toHaveBeenCalled();
    });

    it('deduplica o mesmo booking visto em mais de um endereço', async () => {
        const mapping2 = { ...mapping, conflictData: { facilityId: 'fac-1', address: { id: 'addr-2' } } };
        prisma.mapping.findMany.mockResolvedValue([mapping, mapping2]);
        client.getBookings.mockResolvedValue({ _items: [newBooking('333')] });

        const enqueued = await service.sweepClinic(conn);

        expect(client.getBookings).toHaveBeenCalledTimes(2);
        expect(enqueued).toBe(1);
    });

    it('falha em um endereço não derruba a varredura dos demais', async () => {
        const mapping2 = { ...mapping, conflictData: { facilityId: 'fac-1', address: { id: 'addr-2' } } };
        prisma.mapping.findMany.mockResolvedValue([mapping, mapping2]);
        client.getBookings
            .mockRejectedValueOnce(new Error('timeout'))
            .mockResolvedValueOnce({ _items: [newBooking('444')] });

        const enqueued = await service.sweepClinic(conn);

        expect(enqueued).toBe(1);
    });

    it('sem médicos vinculados não chama a API da Doctoralia', async () => {
        prisma.mapping.findMany.mockResolvedValue([]);

        const enqueued = await service.sweepClinic(conn);

        expect(enqueued).toBe(0);
        expect(client.getBookings).not.toHaveBeenCalled();
    });

    it('runSweepAllClinics varre clínicas conectadas e soma os enfileirados', async () => {
        client.getBookings.mockResolvedValue({ _items: [newBooking('555')] });

        const result = await service.runSweepAllClinics();

        expect(result.clinics).toBe(1);
        expect(result.enqueued).toBe(1);
    });

    it('runSweepAllClinics pula clínica cujo SAFETY_SWEEP já está ativo (guard adquirido externamente)', async () => {
        client.getBookings.mockResolvedValue({ _items: [newBooking('666')] });

        // Simula sweep automático já em andamento: adquire o guard antes de chamar runSweepAllClinics
        concurrencyGuard.tryAcquire('clinic-1', 'SAFETY_SWEEP');
        try {
            const result = await service.runSweepAllClinics();
            expect(result.clinics).toBe(0);
            expect(result.enqueued).toBe(0);
            expect(client.getBookings).not.toHaveBeenCalled();
            expect(getDoctoraliaMetricsService()!.getConcurrencySkipCounts().SWEEP_SKIPPED_SWEEP_ACTIVE).toBe(1);
        } finally {
            concurrencyGuard.release('clinic-1', 'SAFETY_SWEEP');
        }
    });

    it('runSweepAllClinics pula clínica com POLLING ativo e registra SWEEP_SKIPPED_POLL_ACTIVE', async () => {
        client.getBookings.mockResolvedValue({ _items: [newBooking('777')] });

        concurrencyGuard.tryAcquire('clinic-1', 'POLLING');
        try {
            const result = await service.runSweepAllClinics();
            expect(result.clinics).toBe(0);
            expect(result.enqueued).toBe(0);
            expect(client.getBookings).not.toHaveBeenCalled();
            expect(getDoctoraliaMetricsService()!.getConcurrencySkipCounts().SWEEP_SKIPPED_POLL_ACTIVE).toBe(1);
        } finally {
            concurrencyGuard.release('clinic-1', 'POLLING');
        }
    });

    it('Task 133: runSweepAllClinics pula com SWEEP_SKIPPED_GLOBAL_SYNC_PENDING quando há reserva de prioridade (nunca fallback enganoso)', async () => {
        client.getBookings.mockResolvedValue({ _items: [newBooking('888')] });

        // Reserva pendente, NENHUM subsistema ativo
        concurrencyGuard.requestPriority('clinic-1', () => {});
        try {
            const result = await service.runSweepAllClinics();
            expect(result.clinics).toBe(0);
            expect(result.enqueued).toBe(0);
            expect(client.getBookings).not.toHaveBeenCalled();
            const counts = getDoctoraliaMetricsService()!.getConcurrencySkipCounts();
            expect(counts.SWEEP_SKIPPED_GLOBAL_SYNC_PENDING).toBe(1);
            expect(counts.SWEEP_SKIPPED_SWEEP_ACTIVE).toBe(0);
            expect(counts.SWEEP_SKIPPED_POLL_ACTIVE).toBe(0);
        } finally {
            concurrencyGuard.clearPriority('clinic-1');
        }
    });

    it('Task 133: startManualSweep descartada com SWEEP_SKIPPED_GLOBAL_SYNC_PENDING quando há reserva de prioridade', async () => {
        concurrencyGuard.requestPriority('clinic-1', () => {});
        try {
            service.startManualSweep(conn);
            await new Promise(res => setImmediate(res));
            await new Promise(res => setImmediate(res));
            const status = service.getManualSweepStatus('clinic-1') as any;
            expect(status.running).toBe(false);
            expect(client.getBookings).not.toHaveBeenCalled();
            const counts = getDoctoraliaMetricsService()!.getConcurrencySkipCounts();
            expect(counts.SWEEP_SKIPPED_GLOBAL_SYNC_PENDING).toBe(1);
            expect(counts.SWEEP_SKIPPED_SWEEP_ACTIVE).toBe(0);
        } finally {
            concurrencyGuard.clearPriority('clinic-1');
        }
    });

    it('startManualSweep redefine running=false quando o SAFETY_SWEEP guard já está adquirido (sweep automático ativo)', async () => {
        // Adquire o guard externamente (simula sweep automático em andamento)
        concurrencyGuard.tryAcquire('clinic-1', 'SAFETY_SWEEP');
        try {
            const started = service.startManualSweep(conn);
            expect(started.started).toBe(true); // resposta imediata à UI

            // Aguarda o fire-and-forget detectar o conflito
            await new Promise(resolve => setTimeout(resolve, 20));

            const status = service.getManualSweepStatus('clinic-1');
            // Estado NÃO deve ficar travado em running=true
            expect(status.running).toBe(false);
            expect(status.error).toBeDefined();
            // Nenhuma chamada à Doctoralia deve ter sido feita
            expect(client.getBookings).not.toHaveBeenCalled();
            expect(getDoctoraliaMetricsService()!.getConcurrencySkipCounts().SWEEP_SKIPPED_SWEEP_ACTIVE).toBe(1);
        } finally {
            concurrencyGuard.release('clinic-1', 'SAFETY_SWEEP');
        }
    });

    it('startManualSweep redefine running=false quando o POLLING está ativo para a clínica', async () => {
        concurrencyGuard.tryAcquire('clinic-1', 'POLLING');
        try {
            const started = service.startManualSweep(conn);
            expect(started.started).toBe(true);

            await new Promise(resolve => setTimeout(resolve, 20));

            const status = service.getManualSweepStatus('clinic-1');
            expect(status.running).toBe(false);
            expect(status.error).toBeDefined();
            expect(client.getBookings).not.toHaveBeenCalled();
        } finally {
            concurrencyGuard.release('clinic-1', 'POLLING');
        }
    });
});
