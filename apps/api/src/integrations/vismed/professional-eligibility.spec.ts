import { ProfessionalEligibility } from './professional-eligibility';

describe('fresh professional eligibility (not scheduleDay)', () => {
    function setup(body: unknown = [{ idprofissional: 6983, ativo: '1' }]) {
        const prisma: any = { integrationConnection: { findFirst: jest.fn().mockResolvedValue({
            clientId: '52', domain: 'https://app.vissmed.com.br/api-docctor-3', status: 'connected',
        }) }, mapping: { findMany: jest.fn().mockResolvedValue([{ vismedId: 'local-6983' }]) },
        vismedDoctor: { findMany: jest.fn().mockResolvedValue([{ vismedId: 6983 }]) } };
        const vismed: any = { getProfissionaisForEligibility: jest.fn().mockResolvedValue(body) };
        return { prisma, vismed, gate: new ProfessionalEligibility(prisma, vismed) };
    }
    it('uses the current clinic filtered roster, never local mappings or availability as authorization', async () => {
        const s = setup(); expect((await s.gate.check('clinic', 6983)).state).toBe('enabled');
        expect(s.vismed.getProfissionaisForEligibility).toHaveBeenCalledWith(52, 'https://app.vissmed.com.br/api-docctor-3');
    });
    it.each([[{ id: 7, ativo: '1' }], [{ id: 6983, mostrarnadoctoralia: '0' }], [{ id: 6983, ativo: '0' }]].map(body => [body]))('excludes a professional outside the eligible roster: %j', async body => {
        expect((await setup(body).gate.check('clinic', 6983)).state).toBe('excluded');
    });
    it('holds an empty roster as uncertain instead of excluding every mapped professional', async () => {
        const s = setup([]);
        expect(await s.gate.check('clinic', 6983)).toEqual({ state: 'unknown', reason: 'abnormal_roster_drop' });
        expect(s.prisma.mapping.findMany).not.toHaveBeenCalled();
    });
    it('holds a collective loss of linked professionals without blocking a present professional', async () => {
        const s = setup([{ id: 6983, ativo: '1' }]);
        s.prisma.mapping.findMany.mockResolvedValue([1, 2, 3, 4, 5].map(id => ({ vismedId: `local-${id}` })));
        s.prisma.vismedDoctor.findMany.mockResolvedValue([6983, 2, 3, 4, 5].map(vismedId => ({ vismedId })));
        expect((await s.gate.check('clinic', 2))).toEqual({ state: 'unknown', reason: 'abnormal_roster_drop' });
        expect((await s.gate.check('clinic', 6983)).state).toBe('enabled');
        expect(s.prisma.mapping.findMany).toHaveBeenCalledWith({
            where: { clinicId: 'clinic', entityType: 'DOCTOR', status: 'LINKED', vismedId: { not: null } },
            select: { vismedId: true },
        });
        expect(s.prisma.vismedDoctor.findMany).toHaveBeenCalledWith({
            where: { id: { in: ['local-1', 'local-2', 'local-3', 'local-4', 'local-5'] }, isActive: true },
            select: { vismedId: true },
        });
    });
    it('continues excluding an individual removal from a healthy roster', async () => {
        const s = setup([1, 2, 3, 4].map(id => ({ id, ativo: '1' })));
        s.prisma.mapping.findMany.mockResolvedValue([1, 2, 3, 4, 5].map(id => ({ vismedId: `local-${id}` })));
        s.prisma.vismedDoctor.findMany.mockResolvedValue([1, 2, 3, 4, 5].map(vismedId => ({ vismedId })));
        expect((await s.gate.check('clinic', 5)).state).toBe('excluded');
    });
    it('keeps an explicit disabled flag authoritative without consulting the drop guard', async () => {
        const s = setup([{ id: 6983, mostrarnadoctoralia: '0' }]);
        expect((await s.gate.check('clinic', 6983)).state).toBe('excluded');
        expect(s.prisma.mapping.findMany).not.toHaveBeenCalled();
    });
    it('treats a failed local baseline read as uncertain instead of authorizing cleanup', async () => {
        const s = setup([{ id: 7, ativo: '1' }]);
        s.prisma.mapping.findMany.mockRejectedValue(new Error('database unavailable'));
        expect((await s.gate.check('clinic', 6983)).state).toBe('unknown');
    });
    it.each([null, {}, { data: [] }, [{ nome: 'invalid' }], [{ id: 1, idprofissional: 2 }], [{ id: 1 }, { id: 1 }], [{ id: 6983, mostrarnadoctoralia: null }]].map(body => [body]))('fails closed without destructive cleanup on invalid data: %j', async body => {
        expect((await setup(body).gate.check('clinic', 6983)).state).toBe('unknown');
    });
    it('does not treat network failure as a disabled professional', async () => {
        const s = setup(); s.vismed.getProfissionaisForEligibility.mockRejectedValue(new Error('timeout'));
        expect((await s.gate.check('clinic', 6983)).state).toBe('unknown');
    });
    it('does not reuse a stale positive result after an empty roster', async () => {
        const s = setup(); expect((await s.gate.check('clinic', 6983)).state).toBe('enabled');
        s.vismed.getProfissionaisForEligibility.mockResolvedValue([]);
        expect((await s.gate.check('clinic', 6983)).state).toBe('unknown');
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
