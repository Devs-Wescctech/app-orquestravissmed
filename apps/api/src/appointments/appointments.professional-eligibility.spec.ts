import { AppointmentsService } from './appointments.service';

describe('manual slot publication eligibility', () => {
    it.each([[], null].map(body => [body]))('does not bypass the gate for excluded or uncertain professionals (%j)', async body => {
        const prisma: any = {
            integrationConnection: { findFirst: jest.fn(async ({ where }) => where.provider === 'vismed'
                ? { clientId: '52', domain: 'https://app.vissmed.com.br/api-docctor-3' }
                : { clientId: 'synthetic', domain: 'doctoralia.com.br' }) },
            mapping: { findUnique: jest.fn().mockResolvedValue({ status: 'LINKED', vismedId: 'local', conflictData: { facilityId: 'f', address: { id: 'a' } } }) },
            vismedDoctor: { findUnique: jest.fn().mockResolvedValue({ vismedId: 6983 }) },
            auditLog: { create: jest.fn() },
        };
        const client: any = { replaceSlots: jest.fn(), getServices: jest.fn() };
        const service = new (AppointmentsService as any)(prisma, { createClient: () => client }, { getProfissionaisForEligibility: jest.fn().mockResolvedValue(body) });
        await expect(service.replaceSlots('clinic', 'doctor', [{ start: '2030-01-01T08:00:00-03:00', address_services: [{ address_service_id: 5 }] }])).rejects.toThrow();
        expect(client.replaceSlots).not.toHaveBeenCalled();
    });
    it.each([[], null].map(body => [body]))('blocks manual calendar activation when eligibility is not confirmed (%j)', async body => {
        const prisma: any = {
            integrationConnection: { findFirst: jest.fn(async ({ where }) => where.provider === 'vismed'
                ? { clientId: '52', domain: 'https://app.vissmed.com.br/api-docctor-3' } : { clientId: 'synthetic' }) },
            mapping: { findUnique: jest.fn().mockResolvedValue({ status: 'LINKED', vismedId: 'local', conflictData: { facilityId: 'f', address: { id: 'a' } } }), update: jest.fn() },
            vismedDoctor: { findUnique: jest.fn().mockResolvedValue({ vismedId: 6983 }) }, auditLog: { create: jest.fn() },
        };
        const client: any = { enableCalendar: jest.fn(), getCalendar: jest.fn().mockResolvedValue({ enabled: true }) };
        const service = new AppointmentsService(prisma, { createClient: () => client } as any, { getProfissionaisForEligibility: jest.fn().mockResolvedValue(body) } as any);
        await expect(service.updateCalendarStatus('clinic', 'doctor', 'enabled')).rejects.toThrow();
        expect(client.enableCalendar).not.toHaveBeenCalled();
    });
});
