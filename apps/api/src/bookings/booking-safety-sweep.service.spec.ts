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
        // Única chamada em sweepClinic: lista de bookings conhecidos (idempotência).
        prisma.bookingSync.findMany.mockResolvedValue([]);
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

    it('runSweepAllClinics adia e recupera a clínica cujo SAFETY_SWEEP já está ativo', async () => {
        jest.useFakeTimers();
        client.getBookings.mockResolvedValue({ _items: [newBooking('666')] });

        concurrencyGuard.tryAcquire('clinic-1', 'SAFETY_SWEEP');
        try {
            const result = await service.runSweepAllClinics();
            expect(result.clinics).toBe(0);
            expect(result.enqueued).toBe(0);
            expect(client.getBookings).not.toHaveBeenCalled();
            expect(getDoctoraliaMetricsService()!.getConcurrencySkipCounts().SWEEP_SKIPPED_SWEEP_ACTIVE).toBe(1);
            concurrencyGuard.release('clinic-1', 'SAFETY_SWEEP');
            await jest.advanceTimersByTimeAsync(5_000);
            expect(client.getBookings).toHaveBeenCalledTimes(1);
            expect((getDoctoraliaMetricsService()!.getBaseline() as any).safetySweepRetry.recovered).toBe(1);
        } finally {
            service.onModuleDestroy();
            jest.useRealTimers();
        }
    });

    // Task 223: POLLING VisMed já NÃO bloqueia o sweep — sweep executa concorrentemente
    it('Task 223: runSweepAllClinics executa concorrentemente com POLLING VisMed ativo (não adia)', async () => {
        client.getBookings.mockResolvedValue({ _items: [newBooking('777')] });

        // POLLING ativo — sob Task 223, o sweep PODE rodar em paralelo
        concurrencyGuard.tryAcquire('clinic-1', 'POLLING');
        try {
            const result = await service.runSweepAllClinics();
            // Sweep executa com POLLING ativo (coexistência Task 223)
            expect(result.clinics).toBe(1);
            expect(result.enqueued).toBe(1);
            expect(client.getBookings).toHaveBeenCalledTimes(1);
            // Sem retry agendado — não houve conflito
            expect((service as any).pendingSweepRetries.size).toBe(0);
            // Nenhum skip de POLL por SWEEP ou vice-versa
            const counts = getDoctoraliaMetricsService()!.getConcurrencySkipCounts();
            expect(counts.SWEEP_SKIPPED_POLL_ACTIVE).toBe(0);
            expect(counts.POLL_SKIPPED_SWEEP_ACTIVE).toBe(0);
        } finally {
            concurrencyGuard.release('clinic-1', 'POLLING');
        }
    });

    // Task 223: log técnico "start-during-poll" quando sweep inicia com polling ativo
    it('Task 223: sweep loga SWEEP_STARTED_DURING_POLL quando POLLING VisMed está ativo', async () => {
        client.getBookings.mockResolvedValue({ _items: [] });

        const logSpy = jest.spyOn((service as any).logger, 'log');

        concurrencyGuard.tryAcquire('clinic-1', 'POLLING');
        try {
            await service.runSweepAllClinics();
            const duringPollLog = logSpy.mock.calls.find(
                call => typeof call[0] === 'string' && call[0].includes('SWEEP_STARTED_DURING_POLL'),
            );
            expect(duringPollLog).toBeDefined();
        } finally {
            concurrencyGuard.release('clinic-1', 'POLLING');
        }
    });

    // Task 223: latch test — sweep descobre e enfileira bookings enquanto polling está ativo
    it('Task 223 (latch): sweep descobre e enfileira bookings enquanto POLLING VisMed está ativo', async () => {
        client.getBookings.mockResolvedValue({ _items: [newBooking('LATCH-001')] });

        let sweepResult!: { ran: boolean; enqueued: number };
        let pollRelease!: () => void;
        const pollDone = new Promise<void>(res => { pollRelease = res; });

        // Simula POLLING em andamento (não-finalizado) durante toda a varredura
        concurrencyGuard.tryAcquire('clinic-1', 'POLLING');

        // Inicia o sweep concorrentemente (Task 223: não precisa esperar o poll)
        const sweepPromise = service.runSweepAllClinics();
        // Enquanto o poll ainda está "rodando", o sweep pode completar
        sweepResult = await sweepPromise;

        // O booking foi descoberto e enfileirado mesmo com polling ativo
        expect(sweepResult.clinics).toBe(1);
        expect(sweepResult.enqueued).toBe(1);
        expect(queue.enqueueBatch).toHaveBeenCalledTimes(1);
        const jobs = queue.enqueueBatch.mock.calls[0][0];
        expect(jobs[0].dedupKey).toBe('clinic-1:slot-booked:LATCH-001');

        // Poll pode terminar depois sem problemas
        concurrencyGuard.release('clinic-1', 'POLLING');
        pollRelease();
        await pollDone;
    });

    it('Task 133: runSweepAllClinics adia com GLOBAL_SYNC_PENDING e recupera após liberar a reserva', async () => {
        jest.useFakeTimers();
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
            concurrencyGuard.clearPriority('clinic-1');
            await jest.advanceTimersByTimeAsync(5_000);
            expect(client.getBookings).toHaveBeenCalledTimes(1);
        } finally {
            service.onModuleDestroy();
            jest.useRealTimers();
        }
    });

    it('Task 133: startManualSweep fica adiada com GLOBAL_SYNC_PENDING e conclui após liberar', async () => {
        jest.useFakeTimers();
        concurrencyGuard.requestPriority('clinic-1', () => {});
        try {
            service.startManualSweep(conn);
            await Promise.resolve();
            const deferred = service.getManualSweepStatus('clinic-1') as any;
            expect(deferred.running).toBe(true);
            expect(client.getBookings).not.toHaveBeenCalled();
            const counts = getDoctoraliaMetricsService()!.getConcurrencySkipCounts();
            expect(counts.SWEEP_SKIPPED_GLOBAL_SYNC_PENDING).toBe(1);
            expect(counts.SWEEP_SKIPPED_SWEEP_ACTIVE).toBe(0);
            concurrencyGuard.clearPriority('clinic-1');
            await jest.advanceTimersByTimeAsync(5_000);
            const recovered = service.getManualSweepStatus('clinic-1') as any;
            expect(recovered.running).toBe(false);
            expect(recovered.enqueued).toBe(0);
            expect(client.getBookings).toHaveBeenCalledTimes(1);
        } finally {
            service.onModuleDestroy();
            jest.useRealTimers();
        }
    });

    it('startManualSweep mantém um único retry pendente quando o sweep automático está ativo', async () => {
        jest.useFakeTimers();
        concurrencyGuard.tryAcquire('clinic-1', 'SAFETY_SWEEP');
        try {
            const started = service.startManualSweep(conn);
            expect(started.started).toBe(true);
            await Promise.resolve();
            expect(service.getManualSweepStatus('clinic-1').running).toBe(true);
            expect(client.getBookings).not.toHaveBeenCalled();
            expect(getDoctoraliaMetricsService()!.getConcurrencySkipCounts().SWEEP_SKIPPED_SWEEP_ACTIVE).toBe(1);
            expect((service as any).pendingSweepRetries.size).toBe(1);

            concurrencyGuard.release('clinic-1', 'SAFETY_SWEEP');
            await jest.advanceTimersByTimeAsync(5_000);
            expect(service.getManualSweepStatus('clinic-1').running).toBe(false);
            expect((service as any).pendingSweepRetries.size).toBe(0);
        } finally {
            service.onModuleDestroy();
            jest.useRealTimers();
        }
    });

    // Task 223: startManualSweep executa imediatamente com POLLING ativo (não adia)
    it('Task 223: startManualSweep executa imediatamente com POLLING ativo (coexistência)', async () => {
        client.getBookings.mockResolvedValue({ _items: [newBooking('MANUAL-001')] });

        concurrencyGuard.tryAcquire('clinic-1', 'POLLING');
        try {
            const started = service.startManualSweep(conn);
            expect(started.started).toBe(true);
            // Processa a tarefa fire-and-forget
            await new Promise(resolve => setImmediate(resolve));
            await Promise.resolve();
            await Promise.resolve();
            // O sweep pode rodar concorrentemente com POLLING
            // Aguarda completar (o sweep é rápido pois não há bloqueio)
            await new Promise(resolve => setTimeout(resolve, 50));
            // Sem retry agendado — não houve conflito
            expect((service as any).pendingSweepRetries.size).toBe(0);
        } finally {
            concurrencyGuard.release('clinic-1', 'POLLING');
        }
    });

    // Cenário grande: ~3000 bookings conhecidos — idempotência funciona em escala
    it('Task 223 (large known set): ~3000 bookings conhecidos — nenhum é re-enfileirado', async () => {
        const KNOWN_COUNT = 3000;
        const knownIds = Array.from({ length: KNOWN_COUNT }, (_, i) => `booking-${i}`);
        const knownRecords = knownIds.map(id => ({
            doctoraliaBookingId: id,
            origin: 'DOCTORALIA',
            patientName: 'Paciente',
        }));

        prisma.bookingSync.findMany.mockResolvedValue(knownRecords);
        // API retorna todos os 3000 bookings conhecidos + 1 novo
        client.getBookings.mockResolvedValue({
            _items: [
                ...knownIds.map(id => newBooking(id)),
                newBooking('booking-NEW'),
            ],
        });

        const enqueued = await service.sweepClinic(conn);

        // Apenas o booking novo é enfileirado
        expect(enqueued).toBe(1);
        expect(queue.enqueueBatch).toHaveBeenCalledTimes(1);
        const jobs = queue.enqueueBatch.mock.calls[0][0];
        expect(jobs).toHaveLength(1);
        expect(jobs[0].dedupKey).toBe('clinic-1:slot-booked:booking-NEW');
    });

    // Task 223: com ~3000 conhecidos e polling ativo, sweep ainda descobre bookings novos
    it('Task 223 + large set: sweep descobre booking novo com 3000 conhecidos e POLLING ativo', async () => {
        const KNOWN_COUNT = 3000;
        const knownIds = Array.from({ length: KNOWN_COUNT }, (_, i) => `known-${i}`);
        prisma.bookingSync.findMany.mockResolvedValue(
            knownIds.map(id => ({ doctoraliaBookingId: id, origin: 'DOCTORALIA', patientName: 'X' })),
        );
        client.getBookings.mockResolvedValue({
            _items: [
                ...knownIds.map(id => newBooking(id)),
                newBooking('NEW-DURING-POLL'),
            ],
        });

        concurrencyGuard.tryAcquire('clinic-1', 'POLLING');
        try {
            const result = await service.runSweepAllClinics();
            expect(result.enqueued).toBe(1);
            const jobs = queue.enqueueBatch.mock.calls[0][0];
            expect(jobs[0].dedupKey).toBe('clinic-1:slot-booked:NEW-DURING-POLL');
        } finally {
            concurrencyGuard.release('clinic-1', 'POLLING');
        }
    });
});
