import { BookingSyncService } from './booking-sync.service';

type MappingState = {
    id?: string;
    status?: string;
    externalId?: unknown;
} | null;

function buildSubject(options: {
    mapping?: MappingState;
    clinicDoctorId?: string | null;
    unifiedDoctorId?: string | null;
} = {}) {
    const mapping = options.mapping === undefined
        ? { id: 'mapping-a', status: 'LINKED', externalId: 'doctor-a' }
        : options.mapping;
    const prisma: any = {
        mapping: {
            findUnique: jest.fn().mockResolvedValue(mapping),
        },
        doctoraliaDoctor: {
            findUnique: jest.fn().mockImplementation(({ where }: any) => {
                const id = options.clinicDoctorId === undefined
                    ? where.doctoraliaDoctorId
                    : options.clinicDoctorId;
                return id
                    ? Promise.resolve({
                        id: `uuid-${id}`,
                        doctoraliaDoctorId: id,
                        doctoraliaFacilityId: `facility-${id}`,
                    })
                    : Promise.resolve(null);
            }),
        },
        professionalUnifiedMapping: {
            findMany: jest.fn().mockResolvedValue(options.unifiedDoctorId
                ? [{
                    id: 'unified-1',
                    doctoraliaDoctor: {
                        doctoraliaDoctorId: options.unifiedDoctorId,
                    },
                }]
                : []),
        },
    };
    const service: any = Object.create(BookingSyncService.prototype);
    service.prisma = prisma;
    service.logger = {
        log: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
    };
    return { service, prisma, logger: service.logger };
}

async function resolve(service: any, clinicId = 'clinic-a') {
    return service.resolveClinicDoctorForVismedAppointment(clinicId, 'vismed-doctor-shared');
}

describe('BookingSyncService — autoridade clínica do médico na ingestão VisMed', () => {
    it('aceita Mapping clínico LINKED sem ProfessionalUnifiedMapping', async () => {
        const { service, prisma } = buildSubject();

        await expect(resolve(service)).resolves.toEqual({
            doctoraliaDoctorId: 'doctor-a',
            doctoraliaFacilityId: 'facility-doctor-a',
        });
        expect(prisma.professionalUnifiedMapping.findMany).toHaveBeenCalledTimes(1);
    });

    it('mantém a mesma decisão quando o vínculo unificado coincide', async () => {
        const { service, logger } = buildSubject({ unifiedDoctorId: 'doctor-a' });

        await expect(resolve(service)).resolves.toEqual({
            doctoraliaDoctorId: 'doctor-a',
            doctoraliaFacilityId: 'facility-doctor-a',
        });
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('preserva a autoridade clínica e alerta com IDs técnicos quando o vínculo global diverge', async () => {
        const { service, logger } = buildSubject({ unifiedDoctorId: 'doctor-foreign' });

        await expect(resolve(service)).resolves.toEqual({
            doctoraliaDoctorId: 'doctor-a',
            doctoraliaFacilityId: 'facility-doctor-a',
        });
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('CLINIC_DOCTOR_AUTHORITY_DIVERGENCE'),
        );
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('action=USE_CLINIC_MAPPING_REMEDIATE_LATER'),
        );
    });

    it.each([
        ['ausente', null],
        ['UNLINKED', { id: 'mapping-a', status: 'UNLINKED', externalId: 'doctor-a' }],
        ['sem ID externo', { id: 'mapping-a', status: 'LINKED', externalId: '   ' }],
    ])('falha fechado com Mapping clínico %s e não consulta vínculo global', async (_label, mapping) => {
        const { service, prisma, logger } = buildSubject({
            mapping,
            unifiedDoctorId: 'doctor-foreign',
        });

        await expect(resolve(service)).resolves.toBeNull();
        expect(prisma.professionalUnifiedMapping.findMany).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('action=UPSERT_LOCAL_WITHOUT_DOCTORALIA_AUTHORITY'),
        );
    });

    it('falha fechado quando o ID externo não existe no catálogo local', async () => {
        const { service, prisma } = buildSubject({ clinicDoctorId: null, unifiedDoctorId: 'doctor-foreign' });

        await expect(resolve(service)).resolves.toBeNull();
        expect(prisma.professionalUnifiedMapping.findMany).not.toHaveBeenCalled();
    });

    it('isola duas clínicas com o mesmo médico VisMed e permanece idempotente', async () => {
        const clinicA = buildSubject({
            mapping: { id: 'mapping-a', status: 'LINKED', externalId: 'doctor-a' },
            unifiedDoctorId: 'doctor-foreign',
        });
        const clinicB = buildSubject({
            mapping: { id: 'mapping-b', status: 'LINKED', externalId: 'doctor-b' },
            unifiedDoctorId: 'doctor-foreign',
        });

        await expect(resolve(clinicA.service, 'clinic-a')).resolves.toMatchObject({
            doctoraliaDoctorId: 'doctor-a',
        });
        await expect(resolve(clinicB.service, 'clinic-b')).resolves.toMatchObject({
            doctoraliaDoctorId: 'doctor-b',
        });
        await expect(resolve(clinicA.service, 'clinic-a')).resolves.toMatchObject({
            doctoraliaDoctorId: 'doctor-a',
        });
        expect(clinicA.prisma.mapping.findUnique).toHaveBeenCalledTimes(2);
        expect(clinicA.prisma.mapping.findUnique).toHaveBeenCalledWith({
            where: {
                clinicId_entityType_vismedId: {
                    clinicId: 'clinic-a',
                    entityType: 'DOCTOR',
                    vismedId: 'vismed-doctor-shared',
                },
            },
        });
        expect(clinicA.prisma.doctoraliaDoctor.findUnique).toHaveBeenCalledTimes(2);
    });

    it('faz somente consultas locais e não possui dependência de cliente Doctoralia', async () => {
        const { service, prisma } = buildSubject();

        await resolve(service);

        expect(prisma.mapping.findUnique).toHaveBeenCalledTimes(1);
        expect(prisma.doctoraliaDoctor.findUnique).toHaveBeenCalledTimes(1);
        expect(prisma.professionalUnifiedMapping.findMany).toHaveBeenCalledTimes(1);
        expect(Object.keys(prisma)).toEqual([
            'mapping',
            'doctoraliaDoctor',
            'professionalUnifiedMapping',
        ]);
    });

    it('detecta todos os vínculos globais divergentes mesmo quando o primeiro coincide', async () => {
        const { service, prisma, logger } = buildSubject({ unifiedDoctorId: 'doctor-a' });
        prisma.professionalUnifiedMapping.findMany.mockResolvedValue([
            { id: 'unified-a', doctoraliaDoctor: { doctoraliaDoctorId: 'doctor-a' } },
            { id: 'unified-b', doctoraliaDoctor: { doctoraliaDoctorId: 'doctor-foreign' } },
        ]);

        await expect(resolve(service)).resolves.toMatchObject({ doctoraliaDoctorId: 'doctor-a' });
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unifiedMappingId=unified-b'));
        expect(prisma.professionalUnifiedMapping.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { id: 'asc' } }),
        );
    });

    it('neutraliza caracteres de controle nos IDs do alerta técnico', async () => {
        const { service, logger } = buildSubject({
            mapping: { id: 'mapping\nforged', status: 'LINKED', externalId: 'doctor-a' },
            unifiedDoctorId: 'doctor\nforeign',
        });

        await resolve(service, 'clinic\nforged');

        const warning = logger.warn.mock.calls[0][0];
        expect(warning).not.toContain('\n');
        expect(warning).toContain('clinicId=clinic_forged');
        expect(warning).toContain('unifiedDoctoraliaDoctorId=doctor_foreign');
    });

    it('mantém a decisão clínica quando a consulta auxiliar global falha', async () => {
        const { service, prisma, logger } = buildSubject();
        prisma.professionalUnifiedMapping.findMany.mockRejectedValue(new Error('database unavailable'));

        await expect(resolve(service)).resolves.toEqual({
            doctoraliaDoctorId: 'doctor-a',
            doctoraliaFacilityId: 'facility-doctor-a',
        });
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('CLINIC_DOCTOR_AUXILIARY_CHECK_FAILED'),
        );
        expect(logger.warn.mock.calls[0][0]).not.toContain('database unavailable');
    });
});

describe('BookingSyncService — fronteira de persistência da autoridade clínica', () => {
    const appointment = {
        idpacienteagendamento: 'appointment-1',
        idprofissional: '123',
        dataagendamento: '2026-08-20',
        horarioagendamento: '09:00',
        horarioagendamentofinal: '09:30',
        nomepaciente: 'Paciente',
    };

    function buildIngestion(options: {
        mapping?: MappingState;
        existing?: any | null;
        doctor?: any | null;
        ensuredDoctor?: any | null;
        localDoctor?: any | null;
    } = {}) {
        const defaultExisting = {
            id: 'booking-existing',
            clinicId: 'clinic-a',
            vismedAppointmentId: 'appointment-1',
            vismedDoctorId: 'vismed-doctor-shared',
            doctoraliaDoctorId: 'doctor-a',
            doctoraliaFacilityId: 'facility-doctor-a',
            status: 'BOOKED',
            cancelledBy: null,
            startAt: new Date('2026-08-20T12:00:00.000Z'),
            endAt: new Date('2026-08-20T12:30:00.000Z'),
            origin: 'VISMED',
        };
        const existing = options.existing === undefined ? defaultExisting : options.existing;
        const doctor = options.doctor === undefined
            ? { id: 'vismed-doctor-shared', vismedId: 123 }
            : options.doctor;
        const mapping = options.mapping === undefined
            ? { id: 'mapping-a', status: 'LINKED', externalId: 'doctor-a' }
            : options.mapping;
        const localDoctor = options.localDoctor === undefined
            ? {
                doctoraliaDoctorId: 'doctor-a',
                doctoraliaFacilityId: 'facility-doctor-a',
            }
            : options.localDoctor;
        const prisma: any = {
            vismedDoctor: {
                findUnique: jest.fn().mockResolvedValue(doctor),
            },
            mapping: { findUnique: jest.fn().mockResolvedValue(mapping) },
            doctoraliaDoctor: {
                findUnique: jest.fn().mockResolvedValue(localDoctor),
            },
            professionalUnifiedMapping: { findMany: jest.fn().mockResolvedValue([]) },
            bookingSync: {
                findUnique: jest.fn().mockResolvedValue(existing),
                findFirst: jest.fn().mockResolvedValue(null),
                findMany: jest.fn().mockResolvedValue([]),
                upsert: jest.fn().mockImplementation(({ create, update }: any) =>
                    Promise.resolve(existing
                        ? { ...existing, ...update }
                        : { id: 'booking-new', ...create })),
                update: jest.fn(),
            },
        };
        const service: any = Object.create(BookingSyncService.prototype);
        service.prisma = prisma;
        service.logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
        service.syncDoctoraliaBreak = jest.fn().mockResolvedValue(undefined);
        service.propagateVismedCancellationToDoctoralia = jest.fn().mockResolvedValue(undefined);
        service.propagateVismedRescheduleToDoctoralia = jest.fn().mockResolvedValue(undefined);
        service.propagateDoctoraliaCancellationToVismed = jest.fn().mockResolvedValue(undefined);
        service.ensureVismedDoctorFromAppointment = jest.fn()
            .mockResolvedValue(options.ensuredDoctor ?? null);
        return { service, prisma, existing };
    }

    it('persiste o médico autorizado pela clínica sem depender de vínculo global', async () => {
        const { service, prisma } = buildIngestion({
            mapping: {
                id: 'mapping-a',
                status: 'LINKED',
                externalId: 'doctor-a',
            },
        });

        await expect(service.upsertVismedAppointment('clinic-a', appointment)).resolves.toBe(true);
        expect(prisma.bookingSync.upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({
                doctoraliaDoctorId: 'doctor-a',
                doctoraliaFacilityId: 'facility-doctor-a',
            }),
        }));
        expect(service.syncDoctoraliaBreak).toHaveBeenCalledWith('booking-existing');
    });

    it.each([
        ['mapping ausente', null, undefined],
        ['mapping UNLINKED', { id: 'mapping-a', status: 'UNLINKED', externalId: 'doctor-foreign' }, undefined],
        ['médico Doctoralia local ausente', { id: 'mapping-a', status: 'LINKED', externalId: 'doctor-missing' }, null],
    ])('persiste nova ingestão com IDs Doctoralia nulos quando %s', async (_label, mapping, localDoctor) => {
        const { service, prisma } = buildIngestion({
            mapping,
            localDoctor,
            existing: null,
        });

        await expect(service.upsertVismedAppointment('clinic-a', appointment)).resolves.toBe(true);
        expect(prisma.bookingSync.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({
                doctoraliaDoctorId: null,
                doctoraliaFacilityId: null,
            }),
        }));
        expect(prisma.bookingSync.findFirst).not.toHaveBeenCalled();
        expect(service.syncDoctoraliaBreak).not.toHaveBeenCalled();
        expect(service.propagateVismedCancellationToDoctoralia).not.toHaveBeenCalled();
        expect(service.propagateVismedRescheduleToDoctoralia).not.toHaveBeenCalled();
    });

    it('persiste pela autoridade clínica mesmo quando o diagnóstico global está indisponível', async () => {
        const { service, prisma } = buildIngestion({
            mapping: {
                id: 'mapping-a',
                status: 'LINKED',
                externalId: 'doctor-a',
            },
        });
        prisma.professionalUnifiedMapping.findMany.mockRejectedValue(new Error('diagnostic failure'));

        await expect(service.upsertVismedAppointment('clinic-a', appointment)).resolves.toBe(true);
        expect(prisma.bookingSync.upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({ doctoraliaDoctorId: 'doctor-a' }),
        }));
    });

    it('persiste localmente quando o VismedDoctor ainda não foi materializado', async () => {
        const { service, prisma } = buildIngestion({
            doctor: null,
            ensuredDoctor: null,
            existing: null,
        });

        await expect(service.upsertVismedAppointment('clinic-a', appointment)).resolves.toBe(true);
        expect(prisma.mapping.findUnique).not.toHaveBeenCalled();
        expect(prisma.bookingSync.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({
                vismedDoctorId: null,
                doctoraliaDoctorId: null,
                doctoraliaFacilityId: null,
            }),
        }));
        expect(service.syncDoctoraliaBreak).not.toHaveBeenCalled();
    });

    it('preserva IDs Doctoralia válidos preexistentes sem autoridade e atualiza status, horário e processedAt', async () => {
        const existing = {
            id: 'booking-existing',
            clinicId: 'clinic-a',
            vismedAppointmentId: 'appointment-1',
            vismedDoctorId: 'vismed-doctor-shared',
            doctoraliaDoctorId: 'doctor-valid',
            doctoraliaFacilityId: 'facility-valid',
            status: 'BOOKED',
            cancelledBy: null,
            startAt: new Date('2026-08-20T11:00:00.000Z'),
            endAt: new Date('2026-08-20T11:30:00.000Z'),
            origin: 'VISMED',
        };
        const { service, prisma } = buildIngestion({ mapping: null, existing });
        const changed = {
            ...appointment,
            confirmado: '1',
            horarioagendamento: '10:00',
            horarioagendamentofinal: '10:30',
        };

        await expect(service.upsertVismedAppointment('clinic-a', changed)).resolves.toBe(true);
        const update = prisma.bookingSync.upsert.mock.calls[0][0].update;
        expect(update).toMatchObject({
            status: 'CONFIRMED',
            startAt: new Date('2026-08-20T13:00:00.000Z'),
            endAt: new Date('2026-08-20T13:30:00.000Z'),
            processedAt: expect.any(Date),
        });
        expect(update).not.toHaveProperty('doctoraliaDoctorId');
        expect(update).not.toHaveProperty('doctoraliaFacilityId');
        expect(service.syncDoctoraliaBreak).not.toHaveBeenCalled();
        expect(service.propagateVismedRescheduleToDoctoralia).not.toHaveBeenCalled();
    });

    it('não corrige automaticamente registro histórico contaminado', async () => {
        const contaminated = {
            id: 'booking-contaminated',
            clinicId: 'clinic-a',
            vismedAppointmentId: 'appointment-1',
            vismedDoctorId: 'vismed-doctor-shared',
            doctoraliaDoctorId: 'doctor-foreign',
            doctoraliaFacilityId: 'facility-foreign',
            status: 'BOOKED',
            cancelledBy: null,
            startAt: new Date('2026-08-20T12:00:00.000Z'),
            endAt: new Date('2026-08-20T12:30:00.000Z'),
            origin: 'VISMED',
        };
        const { service, prisma } = buildIngestion({
            mapping: { id: 'mapping-a', status: 'UNLINKED', externalId: null },
            existing: contaminated,
        });

        await expect(service.upsertVismedAppointment('clinic-a', appointment)).resolves.toBe(true);
        const update = prisma.bookingSync.upsert.mock.calls[0][0].update;
        expect(update).not.toHaveProperty('doctoraliaDoctorId');
        expect(update).not.toHaveProperty('doctoraliaFacilityId');
        expect(contaminated.doctoraliaDoctorId).toBe('doctor-foreign');
        expect(contaminated.doctoraliaFacilityId).toBe('facility-foreign');
    });

    it('não executa break, cancelamento ou reagendamento sem autoridade clínica', async () => {
        const existing = {
            id: 'booking-existing',
            clinicId: 'clinic-a',
            vismedAppointmentId: 'appointment-1',
            vismedDoctorId: 'vismed-doctor-shared',
            doctoraliaDoctorId: 'doctor-old',
            doctoraliaFacilityId: 'facility-old',
            status: 'BOOKED',
            cancelledBy: null,
            startAt: new Date('2026-08-20T11:00:00.000Z'),
            endAt: new Date('2026-08-20T11:30:00.000Z'),
            origin: 'VISMED',
        };
        const { service } = buildIngestion({ mapping: null, existing });

        await expect(service.upsertVismedAppointment('clinic-a', {
            ...appointment,
            cancelado: '1',
        })).resolves.toBe(true);
        expect(service.syncDoctoraliaBreak).not.toHaveBeenCalled();
        expect(service.propagateVismedCancellationToDoctoralia).not.toHaveBeenCalled();
        expect(service.propagateVismedRescheduleToDoctoralia).not.toHaveBeenCalled();
        expect(service.propagateDoctoraliaCancellationToVismed).not.toHaveBeenCalled();
    });
});