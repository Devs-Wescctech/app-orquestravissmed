import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { MappingsService } from './mappings.service';

/**
 * Testes da fila de revisão de médicos ambíguos (DoctorMatchReview) com foco na
 * fronteira multi-tenant: reviews de médicos de OUTRA clínica não podem ser
 * listados, aprovados nem descartados.
 */
describe('MappingsService — doctor match reviews (escopo por clínica)', () => {
    const CLINIC_A = 'clinic-a';
    const CLINIC_B = 'clinic-b';

    const REVIEW = {
        id: 'r1',
        vismedDoctorId: 'vd1',
        status: 'PENDING',
        candidates: [{ doctoraliaDoctorUuid: 'dd1', doctoraliaDoctorId: '999', name: 'Dra. Ana', source: 'NAME_SUBSET' }],
        vismedDoctor: { name: 'Ana Lima' },
    };

    function buildService(opts: { doctorClinicId: string }) {
        // Tabela Mapping: vd1 pertence a opts.doctorClinicId
        const prisma: any = {
            mapping: {
                findMany: jest.fn().mockImplementation(({ where }: any) =>
                    Promise.resolve(where.clinicId === opts.doctorClinicId ? [{ vismedId: 'vd1' }] : [])),
                findFirst: jest.fn().mockImplementation(({ where }: any) =>
                    Promise.resolve(where.clinicId === opts.doctorClinicId && where.vismedId === 'vd1' ? { id: 'm1' } : null)),
            },
            doctorMatchReview: {
                findMany: jest.fn().mockImplementation(({ where }: any) =>
                    Promise.resolve((where.vismedDoctorId?.in || []).includes('vd1') ? [{ ...REVIEW }] : [])),
                findUnique: jest.fn().mockResolvedValue({ ...REVIEW }),
                update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...REVIEW, ...data })),
            },
            professionalUnifiedMapping: {
                findFirst: jest.fn().mockResolvedValue(null),
            },
            doctoraliaDoctor: {
                findUnique: jest.fn().mockResolvedValue({ id: 'dd1', name: 'Dra. Ana', doctoraliaDoctorId: '999' }),
            },
            auditLog: { create: jest.fn() },
        };
        const matchingEngine: any = { createDoctorMapping: jest.fn().mockResolvedValue(undefined) };
        return { svc: new MappingsService(prisma, matchingEngine), prisma, matchingEngine };
    }

    it('lista reviews apenas da clínica do médico', async () => {
        const { svc } = buildService({ doctorClinicId: CLINIC_A });
        await expect(svc.getDoctorReviews(CLINIC_A)).resolves.toHaveLength(1);
        await expect(svc.getDoctorReviews(CLINIC_B)).resolves.toHaveLength(0);
    });

    it('aprova review da própria clínica pelo mesmo caminho do auto-link', async () => {
        const { svc, matchingEngine } = buildService({ doctorClinicId: CLINIC_A });
        const result = await svc.approveDoctorReview('r1', 'dd1', CLINIC_A, 'user-1');
        expect(result.status).toBe('RESOLVED');
        expect(matchingEngine.createDoctorMapping).toHaveBeenCalledWith('vd1', 'dd1');
    });

    it('REJEITA aprovação vinda de outra clínica (ForbiddenException)', async () => {
        const { svc, matchingEngine } = buildService({ doctorClinicId: CLINIC_A });
        await expect(svc.approveDoctorReview('r1', 'dd1', CLINIC_B, 'user-1')).rejects.toThrow(ForbiddenException);
        expect(matchingEngine.createDoctorMapping).not.toHaveBeenCalled();
    });

    it('REJEITA descarte vindo de outra clínica (ForbiddenException)', async () => {
        const { svc, prisma } = buildService({ doctorClinicId: CLINIC_A });
        await expect(svc.dismissDoctorReview('r1', CLINIC_B, 'user-1')).rejects.toThrow(ForbiddenException);
        expect(prisma.doctorMatchReview.update).not.toHaveBeenCalled();
    });

    it('rejeita candidato que não pertence à revisão', async () => {
        const { svc } = buildService({ doctorClinicId: CLINIC_A });
        await expect(svc.approveDoctorReview('r1', 'dd-desconhecido', CLINIC_A)).rejects.toThrow(BadRequestException);
    });
});
