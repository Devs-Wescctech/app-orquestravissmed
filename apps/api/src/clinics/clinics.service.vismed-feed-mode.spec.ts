import { BadRequestException } from '@nestjs/common';
import { ClinicsService } from './clinics.service';

function buildService() {
    const prisma = {
        clinic: {
            create: jest.fn(),
            update: jest.fn(),
        },
        integrationConnection: {
            create: jest.fn(),
            update: jest.fn(),
            findFirst: jest.fn(),
        },
    } as any;
    const service = new ClinicsService(prisma, {} as any, {} as any);
    return { service, prisma };
}

describe('ClinicsService — neutralidade do modo de feed VisMed', () => {
    it.each([
        ['create', (service: ClinicsService) => service.create({
            name: 'Clínica',
            integrationArgs: {
                provider: 'vismed',
                vismedAppointmentFeedMode: 'INCREMENTAL',
            },
        })],
        ['update', (service: ClinicsService) => service.update('clinic-1', {
            integrationArgs: {
                provider: 'vismed',
                vismedAppointmentFeedMode: 'INCREMENTAL',
            },
        })],
    ])('não oferece ativação pelo fluxo atual de %s de clínica', async (_operation, invoke) => {
        const { service, prisma } = buildService();

        await expect(invoke(service)).rejects.toBeInstanceOf(BadRequestException);

        expect(prisma.clinic.create).not.toHaveBeenCalled();
        expect(prisma.clinic.update).not.toHaveBeenCalled();
        expect(prisma.integrationConnection.create).not.toHaveBeenCalled();
        expect(prisma.integrationConnection.update).not.toHaveBeenCalled();
    });
});