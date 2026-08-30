import { BookingSyncService } from './booking-sync.service';
import { ClinicConcurrencyGuard } from './clinic-concurrency-guard';
import { normalizeVismedAppointmentRecoveryIds } from './vismed-appointment-feed-recovery';

const clinicId = 'clinic-feed-mode';
const LEGACY_BASE_URL = 'https://app.vissmed.com.br/api-vissmed-4';
const INCREMENTAL_BASE_URL = 'https://app.vissmed.com.br/api-docctor-3';

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
    domain?: unknown;
} = {}) {
    const defaultDomain = options.feedMode === 'INCREMENTAL'
        ? INCREMENTAL_BASE_URL
        : LEGACY_BASE_URL;
    const conn = {
        clinicId,
        provider: 'vismed',
        status: 'connected',
        clientId: '42',
        domain: options.domain === undefined ? defaultDomain : options.domain,
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
        vismedDoctor: {
            findUnique: jest.fn().mockResolvedValue({ vismedId: 123 }),
        },
    } as any;
    const vismedService = {
        getUnidades: jest.fn().mockResolvedValue([{ idunidade: 11 }]),
        getUnidadesForPolling: jest.fn().mockResolvedValue([{ idunidade: 11 }]),
        getAgendamentos: jest.fn().mockResolvedValue(
            options.response === undefined ? [appointment()] : options.response,
        ),
        getAgendamentoById: jest.fn(),
        requestRedelivery: jest.fn().mockResolvedValue(undefined),
    };
    const rateLimiter = {
        acquire: jest.fn().mockResolvedValue(undefined),
    };
    const guard = new ClinicConcurrencyGuard();
    const service = new BookingSyncService(
        prisma,
        {} as any,
        vismedService as any,
        {} as any,
        rateLimiter as any,
        {} as any,
        guard,
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
        guard,
    };
}

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
            'appt-2,appt-3',
            'appt-\n4',
            'appt-1',
            42,
        ])).toEqual(['appt-1', '42']);
    });
});

describe('BookingSyncService — polling VisMed por contrato de feed', () => {
    it('libera POLLING após reconciliação de 15s simulados e não acumula POLL_SKIPPED_POLL_ACTIVE', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-08-28T12:00:00.000Z'));
        try {
            const { service, conn, reconcileUnlinked, guard, logger } = buildService({
                feedMode: 'INCREMENTAL',
                response: [],
            });
            reconcileUnlinked.mockImplementation(async () => {
                jest.advanceTimersByTime(15_000);
            });

            await service.pollVismedClinic(conn);
            await service.pollVismedClinic(conn);
            await service.pollVismedClinic(conn);

            expect(reconcileUnlinked).toHaveBeenCalledTimes(3);
            expect(guard.isActive(clinicId, 'POLLING')).toBe(false);
            expect(logger.warn).not.toHaveBeenCalledWith(
                expect.stringContaining('POLL_SKIPPED_POLL_ACTIVE'),
            );
        } finally {
            jest.useRealTimers();
        }
    });

    it('isola o poll ao conjunto autoritativo da empresa/base e deduplica IDs válidos', async () => {
        const { service, conn, prisma, vismedService, reconcileDisappeared } = buildService();
        prisma.vismedUnit.findMany.mockResolvedValue([{ vismedId: 999 }]);
        vismedService.getUnidadesForPolling.mockResolvedValue([
            { idunidade: 11 },
            { idunidade: '12' },
            { idunidade: 11 },
            { idunidade: 0 },
            { idunidade: -1 },
            { idunidade: 'invalid' },
            { idunidade: true },
            { idunidade: [13] },
            { idunidade: '1e2' },
            { idunidade: '01' },
            { idunidade: 1.5 },
            {},
        ]);

        await service.pollVismedClinic(conn);

        expect(vismedService.getUnidadesForPolling).toHaveBeenCalledTimes(1);
        expect(vismedService.getUnidadesForPolling).toHaveBeenCalledWith(42, LEGACY_BASE_URL);
        expect(vismedService.getUnidades).not.toHaveBeenCalled();
        expect(vismedService.getAgendamentos).toHaveBeenCalledTimes(2);
        expect(vismedService.getAgendamentos).toHaveBeenNthCalledWith(
            1, 11, LEGACY_BASE_URL, expect.any(Object),
        );
        expect(vismedService.getAgendamentos).toHaveBeenNthCalledWith(
            2, 12, LEGACY_BASE_URL, expect.any(Object),
        );
        expect(vismedService.getAgendamentos).not.toHaveBeenCalledWith(
            999, expect.anything(), expect.anything(),
        );
        expect(prisma.vismedUnit.findMany).not.toHaveBeenCalled();
        expect(reconcileDisappeared).toHaveBeenCalledWith(
            clinicId,
            expect.any(Set),
            expect.any(Date),
            expect.any(Date),
            [{ vismedId: 11 }, { vismedId: 12 }],
            LEGACY_BASE_URL,
            expect.any(String),
            expect.any(String),
            expect.any(Array),
        );
    });

    it.each([
        ['clientId ausente', { clientId: null }, false],
        ['clientId não numérico', { clientId: 'abc' }, false],
        ['clientId não positivo', { clientId: '0' }, false],
        ['clientId decimal', { clientId: '1.5' }, false],
        ['clientId em notação exponencial', { clientId: '1e2' }, false],
        ['clientId acima do limite seguro', { clientId: '9007199254740992' }, false],
        ['domain ausente', { domain: null }, false],
        ['domain inválido', { domain: 'not a URL' }, false],
    ])('encerra fail-closed quando %s', async (_label, patch, resolvesUnits) => {
        const { service, conn, prisma, vismedService, upsert, reconcileUnlinked } = buildService();
        prisma.integrationConnection.findFirst.mockResolvedValue({ ...conn, ...patch });

        await service.pollVismedClinic(conn);

        expect(vismedService.getUnidadesForPolling).toHaveBeenCalledTimes(resolvesUnits ? 1 : 0);
        expect(vismedService.getUnidades).not.toHaveBeenCalled();
        expect(vismedService.getAgendamentos).not.toHaveBeenCalled();
        expect(upsert).not.toHaveBeenCalled();
        expect(reconcileUnlinked).not.toHaveBeenCalled();
        expect(prisma.vismedUnit.findMany).not.toHaveBeenCalled();
    });

    it('revalida a conexão fresca e bloqueia o próximo poll após mudança para base desconhecida', async () => {
        const {
            service, conn, prisma, vismedService, upsert, reconcileDisappeared,
            reconcileUnlinked, reconcileCancelled, reconcileWithoutVismedId,
            propagateCancellation, syncBreak,
        } = buildService({ feedMode: 'INCREMENTAL' });
        prisma.integrationConnection.findFirst.mockResolvedValue({
            ...conn,
            domain: 'https://app.vissmed.com.br/unknown-instance',
        });

        await service.pollVismedClinic(conn);

        expect(vismedService.getUnidadesForPolling).not.toHaveBeenCalled();
        expect(vismedService.getAgendamentos).not.toHaveBeenCalled();
        expect(upsert).not.toHaveBeenCalled();
        expect(reconcileDisappeared).not.toHaveBeenCalled();
        expect(reconcileUnlinked).not.toHaveBeenCalled();
        expect(reconcileCancelled).not.toHaveBeenCalled();
        expect(reconcileWithoutVismedId).not.toHaveBeenCalled();
        expect(propagateCancellation).not.toHaveBeenCalled();
        expect(syncBreak).not.toHaveBeenCalled();
    });

    it('ignora campo legado divergente e usa o contrato incremental do registry', async () => {
        const {
            service, conn, prisma, capture, logger, vismedService,
        } = buildService({ feedMode: 'LEGACY', domain: INCREMENTAL_BASE_URL });
        prisma.integrationConnection.findFirst.mockResolvedValue(conn);

        await service.pollVismedClinic(conn);

        expect(capture).not.toHaveBeenCalled();
        expect(vismedService.getAgendamentos).toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('VISMED_APPOINTMENT_FEED_MODE_DIVERGENCE'),
        );
        expect(logger.log).toHaveBeenCalledWith(
            expect.stringContaining('source=INSTANCE_REGISTRY'),
        );
    });

    it.each([
        ['falha de transporte', new Error('timeout'), 'REQUEST_FAILED'],
        ['resposta não-array', { invalid: true }, 'INVALID_RESPONSE'],
        ['resposta null', null, 'INVALID_RESPONSE'],
        ['resposta false', false, 'INVALID_RESPONSE'],
        ['resposta zero', 0, 'INVALID_RESPONSE'],
        ['resposta string vazia', '', 'INVALID_RESPONSE'],
        [
            'array sem IDs válidos',
            [
                { idunidade: 0 },
                { idunidade: 'x' },
                { idunidade: true },
                { idunidade: [12] },
                { idunidade: '1e2' },
                { idunidade: 1.5 },
            ],
            'NO_VALID_UNIT_IDS',
        ],
    ])('trata %s como erro de resolução, sem agenda nem reconciliação', async (_label, response, reason) => {
        const { service, conn, prisma, vismedService, logger, upsert, reconcileUnlinked } = buildService();
        if (response instanceof Error) {
            vismedService.getUnidadesForPolling.mockRejectedValue(response);
        } else {
            vismedService.getUnidadesForPolling.mockResolvedValue(response);
        }

        await service.pollVismedClinic(conn);

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`reason=${reason}`));
        expect(vismedService.getAgendamentos).not.toHaveBeenCalled();
        expect(upsert).not.toHaveBeenCalled();
        expect(reconcileUnlinked).not.toHaveBeenCalled();
        expect(prisma.vismedUnit.findMany).not.toHaveBeenCalled();
    });

    it('distingue escopo validamente vazio e não inicia leituras ou reconciliações', async () => {
        const { service, conn, prisma, vismedService, logger, reconcileUnlinked } = buildService();
        vismedService.getUnidadesForPolling.mockResolvedValue([]);

        await service.pollVismedClinic(conn);

        expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('UNIT_SCOPE_EMPTY'));
        expect(logger.warn).not.toHaveBeenCalledWith(
            expect.stringContaining('UNIT_SCOPE_RESOLUTION_ERROR'),
        );
        expect(vismedService.getAgendamentos).not.toHaveBeenCalled();
        expect(reconcileUnlinked).not.toHaveBeenCalled();
        expect(prisma.vismedUnit.findMany).not.toHaveBeenCalled();
    });

    it('mantém LEGACY sem configuração: captura snapshot, agrega IDs e reconcilia após processar', async () => {
        const {
            service, conn, capture, upsert, reconcileDisappeared, logger,
        } = buildService();

        await service.pollVismedClinic(conn);

        expect(capture).toHaveBeenCalledTimes(1);
        expect(upsert).toHaveBeenCalledWith(
            clinicId,
            appointment(),
            { idEmpresaGestora: 42, baseUrl: LEGACY_BASE_URL },
        );
        expect(reconcileDisappeared).toHaveBeenCalledWith(
            clinicId,
            new Set(['vismed-appointment-1']),
            expect.any(Date),
            expect.any(Date),
            [{ vismedId: 11 }],
            LEGACY_BASE_URL,
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

    it('registra divergência do campo legado e continua no ramo do registry', async () => {
        const {
            service, conn, capture, reconcileDisappeared, logger,
        } = buildService({ feedMode: 'incremental', response: [] });

        await service.pollVismedClinic(conn);

        expect(capture).toHaveBeenCalledTimes(1);
        expect(reconcileDisappeared).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('VISMED_APPOINTMENT_FEED_MODE_DIVERGENCE'),
        );
        expect(logger.warn).not.toHaveBeenCalledWith(
            expect.stringContaining('legacyFieldValue'),
        );
    });

    it('processa no INCREMENTAL apenas os itens recebidos e não captura nem reconcilia desaparecimentos', async () => {
        const {
            service, conn, capture, upsert, reconcileDisappeared, logger, vismedService,
        } = buildService({ feedMode: 'INCREMENTAL', response: [appointment('pending-1')] });

        await service.pollVismedClinic(conn);

        expect(upsert).toHaveBeenCalledTimes(1);
        expect(upsert).toHaveBeenCalledWith(
            clinicId,
            appointment('pending-1'),
            { idEmpresaGestora: 42, baseUrl: INCREMENTAL_BASE_URL },
        );
        expect(capture).not.toHaveBeenCalled();
        expect(reconcileDisappeared).not.toHaveBeenCalled();
        expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('mode=INCREMENTAL'));
        expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('processed=1'));
        expect(logger.log).toHaveBeenCalledWith(
            expect.stringContaining('DISAPPEARANCE_RECONCILIATION_SUPPRESSED'),
        );
        expect(vismedService.getAgendamentos).toHaveBeenCalledWith(
            11,
            INCREMENTAL_BASE_URL,
            expect.objectContaining({ syncMode: 'consume' }),
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

    it('deduplica falhas identificáveis e solicita reentrega em um único lote, sem segundo pipeline', async () => {
        const {
            service, conn, upsert, logger, vismedService,
        } = buildService({
            feedMode: 'INCREMENTAL',
            response: [appointment('retryable-1'), appointment('retryable-1')],
        });
        upsert.mockRejectedValue(new Error('transient processing error'));

        await service.pollVismedClinic(conn);

        expect(upsert).toHaveBeenCalledTimes(2);
        expect(vismedService.requestRedelivery).toHaveBeenCalledTimes(1);
        expect(vismedService.requestRedelivery).toHaveBeenCalledWith(
            ['retryable-1'],
            INCREMENTAL_BASE_URL,
        );
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('RECOVERY_CANDIDATE'),
        );
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('vismedAppointmentId=retryable-1'),
        );
    });

    it('também coleta item identificável rejeitado pelo upsert sem exceção', async () => {
        const {
            service, conn, upsert, logger, vismedService,
        } = buildService({
            feedMode: 'INCREMENTAL',
            response: [appointment('invalid-payload-1')],
        });
        upsert.mockResolvedValue(false);

        await service.pollVismedClinic(conn);

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('vismedAppointmentId=invalid-payload-1'),
        );
        expect(vismedService.requestRedelivery).toHaveBeenCalledWith(
            ['invalid-payload-1'],
            INCREMENTAL_BASE_URL,
        );
    });

    it('não envia recovery para ID que poderia injetar outro item no CSV', async () => {
        const {
            service, conn, upsert, vismedService,
        } = buildService({
            feedMode: 'INCREMENTAL',
            response: [appointment('authorized-1,unauthorized-2')],
        });
        upsert.mockRejectedValue(new Error('processing failed'));

        await service.pollVismedClinic(conn);

        expect(vismedService.requestRedelivery).not.toHaveBeenCalled();
    });

    it('não introduz candidatos de recovery no caminho LEGACY', async () => {
        const {
            service, conn, upsert, logger, vismedService,
        } = buildService({
            feedMode: 'LEGACY',
            response: [appointment('legacy-failure-1')],
        });
        upsert.mockRejectedValue(new Error('legacy processing error'));

        await service.pollVismedClinic(conn);

        expect(logger.warn).not.toHaveBeenCalledWith(
            expect.stringContaining('RECOVERY_CANDIDATE'),
        );
        expect(vismedService.requestRedelivery).not.toHaveBeenCalled();
    });

    it('registra falha do recovery sem retry, ACK inventado ou interrupção do ciclo', async () => {
        const {
            service, conn, upsert, logger, vismedService, reconcileUnlinked,
        } = buildService({
            feedMode: 'INCREMENTAL',
            response: [appointment('retry-failed-1')],
        });
        upsert.mockRejectedValue(new Error('processing failed'));
        vismedService.requestRedelivery.mockRejectedValue(new Error('HTTP 503'));

        await service.pollVismedClinic(conn);

        expect(vismedService.requestRedelivery).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('RECOVERY_REQUEST_FAILED'),
        );
        expect(logger.log).not.toHaveBeenCalledWith(
            expect.stringContaining('RECOVERY_REQUEST_ACCEPTED'),
        );
        expect(reconcileUnlinked).toHaveBeenCalledWith(clinicId);
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
            { idEmpresaGestora: 42, baseUrl: INCREMENTAL_BASE_URL },
        );
        expect(upsert).toHaveBeenNthCalledWith(
            2,
            clinicId,
            appointment('replay-1'),
            { idEmpresaGestora: 42, baseUrl: INCREMENTAL_BASE_URL },
        );
    });

    it('updates com o mesmo ID percorrem novamente o mesmo upsert do polling', async () => {
        const original = appointment('updated-1');
        const updated = {
            ...appointment('updated-1'),
            horarioagendamento: '10:00',
            horarioagendamentofinal: '10:30',
        };
        const {
            service, conn, upsert,
        } = buildService({ feedMode: 'INCREMENTAL', response: [original, updated] });

        await service.pollVismedClinic(conn);

        expect(upsert).toHaveBeenNthCalledWith(
            1,
            clinicId,
            original,
            { idEmpresaGestora: 42, baseUrl: INCREMENTAL_BASE_URL },
        );
        expect(upsert).toHaveBeenNthCalledWith(
            2,
            clinicId,
            updated,
            { idEmpresaGestora: 42, baseUrl: INCREMENTAL_BASE_URL },
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

describe('BookingSyncService — descoberta de timers Vissmed', () => {
    it('não agenda timer novo para conexão não classificada', async () => {
        const service: any = Object.create(BookingSyncService.prototype);
        service.prisma = {
            integrationConnection: {
                findMany: jest.fn()
                    .mockResolvedValueOnce([])
                    .mockResolvedValueOnce([])
                    .mockResolvedValueOnce([{
                        clinicId,
                        provider: 'vismed',
                        status: 'connected',
                        clientId: '42',
                        domain: 'https://app.vissmed.com.br/unknown-instance',
                        vismedAppointmentFeedMode: 'LEGACY',
                    }]),
            },
        };
        service.logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
        service.polledClinicIds = new Set<string>();
        service.polledVismedClinicIds = new Set<string>();
        service.clinicTimers = [];
        service.isShuttingDown = false;

        await service.refreshPollingSchedule();

        expect(service.polledVismedClinicIds.has(clinicId)).toBe(false);
        expect(service.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('VISMED_APPOINTMENT_FEED_UNCLASSIFIED'),
        );
    });
});

describe('BookingSyncService — verify VisMed por contrato de feed', () => {
    it.each([
        ['confirma o ID esperado', [appointment('expected-1')], 'confirmed'],
        ['trata somente [] como ausência', [], 'not_found'],
        ['mantém objeto fora do formato como inconclusivo', appointment('expected-1'), 'unverified'],
        ['mantém ID divergente como inconclusivo', [appointment('other-id')], 'unverified'],
        ['mantém item inválido como inconclusivo', [{}], 'unverified'],
    ] as const)('%s no INCREMENTAL', async (_label, response, expected) => {
        const { service, vismedService } = buildService({ feedMode: 'INCREMENTAL' });
        vismedService.getAgendamentoById.mockResolvedValue(response);

        await expect((service as any).verifyVismedAppointmentExists(
            clinicId,
            'doctor-uuid',
            'expected-1',
            { start_at: '2026-08-20T12:00:00.000Z' },
        )).resolves.toBe(expected);

        expect(vismedService.getAgendamentoById).toHaveBeenCalledWith(
            'expected-1',
            INCREMENTAL_BASE_URL,
            undefined,
        );
        expect(vismedService.getAgendamentos).not.toHaveBeenCalled();
    });

    it('converte timeout ou falha de comunicação em unverified, nunca not_found', async () => {
        const { service, vismedService } = buildService({ feedMode: 'INCREMENTAL' });
        vismedService.getAgendamentoById.mockRejectedValue(new Error('timeout'));

        await expect((service as any).verifyVismedAppointmentExists(
            clinicId,
            'doctor-uuid',
            'expected-1',
            { start_at: '2026-08-20T12:00:00.000Z' },
        )).resolves.toBe('unverified');
        expect(vismedService.getAgendamentos).not.toHaveBeenCalled();
    });

    it('usa a URL canônica no verify incremental após normalizações sintáticas seguras', async () => {
        const { service, vismedService } = buildService({
            feedMode: 'LEGACY',
            domain: '  https://APP.VISSMED.COM.BR:443/api-docctor-3/  ',
        });
        vismedService.getAgendamentoById.mockResolvedValue([]);

        await expect((service as any).verifyVismedAppointmentExists(
            clinicId,
            'doctor-uuid',
            'expected-1',
            { start_at: '2026-08-20T12:00:00.000Z' },
        )).resolves.toBe('not_found');

        expect(vismedService.getAgendamentoById).toHaveBeenCalledWith(
            'expected-1',
            INCREMENTAL_BASE_URL,
            undefined,
        );
    });

    it('preserva exatamente a consulta ao feed e a interpretação LEGACY', async () => {
        const { service, vismedService } = buildService({
            feedMode: 'LEGACY',
            response: [appointment('legacy-1')],
            domain: '  https://APP.VISSMED.COM.BR:443/api-vissmed-4/  ',
        });

        await expect((service as any).verifyVismedAppointmentExists(
            clinicId,
            'doctor-uuid',
            'legacy-1',
            { start_at: '2026-08-20T12:00:00.000Z' },
        )).resolves.toBe('confirmed');

        expect(vismedService.getAgendamentos).toHaveBeenCalledTimes(1);
        expect(vismedService.getAgendamentos).toHaveBeenCalledWith(
            11,
            LEGACY_BASE_URL,
            expect.any(Object),
        );
        expect(vismedService.getAgendamentoById).not.toHaveBeenCalled();
    });

    it('não lê o feed no verify quando a instância é desconhecida', async () => {
        const { service, vismedService } = buildService({
            domain: 'https://app.vissmed.com.br/unknown-instance',
        });

        await expect((service as any).verifyVismedAppointmentExists(
            clinicId,
            'doctor-uuid',
            'expected-1',
            { start_at: '2026-08-20T12:00:00.000Z' },
        )).resolves.toBe('unverified');

        expect(vismedService.getAgendamentoById).not.toHaveBeenCalled();
        expect(vismedService.getAgendamentos).not.toHaveBeenCalled();
    });
});

describe('BookingSyncService — preflight incremental somente leitura', () => {
    it('lê todas as unidades em readonly e classifica ausência completa', async () => {
        const { service, vismedService, prisma } = buildService({
            feedMode: 'LEGACY',
            response: [],
            domain: '  https://APP.VISSMED.COM.BR:443/api-docctor-3/  ',
        });
        prisma.vismedUnit.findMany.mockResolvedValue([{ vismedId: 11 }, { vismedId: 12 }]);

        await expect((service as any).preflightVismedAppointment(
            clinicId,
            'doctor-uuid',
            {
                start_at: '2026-08-20T12:00:00.000Z',
                patient: { name: 'Paciente', surname: 'Teste' },
            },
            'booking-sync-id',
            new AbortController().signal,
        )).resolves.toEqual({ state: 'confirmed_absent' });

        expect(vismedService.getAgendamentos).toHaveBeenCalledTimes(2);
        expect(vismedService.getAgendamentos).toHaveBeenNthCalledWith(
            1,
            11,
            INCREMENTAL_BASE_URL,
            expect.objectContaining({
                dataini: '20/08/2026',
                datafim: '20/08/2026',
                profissional: 123,
                syncMode: 'readonly',
            }),
        );
        expect(vismedService.getAgendamentos).toHaveBeenNthCalledWith(
            2,
            12,
            INCREMENTAL_BASE_URL,
            expect.objectContaining({ syncMode: 'readonly' }),
        );
        expect(vismedService.getAgendamentoById).not.toHaveBeenCalled();
        expect(vismedService.requestRedelivery).not.toHaveBeenCalled();
    });

    it('não lê unidades nem feed no preflight quando a instância é desconhecida', async () => {
        const { service, vismedService, prisma } = buildService({
            domain: 'https://app.vissmed.com.br/unknown-instance',
        });

        await expect((service as any).preflightVismedAppointment(
            clinicId,
            'doctor-uuid',
            {
                start_at: '2026-08-20T12:00:00.000Z',
                patient: { name: 'Paciente', surname: 'Teste' },
            },
            'booking-sync-id',
            new AbortController().signal,
        )).resolves.toEqual({
            state: 'unknown',
            reason: 'unclassified_appointment_feed_instance',
        });

        expect(prisma.vismedUnit.findMany).not.toHaveBeenCalled();
        expect(vismedService.getAgendamentos).not.toHaveBeenCalled();
    });
});