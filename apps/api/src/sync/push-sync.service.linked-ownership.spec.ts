import { PushSyncService } from './push-sync.service';

type LocalDoctorMapping = {
    clinicId: string;
    entityType: string;
    status: string;
    vismedId: string | null;
};

describe('PushSyncService — ownership por mapping DOCTOR LINKED', () => {
    function makeSubject(localMappings: LocalDoctorMapping[], unifiedDoctorIds: string[]) {
        const client: any = {
            getAddresses: jest.fn(async () => {
                throw new Error('stop after ownership lookup');
            }),
            getCacheIdentity: jest.fn(() => 'test'),
        };

        const prisma: any = {
            clinic: { findUnique: jest.fn(async () => ({ id: 'clinic-a' })) },
            mapping: {
                findMany: jest.fn(async ({ where }: any) =>
                    localMappings
                        .filter(mapping =>
                            mapping.clinicId === where.clinicId
                            && mapping.entityType === where.entityType
                            && mapping.status === where.status,
                        )
                        .map(({ vismedId }) => ({ vismedId })),
                ),
            },
            professionalUnifiedMapping: {
                findMany: jest.fn(async ({ where }: any) =>
                    unifiedDoctorIds
                        .filter(vismedDoctorId => where.vismedDoctorId.in.includes(vismedDoctorId))
                        .map(vismedDoctorId => ({
                            vismedDoctor: {
                                id: vismedDoctorId,
                                name: `VisMed ${vismedDoctorId}`,
                                unit: { id: 'unit-1' },
                                specialties: [],
                                turnoM: null,
                                turnoT: null,
                                turnoN: null,
                            },
                            doctoraliaDoctor: {
                                name: `Doctoralia ${vismedDoctorId}`,
                                doctoraliaFacilityId: `facility-${vismedDoctorId}`,
                                doctoraliaDoctorId: `doctor-${vismedDoctorId}`,
                                addressServices: [],
                            },
                        })),
                ),
            },
            integrationConnection: { findFirst: jest.fn(async () => null) },
        };

        const slotSync: any = {
            generateDateRange: jest.fn(() => []),
        };
        const availabilityService: any = {
            buildForClinic: jest.fn(async () => null),
        };
        const stableCache: any = {
            getOrFetch: jest.fn(async (_key: string, _ttl: number, fetcher: () => unknown) => fetcher()),
        };

        const service = new PushSyncService(prisma, slotSync, availabilityService, stableCache);
        return { service, prisma, client };
    }

    it('inclui somente LINKED e exclui todos os demais status', async () => {
        const localMappings: LocalDoctorMapping[] = [
            { clinicId: 'clinic-a', entityType: 'DOCTOR', status: 'LINKED', vismedId: 'linked' },
            ...['UNLINKED', 'CONFLICT', 'ORPHAN', 'PENDING_REVIEW'].map(status => ({
                clinicId: 'clinic-a',
                entityType: 'DOCTOR',
                status,
                vismedId: status.toLowerCase(),
            })),
        ];
        const { service, prisma, client } = makeSubject(
            localMappings,
            ['linked', 'unlinked', 'conflict', 'orphan', 'pending_review'],
        );

        await service.pushToDoctoralia('clinic-a', 'run-1', client);

        expect(prisma.mapping.findMany).toHaveBeenCalledWith({
            where: { clinicId: 'clinic-a', entityType: 'DOCTOR', status: 'LINKED' },
            select: { vismedId: true },
        });
        expect(prisma.professionalUnifiedMapping.findMany.mock.calls[0][0].where).toEqual({
            isActive: true,
            vismedDoctorId: { in: ['linked'] },
        });
        expect(client.getAddresses).toHaveBeenCalledTimes(1);
        expect(client.getAddresses).toHaveBeenCalledWith('facility-linked', 'doctor-linked');
    });

    it('um profissional LINKED na clínica A e UNLINKED na B pertence somente ao push da A', async () => {
        const localMappings: LocalDoctorMapping[] = [
            { clinicId: 'clinic-a', entityType: 'DOCTOR', status: 'LINKED', vismedId: 'shared' },
            { clinicId: 'clinic-b', entityType: 'DOCTOR', status: 'UNLINKED', vismedId: 'shared' },
        ];
        const clinicA = makeSubject(localMappings, ['shared']);
        const clinicB = makeSubject(localMappings, ['shared']);
        clinicB.prisma.clinic.findUnique.mockResolvedValue({ id: 'clinic-b' });

        await clinicA.service.pushToDoctoralia('clinic-a', 'run-a', clinicA.client);
        await clinicB.service.pushToDoctoralia('clinic-b', 'run-b', clinicB.client);

        expect(clinicA.client.getAddresses).toHaveBeenCalledWith('facility-shared', 'doctor-shared');
        expect(clinicB.prisma.professionalUnifiedMapping.findMany.mock.calls[0][0].where.vismedDoctorId.in).toEqual([]);
        expect(clinicB.client.getAddresses).not.toHaveBeenCalled();
    });

    it('unified mapping global ativo sem mapping local LINKED não dispara consulta remota', async () => {
        const { service, prisma, client } = makeSubject(
            [{ clinicId: 'clinic-a', entityType: 'DOCTOR', status: 'UNLINKED', vismedId: 'foreign' }],
            ['foreign'],
        );

        await service.pushToDoctoralia('clinic-a', 'run-1', client);

        expect(prisma.professionalUnifiedMapping.findMany.mock.calls[0][0].where.vismedDoctorId.in).toEqual([]);
        expect(client.getAddresses).not.toHaveBeenCalled();
    });
});