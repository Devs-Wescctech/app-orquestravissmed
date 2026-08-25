import { BookingSyncService } from './booking-sync.service';
import { ClinicConcurrencyGuard } from './clinic-concurrency-guard';
import { normalizeVismedAppointmentFeedMode } from './vismed-appointment-feed-mode';
import { normalizeVismedAppointmentRecoveryIds } from './vismed-appointment-feed-recovery';

const clinicId = 'clinic-feed-mode';

const appointment = (id = 'vismed-appointment-1') => ({
    idpacienteagendamento: id,
    idprofissional: '123',
    dataagendamento: '2026-08-20',
    horarioagendamento: '09:00',
    horarioagendamentofinal: '09:30',
});

function buildService(options: {
    feedMode?: unknown;
    response?: any;
} = {}) {
    const conn = {
        clinicId,
        provider: 'vismed',
        status: 'connected',
        clientId: '42',
        domain: 'https://vismed.test',
        ...(options.feedMode === undefined
            ? {}
            : { vismedAppointmentFeedMode: options.feedMode }),
    };
    const prisma = {
        integrationConnection: {
            findFirst: jest.fn().mockResolvedValue(conn),
        },
        vismedUnit: {
            findMany: jest.fn().mockResolvedValue([{ vismedId: 11 }]),
        },
    } as any;
    const vismedService = {
        getAgendamentos: jest.fn().mockResolvedValue(
            options.response === undefined ? [appointment()] : options.response,
        ),
    };
    const service = new BookingSyncService(
        prisma,
        {} as any,
        vismedService as any,
        {} as any,
        {} as any,
        {} as any,
        new ClinicConcurrencyGuard(),
        {} as any,
    );
    const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
    (service as any).logger = logger;
    const capture = jest.spyOn(service as any, 'captureVismedDisappearanceSnapshot')
        .mockResolvedValue([{ id: 'known-booking-sync', vismedAppointmentId: 'known-vismed-id' }]);
    const upsert = jest.spyOn(service as any, 'upsertVismedAppointment').mockResolvedValue(true);
    const reconcileDisappeared = jest.spyOn(service as any, 'reconcileDisappearedFromVismed')
        .mockResolvedValue(undefined);
    const reconcileUnlinked = jest.spyOn(service as any, 'reconcileUnlinkedWithDoctoralia')
        .mockResolvedValue(undefined);
    const reconcileCancelled = jest.spyOn(service as any, 'reconcileCancelledOnDoctoralia')
        .mockResolvedValue(undefined);
    const reconcileWithoutVismedId = jest.spyOn(service as any, 'reconcileBookedWithoutVismedId')
        .mockResolvedValue(undefined);
    const propagateCancellation = jest.spyOn(service as any, 'propagateVismedCancellationToDoctoralia')
        .mockResolvedValue(undefined);
    const syncBreak = jest.spyOn(service as any, 'syncDoctoraliaBreak').mockResolvedValue(undefined);

    return {
        service,
        conn,
        prisma,
        vismedService,
        logger,
        capture,
        upsert,
        reconcileDisappeared,
        reconcileUnlinked,
        reconcileCancelled,
        reconcileWithoutVismedId,
        propagateCancellation,
        syncBreak,
    };
}

describe('normalizeVismedAppointmentFeedMode', () => {
    it.each([
        ['campo ausente', undefined],
        ['null', null],
        ['vazio', ''],
        ['valor desconhecido', 'FUTURE_MODE'],
    ])('resolve %s como LEGACY', (_label, value) => {
        expect(normalizeVismedAppointmentFeedMode(value).mode).toBe('LEGACY');
    });

    it('seleciona INCREMENTAL apenas quando o valor é explícito e reconhecido', () => {
        expect(normalizeVismedAppointmentFeedMode('INCREMENTAL')).toEqual({
            mode: 'INCREMENTAL',
            invalidConfiguration: false,
        });
        expect(normalizeVismedAppointmentFeedMode('incremental')).toEqual({
            mode: 'LEGACY',
            invalidConfiguration: true,
        });
    });
});

describe('normalizeVismedAppointmentRecoveryIds', () => {
    it('aceita apenas IDs identificáveis e deduplica o lote da futura reentrega', () => {
        expect(normalizeVismedAppointmentRecoveryIds([
            ' appt-1 ',
            42,
            '',
            null,
            undefined,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            { id: 'not-an-id' },
            'appt-1',
            42,
        ])).toEqual(['appt-1', '42']);
    });
});

describe('BookingSyncService — polling VisMed por contrato de feed', () => {
    it('mantém LEGACY sem configuração: captura snapshot, agrega IDs e reconcilia após processar', async () => {
        const {
            service, conn, capture, upsert, reconcileDisappeared, logger,
        } = buildService();

        await service.pollVismedClinic(conn);

        expect(capture).toHaveBeenCalledTimes(1);
        expect(upsert).toHaveBeenCalledWith(
            clinicId,
            appointment(),
            { idEmpresaGestora: 42, baseUrl: 'https://vismed.test' },
        );
        expect(reconcileDisappeared).toHaveBeenCalledWith(
            clinicId,
            new Set(['vismed-appointment-1']),
            expect.any(Date),
            expect.any(Date),
            [{ vismedId: 11 }],
            'https://vismed.test',
            expect.any(String),
            expect.any(String),
            [{ id: 'known-booking-sync', vismedAppointmentId: 'known-vismed-id' }],
        );
        expect(logger.log).toHaveBeenCalledWith(
            expect.stringContaining('mode=LEGACY'),
        );
    });

    it('preserva [] válido em LEGACY: zero upserts ainda permite reconciliação por desaparecimento', async () => {
        const {
            service, conn, upsert, reconcileDisappeared,
        } = buildService({ feedMode: 'LEGACY', response: [] });

        await service.pollVismedClinic(conn);

        expect(upsert).not.toHaveBeenCalled();
        expect(reconcileDisappeared).toHaveBeenCalledWith(
            clinicId,
            new Set(),
            expect.any(Date),
            expect.any(Date),
            expect.any(Array),
            expect.any(String),
            expect.any(String),
            expect.any(String),
            expect.any(Array),
        );
    });

    it('avisa sobre configuração inválida e continua no ramo LEGACY', async () => {
        const {
            service, conn, capture, reconcileDisappeared, logger,
        } = buildService({ feedMode: 'incremental', response: [] });

        await service.pollVismedClinic(conn);

        expect(capture).toHaveBeenCalledTimes(1);
        expect(reconcileDisappeared).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('INVALID_APPOINTMENT_FEED_MODE'),
        );
        expect(logger.warn).not.toHaveBeenCalledWith(
            expect.stringContaining('incremental'),
        );
    });

    it('processa no INCREMENTAL apenas os itens recebidos e não captura nem reconcilia desaparecimentos', async () => {
        const {
            service, conn, capture, upsert, reconcileDisappeared, logger,
        } = buildService({ feedMode: 'INCREMENTAL', response: [appointment('pending-1')] });

        await service.pollVismedClinic(conn);

        expect(upsert).toHaveBeenCalledTimes(1);
        expect(upsert).toHaveBeenCalledWith(
            clinicId,
            appointment('pending-1'),
            { idEmpresaGestora: 42, baseUrl: 'https://vismed.test' },
        );
        expect(capture).not.toHaveBeenCalled();
        expect(reconcileDisappeared).not.toHaveBeenCalled();
        expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('mode=INCREMENTAL'));
        expect(logger.log).toHaveBeenCalledWith(
            expect.stringContaining('DISAPPEARANCE_RECONCILIATION_SUPPRESSED'),
        );
    });

    it('trata [] no INCREMENTAL como sucesso sem upsert, cancelamento, remoção de break ou reconciliação por ausência', async () => {
        const {
            service, conn, upsert, capture, reconcileDisappeared, propagateCancellation, syncBreak,
        } = buildService({ feedMode: 'INCREMENTAL', response: [] });

        await service.pollVismedClinic(conn);

        expect(upsert).not.toHaveBeenCalled();
        expect(capture).not.toHaveBeenCalled();
        expect(reconcileDisappeared).not.toHaveBeenCalled();
        expect(propagateCancellation).not.toHaveBeenCalled();
        expect(syncBreak).not.toHaveBeenCalled();
    });

    it('deduplica falhas de itens identificáveis como candidatos à futura reentrega, sem segundo pipeline', async () => {
        const {
            service, conn, upsert, logger,
        } = buildService({
            feedMode: 'INCREMENTAL',
            response: [appointment('retryable-1'), appointment('retryable-1')],
        });
        upsert.mockRejectedValue(new Error('transient processing error'));

        await service.pollVismedClinic(conn);

        expect(upsert).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('FUTURE_RECOVERY_CANDIDATE'),
        );
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('vismedAppointmentId=retryable-1'),
        );
    });

    it('também coleta item identificável rejeitado pelo upsert sem exceção', async () => {
        const {
            service, conn, upsert, logger,
        } = buildService({
            feedMode: 'INCREMENTAL',
            response: [appointment('invalid-payload-1')],
        });
        upsert.mockResolvedValue(false);

        await service.pollVismedClinic(conn);

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('vismedAppointmentId=invalid-payload-1'),
        );
    });

    it('não introduz candidatos de recovery no caminho LEGACY', async () => {
        const {
            service, conn, upsert, logger,
        } = buildService({
            feedMode: 'LEGACY',
            response: [appointment('legacy-failure-1')],
        });
        upsert.mockRejectedValue(new Error('legacy processing error'));

        await service.pollVismedClinic(conn);

        expect(logger.warn).not.toHaveBeenCalledWith(
            expect.stringContaining('FUTURE_RECOVERY_CANDIDATE'),
        );
    });

    it('reentregas com o mesmo ID seguem para o mesmo upsert idempotente', async () => {
        const {
            service, conn, upsert,
        } = buildService({ feedMode: 'INCREMENTAL', response: [appointment('replay-1')] });

        await service.pollVismedClinic(conn);
        await service.pollVismedClinic(conn);

        expect(upsert).toHaveBeenCalledTimes(2);
        expect(upsert).toHaveBeenNthCalledWith(
            1,
            clinicId,
            appointment('replay-1'),
            { idEmpresaGestora: 42, baseUrl: 'https://vismed.test' },
        );
        expect(upsert).toHaveBeenNthCalledWith(
            2,
            clinicId,
            appointment('replay-1'),
            { idEmpresaGestora: 42, baseUrl: 'https://vismed.test' },
        );
    });

    it.each([
        ['resposta não-array', { invalid: true }],
        ['falha de leitura', new Error('timeout')],
    ])('mantém %s como fetch incompleto e nunca como prova de ausência em LEGACY', async (_label, response) => {
        const { service, conn, vismedService, reconcileDisappeared } = buildService();
        if (response instanceof Error) {
            vismedService.getAgendamentos.mockRejectedValue(response);
        } else {
            vismedService.getAgendamentos.mockResolvedValue(response);
        }

        await service.pollVismedClinic(conn);

        expect(reconcileDisappeared).not.toHaveBeenCalled();
    });

    it.each(['LEGACY', 'INCREMENTAL'] as const)(
        'mantém as reconciliações que não dependem de IDs vistos em %s',
        async feedMode => {
            const {
                service, conn, reconcileUnlinked, reconcileCancelled, reconcileWithoutVismedId,
            } = buildService({ feedMode, response: [] });

            await service.pollVismedClinic(conn);

            expect(reconcileUnlinked).toHaveBeenCalledWith(clinicId);
            expect(reconcileCancelled).toHaveBeenCalledWith(clinicId);
            expect(reconcileWithoutVismedId).toHaveBeenCalledWith(clinicId);
        },
    );
});