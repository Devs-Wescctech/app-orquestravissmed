import { BadRequestException } from '@nestjs/common';
import { ClinicsService } from './clinics.service';

function buildService() {
    const prisma = {
        clinic: {
            create: jest.fn(),
            update: jest.fn(),
            findUnique: jest.fn().mockResolvedValue({ id: 'clinic-1' }),
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

describe('ClinicsService — Doctoralia catalog scope version', () => {
    it('increments only for identity/scope change or explicit reauthorization', async () => {
        const base = {
            id: 'conn-1',
            provider: 'doctoralia',
            domain: 'www.doctoralia.com.br',
            clientId: 'client-1',
            clientSecret: 'secret-1',
            facilityId: null,
            status: 'connected',
            catalogScopeVersion: 7,
        };
        const cases = [
            [{ status: 'error', lastTestAt: new Date() }, false],
            [{ cachedToken: 'new-token', tokenExpiresAt: new Date() }, false],
            [{ clientSecret: 'secret-2' }, true],
            [{ facilityId: 'facility-2' }, true],
            [{ reauthorize: true }, true],
        ] as const;
        for (const [integrationArgs, increments] of cases) {
            const { service, prisma } = buildService();
            prisma.integrationConnection.findFirst.mockResolvedValue(base);
            await service.update('clinic-1', { integrationArgs });
            const data = prisma.integrationConnection.update.mock.calls[0][0].data;
            expect(data).not.toHaveProperty('reauthorize');
            expect(data).not.toHaveProperty('catalogScopeVersion', 999);
            if (increments) expect(data.catalogScopeVersion).toEqual({ increment: 1 });
            else expect(data.catalogScopeVersion).toBeUndefined();
        }
    });

    it('never accepts caller supplied scope versions', async () => {
        const { service, prisma } = buildService();
        prisma.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1', provider: 'doctoralia', catalogScopeVersion: 3,
        });
        await service.update('clinic-1', {
            integrationArgs: { status: 'connected', catalogScopeVersion: 999 },
        });
        expect(prisma.integrationConnection.update.mock.calls[0][0].data.catalogScopeVersion).toBeUndefined();
    });
});