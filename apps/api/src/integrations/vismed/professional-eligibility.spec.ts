import { ProfessionalEligibility } from './professional-eligibility';

describe('fresh professional eligibility (not scheduleDay)', () => {
    function setup(body: unknown = [{ idprofissional: 6983, ativo: '1' }]) {
        const prisma: any = { integrationConnection: { findFirst: jest.fn().mockResolvedValue({
            clientId: '52', domain: 'https://app.vissmed.com.br/api-docctor-3', status: 'connected',
        }) } };
        const vismed: any = { getProfissionaisForEligibility: jest.fn().mockResolvedValue(body) };
        return { prisma, vismed, gate: new ProfessionalEligibility(prisma, vismed) };
    }
    it('uses the current clinic filtered roster, never local mappings or availability as authorization', async () => {
        const s = setup(); expect((await s.gate.check('clinic', 6983)).state).toBe('enabled');
        expect(s.vismed.getProfissionaisForEligibility).toHaveBeenCalledWith(52, 'https://app.vissmed.com.br/api-docctor-3');
    });
    it.each([[], [{ id: 7, ativo: '1' }], [{ id: 6983, mostrarnadoctoralia: '0' }], [{ id: 6983, ativo: '0' }]])('excludes a professional outside the eligible roster: %j', async body => {
        expect((await setup(body).gate.check('clinic', 6983)).state).toBe('excluded');
    });
    it.each([null, {}, { data: [] }, [{ nome: 'invalid' }], [{ id: 1, idprofissional: 2 }], [{ id: 1 }, { id: 1 }], [{ id: 6983, mostrarnadoctoralia: null }]])('fails closed without destructive cleanup on invalid data: %j', async body => {
        expect((await setup(body).gate.check('clinic', 6983)).state).toBe('unknown');
    });
    it('does not treat network failure as a disabled professional', async () => {
        const s = setup(); s.vismed.getProfissionaisForEligibility.mockRejectedValue(new Error('timeout'));
        expect((await s.gate.check('clinic', 6983)).state).toBe('unknown');
    });
    it('does not reuse a stale positive result', async () => {
        const s = setup(); expect((await s.gate.check('clinic', 6983)).state).toBe('enabled');
        s.vismed.getProfissionaisForEligibility.mockResolvedValue([]);
        expect((await s.gate.check('clinic', 6983)).state).toBe('excluded');
    });
    it('does not assume the filtered-roster contract applies to another API instance', async () => {
        const s = setup(); s.prisma.integrationConnection.findFirst.mockResolvedValue({ clientId: '52', domain: 'https://app.vissmed.com.br/api-vissmed-7' });
        expect((await s.gate.check('clinic', 6983)).state).toBe('unknown');
    });
    it.each([null, { clientId: '52junk' }, { clientId: '52', domain: 'https://app.vissmed.com.br/api-docctor-3', status: 'disconnected' }])('rejects incomplete or disconnected configuration %j', async conn => {
        const s = setup(); s.prisma.integrationConnection.findFirst.mockResolvedValue(conn);
        expect((await s.gate.check('clinic', 6983)).state).toBe('unknown');
        expect(s.vismed.getProfissionaisForEligibility).not.toHaveBeenCalled();
    });
});
