import { AppointmentsService } from './appointments.service';
import { DocplannerClient } from '../integrations/docplanner.service';

/**
 * Testes focados na blindagem da rota de bookings:
 * nenhuma exceção pode virar 500 — sempre 200 com { bookings: [], error }.
 */
describe('AppointmentsService bookings hardening', () => {
    let service: AppointmentsService;
    let prisma: any;
    let docplanner: any;

    const conn = { clinicId: 'c1', provider: 'doctoralia', clientId: 'id', clientSecret: 's', domain: 'doctoralia.com.br' };

    beforeEach(() => {
        prisma = {
            integrationConnection: { findFirst: jest.fn() },
            mapping: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
            auditLog: { create: jest.fn().mockResolvedValue({}) },
        };
        docplanner = { createClient: jest.fn() };
        service = new AppointmentsService(prisma, docplanner);
        jest.spyOn(DocplannerClient, 'runWithPriority').mockImplementation((fn: any) => fn());
    });

    afterEach(() => jest.restoreAllMocks());

    it('getBookings: exceção inesperada (fora do try interno) retorna lista vazia + erro genérico e loga stack', async () => {
        prisma.integrationConnection.findFirst.mockRejectedValue(new Error('db exploded: secret internal detail'));
        const errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

        const res: any = await service.getBookings('c1', '123', '2026-08-03', '2026-08-09');

        expect(res.bookings).toEqual([]);
        expect(res.error).toBe('Erro inesperado ao buscar os agendamentos. Tente novamente em instantes.');
        expect(res.error).not.toContain('secret internal detail');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('getBookings falhou'), expect.stringContaining('db exploded'));
    });

    it('getAllBookings: exceção inesperada retorna lista vazia + erro genérico e loga stack', async () => {
        prisma.integrationConnection.findFirst.mockResolvedValue(conn);
        prisma.mapping.findMany.mockRejectedValue(new Error('boom internal'));
        const errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

        const res: any = await service.getAllBookings('c1', '2026-08-03', '2026-08-09');

        expect(res.bookings).toEqual([]);
        expect(res.error).toBe('Erro inesperado ao buscar os agendamentos. Tente novamente em instantes.');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('getAllBookings falhou'), expect.stringContaining('boom internal'));
    });

    it('getAllBookings: falha por médico não derruba a resposta e loga stack', async () => {
        prisma.integrationConnection.findFirst.mockResolvedValue(conn);
        prisma.mapping.findMany.mockResolvedValue([
            {
                id: 'm1', externalId: '111',
                conflictData: { calendarStatus: 'enabled', facilityId: 'f1', address: { id: 9 }, name: 'Dr A' },
            },
            {
                id: 'm2', externalId: '222',
                conflictData: { calendarStatus: 'enabled', facilityId: 'f1', address: { id: 9 }, name: 'Dr B' },
            },
        ]);
        const getBookings = jest.fn()
            .mockRejectedValueOnce(new Error('Doctoralia 500'))
            .mockResolvedValueOnce({ _items: [{ id: 'b1' }] });
        docplanner.createClient.mockReturnValue({ getBookings });
        const errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

        const res: any = await service.getAllBookings('c1', '2026-08-03', '2026-08-09');

        expect(res.bookings).toHaveLength(1);
        expect(res.errors).toEqual(['Dr A: Doctoralia 500']);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Falha ao buscar bookings do médico 111'), expect.stringContaining('Doctoralia 500'));
    });

    it('getBookings: falha da Doctoralia no fetch retorna 200-shape com erro amigável', async () => {
        prisma.integrationConnection.findFirst.mockResolvedValue(conn);
        prisma.mapping.findUnique.mockResolvedValue({
            id: 'm1',
            conflictData: { calendarStatus: 'enabled', facilityId: 'f1', address: { id: 9 } },
        });
        const getBookings = jest.fn().mockRejectedValue(Object.assign(new Error('API não respondeu (timeout)'), { status: 504 }));
        docplanner.createClient.mockReturnValue({ getBookings });
        jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

        const res: any = await service.getBookings('c1', '123', '2026-08-03', '2026-08-09');

        expect(res.bookings).toEqual([]);
        expect(res.timedOut).toBe(true);
        expect(res.error).toBe('API não respondeu no tempo esperado');
    });
});
