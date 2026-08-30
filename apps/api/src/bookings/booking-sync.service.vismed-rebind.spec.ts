import { BookingSyncService } from './booking-sync.service';

const START = new Date('2026-08-20T12:00:00.000Z');
const END = new Date('2026-08-20T12:30:00.000Z');

const originalRecord = (extra: any = {}) => ({
    id: 'original-sync',
    clinicId: 'clinic-1',
    vismedDoctorId: 'doctor-1',
    vismedAppointmentId: '4073225',
    doctoraliaBookingId: '229071585',
    doctoraliaBreakId: null,
    origin: 'DOCTORALIA',
    status: 'BOOKED',
    patientName: 'Maria da Silva',
    patientPhone: '11999998888',
    startAt: START,
    endAt: END,
    lastMoveBy: null,
    lastMoveAt: null,
    lastMoveTargetStartAt: null,
    createdAt: new Date(Date.now() - 60_000),
    updatedAt: new Date('2026-08-20T11:59:00.000Z'),
    ...extra,
});

const replacementRecord = (id = 'replacement-sync', vismedAppointmentId = '4073305', extra: any = {}) => ({
    id,
    clinicId: 'clinic-1',
    vismedDoctorId: 'doctor-1',
    vismedAppointmentId,
    doctoraliaBookingId: null,
    doctoraliaBreakId: null,
    origin: 'DOCTORALIA',
    status: 'BOOKED',
    patientName: 'Maria da Silva',
    patientSurname: null,
    patientPhone: '11999998888',
    patientEmail: null,
    patientCpf: null,
    patientBirthDate: null,
    patientGender: null,
    startAt: START,
    endAt: END,
    duration: 30,
    rawPayload: { idpacienteagendamento: vismedAppointmentId, idprofissional: '123' },
    createdAt: new Date(),
    ...extra,
});

const confirmedAppointment = (id = '4073305', extra: any = {}) => ({
    idpacienteagendamento: id,
    idprofissional: '123',
    dataagendamento: '2026-08-20',
    horarioagendamento: '09:00',
    horarioagendamentofinal: '09:30',
    nomepaciente: 'Maria da Silva',
    telefonepaciente: '11999998888',
    ...extra,
});

function buildService(options: {
    original?: any;
    candidates?: any[];
    confirmation?: any;
    confirmationError?: Error;
    transactionError?: Error;
    transactionCandidate?: any;
    fenceReads?: any[];
    authorityMapping?: any;
} = {}) {
    const original = options.original ?? originalRecord();
    const candidates = options.candidates ?? [];
    const confirmation = options.confirmation ?? [];
    const tx = {
        $queryRaw: jest.fn().mockResolvedValue([
            { id: original.id },
            ...candidates.map(candidate => ({ id: candidate.id })),
        ]),
        bookingSync: {
            findUnique: jest.fn(({ where }: any) => {
                if (where.id === original.id) return Promise.resolve(original);
                if (options.transactionCandidate && where.id === options.transactionCandidate.id) {
                    return Promise.resolve(options.transactionCandidate);
                }
                return Promise.resolve(candidates.find(candidate => candidate.id === where.id) ?? null);
            }),
            delete: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(original),
        },
    };
    const bookingSync = {
        findMany: jest.fn()
            .mockResolvedValueOnce([original])
            .mockResolvedValueOnce(candidates),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const fenceReads = options.fenceReads ? [...options.fenceReads] : null;
    bookingSync.findUnique.mockImplementation(() =>
        Promise.resolve(fenceReads ? (fenceReads.shift() ?? null) : original),
    );
    const prisma = {
        bookingSync,
        mapping: {
            findUnique: jest.fn().mockResolvedValue(
                options.authorityMapping === undefined
                    ? { id: 'mapping-1', status: 'LINKED', externalId: 'doctoralia-1' }
                    : options.authorityMapping,
            ),
        },
        doctoraliaDoctor: {
            findUnique: jest.fn().mockResolvedValue({
                doctoraliaDoctorId: 'doctoralia-1',
            }),
        },
        $transaction: options.transactionError
            ? jest.fn().mockRejectedValue(options.transactionError)
            : jest.fn((callback: any) => callback(tx)),
    } as any;
    const vismedService = {
        getAgendamentos: options.confirmationError
            ? jest.fn().mockRejectedValue(options.confirmationError)
            : jest.fn().mockResolvedValue(confirmation),
    };
    const service = new BookingSyncService(
        prisma,
        null as any,
        vismedService as any,
        null as any,
        null as any,
        null as any,
        null as any,
        null as any,
    );
    const propagate = jest.spyOn(service as any, 'propagateVismedCancellationToDoctoralia')
        .mockResolvedValue(undefined);
    const syncBreak = jest.spyOn(service as any, 'syncDoctoraliaBreak')
        .mockResolvedValue(undefined);

    return { service, prisma, bookingSync, tx, propagate, syncBreak };
}

const reconcile = (service: BookingSyncService) =>
    (service as any).reconcileDisappearedFromVismed(
        'clinic-1',
        new Set<string>(),
        new Date('2026-08-19T00:00:00.000Z'),
        new Date('2026-08-21T23:59:59.999Z'),
        [{ vismedId: 1 }],
        undefined,
        '19/08/2026',
        '21/08/2026',
    );

const cancellationCalls = (bookingSync: any) =>
    bookingSync.updateMany.mock.calls.filter(([args]: any[]) => args?.data?.status === 'CANCELLED');

describe('BookingSyncService — rebind seguro de ID VisMed desaparecido', () => {
    it('rebinda 4073225 → 4073305 confirmado e preserva o BookingSync do booking 229071585', async () => {
        const candidate = replacementRecord();
        const { service, bookingSync, tx, propagate, syncBreak } = buildService({
            candidates: [candidate],
            confirmation: [confirmedAppointment()],
        });

        await reconcile(service);

        expect(tx.bookingSync.delete).toHaveBeenCalledWith({ where: { id: candidate.id } });
        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
        expect(tx.$queryRaw.mock.invocationCallOrder[0])
            .toBeLessThan(tx.bookingSync.findUnique.mock.invocationCallOrder[0]);
        expect(tx.bookingSync.update).toHaveBeenCalledWith({
            where: expect.objectContaining({
                id: 'original-sync',
                vismedAppointmentId: '4073225',
                status: 'BOOKED',
                updatedAt: originalRecord().updatedAt,
            }),
            data: expect.objectContaining({
                vismedAppointmentId: '4073305',
                status: 'BOOKED',
                syncedToVismed: true,
            }),
        });
        expect(cancellationCalls(bookingSync)).toHaveLength(0);
        expect(propagate).not.toHaveBeenCalled();
        expect(syncBreak).not.toHaveBeenCalled();
    });

    it('mantém o cancelamento atual quando não existe replacement', async () => {
        const { service, bookingSync, propagate, syncBreak } = buildService();

        await reconcile(service);

        expect(cancellationCalls(bookingSync)).toHaveLength(1);
        expect(propagate).toHaveBeenCalledWith('original-sync');
        expect(syncBreak).toHaveBeenCalledWith('original-sync');
    });

    it('cancela localmente sem efeito Doctoralia quando a autoridade clínica não existe mais', async () => {
        const { service, bookingSync, propagate, syncBreak } = buildService({
            authorityMapping: null,
        });

        await reconcile(service);

        expect(cancellationCalls(bookingSync)).toHaveLength(1);
        expect(propagate).not.toHaveBeenCalled();
        expect(syncBreak).not.toHaveBeenCalled();
    });

    it('não escolhe entre dois replacements confirmados e persiste diagnóstico sem cancelar', async () => {
        const candidates = [
            replacementRecord('candidate-a', '4073305'),
            replacementRecord('candidate-b', '4073306'),
        ];
        const { service, bookingSync, prisma, tx } = buildService({
            candidates,
            confirmation: [
                confirmedAppointment('4073305'),
                confirmedAppointment('4073306'),
            ],
        });

        await reconcile(service);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(tx.bookingSync.delete).not.toHaveBeenCalled();
        expect(cancellationCalls(bookingSync)).toHaveLength(0);
        expect(bookingSync.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                syncError: expect.stringContaining('2 candidatos confirmados'),
            }),
        }));
    });

    it('não adota paciente diferente no mesmo médico e horário', async () => {
        const { service, bookingSync, prisma } = buildService({
            candidates: [replacementRecord()],
            confirmation: [confirmedAppointment('4073305', {
                nomepaciente: 'Outra Pessoa',
                telefonepaciente: '11888887777',
            })],
        });

        await reconcile(service);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(cancellationCalls(bookingSync)).toHaveLength(1);
    });

    it('não adota quando a reconfirmação atual mostra outro médico', async () => {
        const { service, bookingSync, prisma } = buildService({
            candidates: [replacementRecord('candidate-other-doctor')],
            confirmation: [confirmedAppointment('4073305', { idprofissional: '999' })],
        });

        await reconcile(service);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(cancellationCalls(bookingSync)).toHaveLength(1);
    });

    it('não adota quando a reconfirmação atual mostra outro horário', async () => {
        const { service, bookingSync, prisma } = buildService({
            candidates: [replacementRecord()],
            confirmation: [confirmedAppointment('4073305', { horarioagendamento: '10:30' })],
        });

        await reconcile(service);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(cancellationCalls(bookingSync)).toHaveLength(1);
    });

    it('bloqueia cancelamento e remoção quando o replacement possui vínculo Doctoralia', async () => {
        const candidate = replacementRecord('linked-candidate', '4073305', {
            doctoraliaBookingId: 'different-doctoralia-booking',
        });
        const { service, bookingSync, prisma, tx } = buildService({
            candidates: [candidate],
            confirmation: [confirmedAppointment()],
        });

        await reconcile(service);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(tx.bookingSync.delete).not.toHaveBeenCalled();
        expect(cancellationCalls(bookingSync)).toHaveLength(0);
        expect(bookingSync.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                syncError: expect.stringContaining('possui vínculo Doctoralia'),
            }),
        }));
    });

    it.each([
        ['resposta não-array', { confirmation: { invalid: true } }],
        ['erro de leitura', { confirmationError: new Error('timeout') }],
    ])('não cancela quando a reconfirmação falha: %s', async (_label, options) => {
        const { service, bookingSync, prisma } = buildService(options);

        await reconcile(service);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(cancellationCalls(bookingSync)).toHaveLength(0);
        expect(bookingSync.findMany).toHaveBeenCalledTimes(1);
    });

    it('não cai no cancelamento quando a transação de rebind falha', async () => {
        const { service, bookingSync, propagate } = buildService({
            candidates: [replacementRecord()],
            confirmation: [confirmedAppointment()],
            transactionError: new Error('concurrent update'),
        });

        await reconcile(service);

        expect(cancellationCalls(bookingSync)).toHaveLength(0);
        expect(propagate).not.toHaveBeenCalled();
        expect(bookingSync.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                syncError: expect.stringContaining('concurrent update'),
            }),
        }));
    });

    it('revalida horário e paciente dentro da transação antes de remover o candidato', async () => {
        const selected = replacementRecord();
        const changedDuringTransaction = replacementRecord('replacement-sync', '4073305', {
            patientName: 'Outra Pessoa',
            patientPhone: '11888887777',
            startAt: new Date(START.getTime() + 10 * 60 * 1000),
        });
        const { service, bookingSync, tx, propagate } = buildService({
            candidates: [selected],
            confirmation: [confirmedAppointment()],
            transactionCandidate: changedDuringTransaction,
        });

        await reconcile(service);

        expect(tx.bookingSync.delete).not.toHaveBeenCalled();
        expect(cancellationCalls(bookingSync)).toHaveLength(0);
        expect(propagate).not.toHaveBeenCalled();
        expect(bookingSync.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                syncError: expect.stringContaining('candidate mudou'),
            }),
        }));
    });

    it('bloqueia original e candidato antes da releitura transacional', async () => {
        const { service, tx } = buildService({
            candidates: [replacementRecord()],
            confirmation: [confirmedAppointment()],
        });

        await reconcile(service);

        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
        expect(tx.$queryRaw.mock.invocationCallOrder[0])
            .toBeLessThan(tx.bookingSync.findUnique.mock.invocationCallOrder[0]);
        expect(tx.bookingSync.delete.mock.invocationCallOrder[0])
            .toBeGreaterThan(tx.bookingSync.findUnique.mock.invocationCallOrder[1]);
    });

    it('não adota coincidência apenas por horário quando o paciente é genérico e sem telefone forte', async () => {
        const { service, bookingSync, prisma } = buildService({
            original: originalRecord({
                patientName: 'Paciente VisMed #123',
                patientPhone: null,
            }),
            candidates: [replacementRecord()],
            confirmation: [confirmedAppointment('4073305', {
                nomepaciente: 'Paciente',
                telefonepaciente: null,
            })],
        });

        await reconcile(service);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(cancellationCalls(bookingSync)).toHaveLength(1);
    });

    it('não adota candidato compatível no banco cujo ID não aparece na reconfirmação atual', async () => {
        const { service, bookingSync, prisma } = buildService({
            candidates: [replacementRecord()],
            confirmation: [],
        });

        await reconcile(service);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(cancellationCalls(bookingSync)).toHaveLength(1);
    });

    it('não considera nomes apenas parcialmente iguais quando não há telefone', async () => {
        const { service, bookingSync, prisma } = buildService({
            original: originalRecord({
                patientName: 'Maria Silva',
                patientPhone: null,
            }),
            candidates: [replacementRecord('replacement-sync', '4073305', {
                patientPhone: null,
            })],
            confirmation: [confirmedAppointment('4073305', {
                nomepaciente: 'Maria Silva Santos',
                telefonepaciente: null,
            })],
        });

        await reconcile(service);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(cancellationCalls(bookingSync)).toHaveLength(1);
    });

    it('registro alterado depois do snapshot não entra no rebind nem no cancelamento', async () => {
        const original = originalRecord();
        const changed = originalRecord({
            updatedAt: new Date(original.updatedAt.getTime() + 1_000),
        });
        const { service, bookingSync, prisma, propagate, syncBreak } = buildService({
            original,
            candidates: [replacementRecord()],
            confirmation: [confirmedAppointment()],
            fenceReads: [changed],
        });

        await reconcile(service);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(cancellationCalls(bookingSync)).toHaveLength(0);
        expect(propagate).not.toHaveBeenCalled();
        expect(syncBreak).not.toHaveBeenCalled();
    });

    it('alteração entre a seleção de replacement e a mutação destrutiva adia o ciclo', async () => {
        const original = originalRecord();
        const changed = originalRecord({
            status: 'CONFIRMED',
            updatedAt: new Date(original.updatedAt.getTime() + 2_000),
        });
        const { service, bookingSync, propagate, syncBreak } = buildService({
            original,
            confirmation: [],
            fenceReads: [original, changed],
        });

        await reconcile(service);

        expect(cancellationCalls(bookingSync)).toHaveLength(0);
        expect(propagate).not.toHaveBeenCalled();
        expect(syncBreak).not.toHaveBeenCalled();
    });

    it('fence atômico que perde a corrida não propaga cancelamento nem remove break', async () => {
        const { service, bookingSync, propagate, syncBreak } = buildService();
        bookingSync.updateMany.mockResolvedValueOnce({ count: 0 });

        await reconcile(service);

        expect(cancellationCalls(bookingSync)).toHaveLength(1);
        expect(propagate).not.toHaveBeenCalled();
        expect(syncBreak).not.toHaveBeenCalled();
    });

    it('snapshot vazio exclui registro criado depois do boundary', async () => {
        const { service, bookingSync, propagate, syncBreak } = buildService();

        await (service as any).reconcileDisappearedFromVismed(
            'clinic-1',
            new Set<string>(),
            new Date('2026-08-19T00:00:00.000Z'),
            new Date('2026-08-21T23:59:59.999Z'),
            [{ vismedId: 1 }],
            undefined,
            '19/08/2026',
            '21/08/2026',
            [],
        );

        expect(bookingSync.findMany).not.toHaveBeenCalled();
        expect(cancellationCalls(bookingSync)).toHaveLength(0);
        expect(propagate).not.toHaveBeenCalled();
        expect(syncBreak).not.toHaveBeenCalled();
    });

    it('captura o universo destrutivo com createdAt/updatedAt anteriores ao boundary', async () => {
        const { service, bookingSync } = buildService();
        const boundary = new Date('2026-08-20T11:30:00.000Z');
        bookingSync.findMany.mockReset().mockResolvedValue([originalRecord()]);

        await (service as any).captureVismedDisappearanceSnapshot(
            'clinic-1',
            new Date('2026-08-19T00:00:00.000Z'),
            new Date('2026-08-21T23:59:59.999Z'),
            boundary,
        );

        expect(bookingSync.findMany).toHaveBeenCalledWith({
            where: expect.objectContaining({
                clinicId: 'clinic-1',
                createdAt: { lte: boundary },
                updatedAt: { lte: boundary },
                vismedAppointmentId: { not: null },
                status: { in: ['BOOKED', 'CONFIRMED'] },
            }),
        });
    });
});