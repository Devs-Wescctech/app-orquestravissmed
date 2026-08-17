/**
 * WP3 — Testes do executor de breaks administrativos (AdminBlockBreakSyncService).
 *
 * Cobre:
 *  - Flag off → no-op absoluto (nenhuma chamada Doctoralia, nenhum registro).
 *  - Shadow → apenas logs/auditoria; ZERO escrita na Doctoralia; nenhum vínculo real criado.
 *  - Active: ciclo completo criar/mover/apagar, múltiplos endereços.
 *  - Fonte única de período: since/till vêm do parser estrito (raw malformado "011:0"
 *    normalizado), NUNCA de periodStart/periodEnd do snapshot (registros com valores
 *    envenenados provam que não são lidos).
 *  - Parser null → skip fail-safe + auditoria BLOCK_PERIOD_UNRECOVERABLE, nenhum break.
 *  - Coexistência sentinela (addressId='') × vínculo real: sentinelas nunca tocadas
 *    nem promovidas.
 *  - Breaks desconhecidos/do BookingSync nunca apagados (DELETE só usa breakId da tabela).
 *  - 409 → adoção por match ±60s; timeout no POST → reconciliação por GET;
 *    timeout no PATCH → confirmação por GET.
 *  - Executor funciona integralmente SEM scheduleDay (dependências não incluem
 *    VismedAvailabilityService por construção).
 */

import { AdminBlockBreakSyncService } from './admin-block-break-sync.service';
import { AdminBlockBreakService, AdminBlockBreakStatus } from './admin-block-break.service';
import { VismedBlockPeriodAuditService } from './vismed-block-period-audit.service';

// ─── Mocks base ─────────────────────────────────────────────────────────────

function naturalKey(r: any) {
    return `${r.clinicId}|${r.idprofissional}|${r.dataagendamento}|${r.horarioagendamento}|${r.addressId}`;
}

function makePrismaMock(store: Map<string, any>, opts: { doctor?: any } = {}) {
    const auditLogs: any[] = [];
    return {
        auditLogs,
        auditLog: {
            create: jest.fn(async ({ data }: any) => { auditLogs.push(data); return data; }),
        },
        vismedDoctor: {
            findUnique: jest.fn(async () => opts.doctor ?? {
                id: 'vd-1',
                name: 'Dr. Teste',
                unifiedMappings: [{
                    isActive: true,
                    doctoraliaDoctor: { doctoraliaDoctorId: 'doc-ext-1', doctoraliaFacilityId: 'fac-1' },
                }],
            }),
        },
        adminBlockBreak: {
            upsert: jest.fn(async ({ where, create, update }: any) => {
                const key = naturalKey(where.clinicId_idprofissional_dataagendamento_horarioagendamento_addressId);
                const existing = [...store.values()].find(r => naturalKey(r) === key);
                if (existing) {
                    const updated = { ...existing, ...update, updatedAt: new Date() };
                    store.set(existing.id, updated);
                    return updated;
                }
                const created = { id: `uuid-${store.size + 1}`, ...create, createdAt: new Date(), updatedAt: new Date() };
                store.set(created.id, created);
                return created;
            }),
            findMany: jest.fn(async ({ where }: any) => {
                return [...store.values()].filter(r =>
                    (where.clinicId === undefined || r.clinicId === where.clinicId) &&
                    (where.idprofissional === undefined || r.idprofissional === where.idprofissional) &&
                    (where.status === undefined || r.status === where.status) &&
                    (where.addressId === undefined || r.addressId === where.addressId),
                );
            }),
            findUnique: jest.fn(async ({ where }: any) => {
                const key = naturalKey(where.clinicId_idprofissional_dataagendamento_horarioagendamento_addressId);
                return [...store.values()].find(r => naturalKey(r) === key) ?? null;
            }),
            update: jest.fn(async ({ where, data }: any) => {
                const key = naturalKey(where.clinicId_idprofissional_dataagendamento_horarioagendamento_addressId);
                const existing = [...store.values()].find(r => naturalKey(r) === key);
                if (!existing) { const e: any = new Error('not found'); e.code = 'P2025'; throw e; }
                const updated = { ...existing, ...data };
                store.set(existing.id, updated);
                return updated;
            }),
            updateMany: jest.fn(async ({ where, data }: any) => {
                let count = 0;
                for (const [id, r] of store) {
                    const match = (!where.id || where.id.in.includes(r.id)) &&
                        (where.clinicId === undefined || r.clinicId === where.clinicId) &&
                        (where.idprofissional === undefined || r.idprofissional === where.idprofissional) &&
                        (where.addressId === undefined || r.addressId === where.addressId) &&
                        (where.status === undefined || r.status === where.status);
                    if (match) { store.set(id, { ...r, ...data }); count++; }
                }
                return { count };
            }),
        },
    };
}

function makeClientMock(overrides: Partial<any> = {}) {
    let nextId = 1;
    return {
        getAddresses: jest.fn(async () => ({ _items: [{ id: 'addr-1' }, { id: 'addr-2' }] })),
        addCalendarBreak: jest.fn(async () => ({ id: `brk-${nextId++}` })),
        moveCalendarBreak: jest.fn(async () => ({})),
        deleteCalendarBreak: jest.fn(async () => ({})),
        getCalendarBreaks: jest.fn(async () => ({ _items: [] })),
        getCalendarBreak: jest.fn(async () => ({})),
        ...overrides,
    };
}

const rateLimiter = { acquire: jest.fn(async () => undefined) } as any;

function makeService(prisma: any) {
    const abb = new AdminBlockBreakService(prisma as any);
    const audit = new VismedBlockPeriodAuditService(prisma as any);
    return new AdminBlockBreakSyncService(prisma as any, abb, audit, rateLimiter);
}

function rawBlock(overrides: Partial<any> = {}) {
    return {
        idprofissional: 42,
        idbloqueio: 'blk-1',
        dataagendamento: '2026-09-01',
        horarioagendamento: '09:00',
        horarioagendamentofinal: '011:0', // malformado real de produção → parser estrito → 11:00
        ...overrides,
    };
}

function baseInput(client: any, rawBlocks: any[]) {
    return { clinicId: 'clinic-1', clinicName: 'Clínica Teste', idprofissional: 42, rawBlocks, client };
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.clearAllMocks();
});

function setMode(mode: string, activeClinics = '') {
    process.env.ADMIN_BLOCK_BREAK_SYNC_MODE = mode;
    process.env.ADMIN_BLOCK_BREAK_SYNC_ACTIVE_CLINICS = activeClinics;
}

// ─── Testes ─────────────────────────────────────────────────────────────────

describe('AdminBlockBreakSyncService — flag/modo', () => {
    it('flag off (default) → no-op absoluto: nenhuma chamada Doctoralia, nenhuma escrita', async () => {
        delete process.env.ADMIN_BLOCK_BREAK_SYNC_MODE;
        const store = new Map();
        const prisma = makePrismaMock(store);
        const client = makeClientMock();
        const res = await makeService(prisma).syncDoctorBlocks(baseInput(client, [rawBlock()]));
        expect(res.mode).toBe('off');
        expect(client.getAddresses).not.toHaveBeenCalled();
        expect(client.addCalendarBreak).not.toHaveBeenCalled();
        expect(prisma.adminBlockBreak.upsert).not.toHaveBeenCalled();
    });

    it('modo shadow: só logs/auditoria — ZERO escrita na Doctoralia e nenhum vínculo real', async () => {
        setMode('shadow');
        const store = new Map();
        const prisma = makePrismaMock(store);
        const client = makeClientMock();
        const res = await makeService(prisma).syncDoctorBlocks(baseInput(client, [rawBlock()]));
        expect(res.mode).toBe('shadow');
        expect(res.ok).toBe(true);
        expect(res.planned.create).toBe(2); // 1 bloqueio × 2 endereços
        expect(res.executed).toEqual({ create: 0, move: 0, delete: 0 });
        expect(client.addCalendarBreak).not.toHaveBeenCalled();
        expect(client.moveCalendarBreak).not.toHaveBeenCalled();
        expect(client.deleteCalendarBreak).not.toHaveBeenCalled();
        expect(store.size).toBe(0); // nenhum vínculo real persistido em shadow
        const shadowAudit = prisma.auditLogs.find(a => a.action === 'ADMIN_BLOCK_BREAK_SHADOW_PLAN');
        expect(shadowAudit).toBeDefined();
        expect(shadowAudit.details.creates).toHaveLength(2);
    });

    it('clínica na lista ACTIVE_CLINICS → active; fora da lista → shadow', () => {
        setMode('shadow', 'clinic-1,clinic-9');
        const svc = makeService(makePrismaMock(new Map()));
        expect(svc.resolveMode('clinic-1')).toBe('active');
        expect(svc.resolveMode('clinic-2')).toBe('shadow');
        setMode('off', 'clinic-1');
        expect(svc.resolveMode('clinic-1')).toBe('off');
    });
});

describe('AdminBlockBreakSyncService — active: criar/mover/apagar', () => {
    beforeEach(() => setMode('shadow', 'clinic-1'));

    it('cria um break por endereço, com since/till do parser estrito (raw "011:0" → 11:00)', async () => {
        const store = new Map();
        const prisma = makePrismaMock(store);
        const client = makeClientMock();
        const res = await makeService(prisma).syncDoctorBlocks(baseInput(client, [rawBlock()]));
        expect(res.ok).toBe(true);
        expect(res.executed.create).toBe(2);
        expect(client.addCalendarBreak).toHaveBeenCalledTimes(2);
        for (const call of client.addCalendarBreak.mock.calls) {
            expect(call[3]).toEqual({ since: '2026-09-01T09:00:00-03:00', till: '2026-09-01T11:00:00-03:00' });
        }
        const links = [...store.values()];
        expect(links).toHaveLength(2);
        expect(new Set(links.map(l => l.addressId))).toEqual(new Set(['addr-1', 'addr-2']));
        for (const l of links) {
            expect(l.doctoraliaBreakId).toBeTruthy();
            // Período persistido = parser estrito (11:00, NÃO fallback +30min = 09:30)
            expect(l.periodEnd.getHours()).toBe(11);
        }
    });

    it('período NUNCA vem de periodStart/periodEnd do snapshot: sentinela envenenada é ignorada', async () => {
        const store = new Map();
        // Sentinela do BlockWatcher (addressId='') com período INVENTADO pelo fallback +30min
        store.set('s1', {
            id: 's1', clinicId: 'clinic-1', idprofissional: 42,
            dataagendamento: '2026-09-01', horarioagendamento: '09:00', addressId: '',
            rawEndTime: '011:0',
            periodStart: new Date('2026-09-01T09:00:00-03:00'),
            periodEnd: new Date('2026-09-01T09:30:00-03:00'), // fallback +30min ENVENENADO
            periodHash: 'x', facilityId: 'fac-1', doctoraliaBreakId: null,
            status: AdminBlockBreakStatus.ACTIVE,
        });
        const prisma = makePrismaMock(store);
        const client = makeClientMock();
        await makeService(prisma).syncDoctorBlocks(baseInput(client, [rawBlock()]));
        // Breaks criados com till=11:00 (parser), jamais 09:30 (snapshot)
        for (const call of client.addCalendarBreak.mock.calls) {
            expect(call[3].till).toBe('2026-09-01T11:00:00-03:00');
        }
        // Sentinela intocada: não promovida, não cancelada, sem breakId
        const sentinel = store.get('s1');
        expect(sentinel.addressId).toBe('');
        expect(sentinel.doctoraliaBreakId).toBeNull();
        expect(sentinel.status).toBe(AdminBlockBreakStatus.ACTIVE);
        // Coexistência: sentinela + 2 vínculos reais
        expect(store.size).toBe(3);
    });

    it('período alterado → moveCalendarBreak com novo since/till do parser', async () => {
        const store = new Map();
        store.set('r1', {
            id: 'r1', clinicId: 'clinic-1', idprofissional: 42,
            dataagendamento: '2026-09-01', horarioagendamento: '09:00', addressId: 'addr-1',
            rawEndTime: '10:00', periodStart: new Date(), periodEnd: new Date(),
            periodHash: 'OLD-HASH', facilityId: 'fac-1', doctoraliaBreakId: 'brk-old',
            status: AdminBlockBreakStatus.ACTIVE,
        });
        const prisma = makePrismaMock(store);
        const client = makeClientMock({ getAddresses: jest.fn(async () => ({ _items: [{ id: 'addr-1' }] })) });
        const res = await makeService(prisma).syncDoctorBlocks(baseInput(client, [rawBlock()]));
        expect(res.executed.move).toBe(1);
        expect(client.moveCalendarBreak).toHaveBeenCalledWith(
            'fac-1', 'doc-ext-1', 'addr-1', 'brk-old',
            { since: '2026-09-01T09:00:00-03:00', till: '2026-09-01T11:00:00-03:00' },
        );
        expect(store.get('r1').periodHash).not.toBe('OLD-HASH');
    });

    it('bloqueio removido → apaga SOMENTE o break da própria tabela e cancela o vínculo', async () => {
        const store = new Map();
        store.set('r1', {
            id: 'r1', clinicId: 'clinic-1', idprofissional: 42,
            dataagendamento: '2026-09-01', horarioagendamento: '09:00', addressId: 'addr-1',
            rawEndTime: '011:0', periodStart: new Date(), periodEnd: new Date(),
            periodHash: 'h', facilityId: 'fac-1', doctoraliaBreakId: 'brk-mine',
            status: AdminBlockBreakStatus.ACTIVE,
        });
        // Sentinela do mesmo bloqueio deve permanecer intocada
        store.set('s1', {
            id: 's1', clinicId: 'clinic-1', idprofissional: 42,
            dataagendamento: '2026-09-01', horarioagendamento: '09:00', addressId: '',
            rawEndTime: '011:0', periodStart: new Date(), periodEnd: new Date(),
            periodHash: 'h', facilityId: 'fac-1', doctoraliaBreakId: null,
            status: AdminBlockBreakStatus.ACTIVE,
        });
        const prisma = makePrismaMock(store);
        const client = makeClientMock({ getAddresses: jest.fn(async () => ({ _items: [{ id: 'addr-1' }] })) });
        const res = await makeService(prisma).syncDoctorBlocks(baseInput(client, [])); // bloqueios sumiram
        expect(res.executed.delete).toBe(1);
        // DELETE usa exclusivamente o breakId persistido — breaks desconhecidos/do
        // BookingSync jamais são alvo (não há listagem+deleção genérica).
        expect(client.deleteCalendarBreak).toHaveBeenCalledTimes(1);
        expect(client.deleteCalendarBreak).toHaveBeenCalledWith('fac-1', 'doc-ext-1', 'addr-1', 'brk-mine');
        expect(store.get('r1').status).toBe(AdminBlockBreakStatus.CANCELLED);
        expect(store.get('s1').status).toBe(AdminBlockBreakStatus.ACTIVE); // sentinela intocada
    });

    it('parser null (minuto ambíguo "011:1") → NENHUM break, skip auditado', async () => {
        const store = new Map();
        const prisma = makePrismaMock(store);
        const client = makeClientMock();
        const res = await makeService(prisma).syncDoctorBlocks(
            baseInput(client, [rawBlock({ horarioagendamentofinal: '011:1' })]),
        );
        expect(res.ok).toBe(true);
        expect(res.skippedUnrecoverable).toBe(1);
        expect(client.addCalendarBreak).not.toHaveBeenCalled();
        expect(store.size).toBe(0);
        expect(prisma.auditLogs.some(a => a.action === 'BLOCK_PERIOD_UNRECOVERABLE')).toBe(true);
    });

    it('bloqueio presente mas irrecuperável NUNCA apaga o break já vinculado (fail-safe)', async () => {
        const store = new Map();
        // Vínculo real criado quando o período ainda era parseável
        store.set('r1', {
            id: 'r1', clinicId: 'clinic-1', idprofissional: 42,
            dataagendamento: '2026-09-01', horarioagendamento: '09:00', addressId: 'addr-1',
            rawEndTime: '11:00', periodStart: new Date(), periodEnd: new Date(),
            periodHash: 'OLD', facilityId: 'fac-1', doctoraliaBreakId: 'brk-keep',
            status: AdminBlockBreakStatus.ACTIVE,
        });
        const prisma = makePrismaMock(store);
        const client = makeClientMock({ getAddresses: jest.fn(async () => ({ _items: [{ id: 'addr-1' }] })) });
        // Mesmo bloqueio ainda existe na VisMed, mas o fim virou irrecuperável ("011:1")
        const res = await makeService(prisma).syncDoctorBlocks(
            baseInput(client, [rawBlock({ horarioagendamentofinal: '011:1' })]),
        );
        expect(res.ok).toBe(true);
        expect(res.skippedUnrecoverable).toBe(1);
        // Nada apagado, nada movido, nada criado — falha de parsing nunca reabre agenda
        expect(client.deleteCalendarBreak).not.toHaveBeenCalled();
        expect(client.moveCalendarBreak).not.toHaveBeenCalled();
        expect(client.addCalendarBreak).not.toHaveBeenCalled();
        expect(store.get('r1').status).toBe(AdminBlockBreakStatus.ACTIVE);
        expect(store.get('r1').doctoraliaBreakId).toBe('brk-keep');
    });

    it('idempotência: segundo ciclo sem mudanças não gera nenhuma escrita Doctoralia', async () => {
        const store = new Map();
        const prisma = makePrismaMock(store);
        const client = makeClientMock();
        const svc = makeService(prisma);
        await svc.syncDoctorBlocks(baseInput(client, [rawBlock()]));
        client.addCalendarBreak.mockClear();
        client.moveCalendarBreak.mockClear();
        client.deleteCalendarBreak.mockClear();
        const res2 = await svc.syncDoctorBlocks(baseInput(client, [rawBlock()]));
        expect(res2.planned).toEqual({ create: 0, move: 0, delete: 0 });
        expect(client.addCalendarBreak).not.toHaveBeenCalled();
        expect(client.moveCalendarBreak).not.toHaveBeenCalled();
        expect(client.deleteCalendarBreak).not.toHaveBeenCalled();
    });
});

describe('AdminBlockBreakSyncService — resiliência 409/timeout', () => {
    beforeEach(() => setMode('shadow', 'clinic-1'));

    function singleAddrClient(overrides: Partial<any> = {}) {
        return makeClientMock({ getAddresses: jest.fn(async () => ({ _items: [{ id: 'addr-1' }] })), ...overrides });
    }

    it('409 no POST → adota break remoto por match since/till ±60s', async () => {
        const store = new Map();
        const prisma = makePrismaMock(store);
        const client = singleAddrClient({
            addCalendarBreak: jest.fn(async () => { throw new Error('HTTP 409 Conflict'); }),
            getCalendarBreaks: jest.fn(async () => ({
                _items: [{ id: 'brk-remote', since: '2026-09-01T09:00:00-03:00', till: '2026-09-01T11:00:00-03:00' }],
            })),
        });
        const res = await makeService(prisma).syncDoctorBlocks(baseInput(client, [rawBlock()]));
        expect(res.ok).toBe(true);
        expect([...store.values()][0].doctoraliaBreakId).toBe('brk-remote');
    });

    it('timeout no POST → reconcilia por GET e adota; sem match → falha re-tentável', async () => {
        const abort = () => { const e: any = new Error('aborted'); e.name = 'AbortError'; return e; };
        // Caso 1: remoto existe → adota
        {
            const store = new Map();
            const prisma = makePrismaMock(store);
            const client = singleAddrClient({
                addCalendarBreak: jest.fn(async () => { throw abort(); }),
                getCalendarBreaks: jest.fn(async () => ({
                    _items: [{ id: 'brk-after-timeout', since: '2026-09-01T09:00:00-03:00', till: '2026-09-01T11:00:00-03:00' }],
                })),
            });
            const res = await makeService(prisma).syncDoctorBlocks(baseInput(client, [rawBlock()]));
            expect(res.ok).toBe(true);
            expect([...store.values()][0].doctoraliaBreakId).toBe('brk-after-timeout');
        }
        // Caso 2: remoto não existe → ok:false (BlockWatcher redetecta no próximo ciclo)
        {
            const store = new Map();
            const prisma = makePrismaMock(store);
            const client = singleAddrClient({
                addCalendarBreak: jest.fn(async () => { throw abort(); }),
                getCalendarBreaks: jest.fn(async () => ({ _items: [] })),
            });
            const res = await makeService(prisma).syncDoctorBlocks(baseInput(client, [rawBlock()]));
            expect(res.ok).toBe(false);
            expect(store.size).toBe(0); // nada persistido — retry seguro
        }
    });

    it('timeout no PATCH → confirma por GET do próprio break antes de falhar', async () => {
        const store = new Map();
        store.set('r1', {
            id: 'r1', clinicId: 'clinic-1', idprofissional: 42,
            dataagendamento: '2026-09-01', horarioagendamento: '09:00', addressId: 'addr-1',
            rawEndTime: '10:00', periodStart: new Date(), periodEnd: new Date(),
            periodHash: 'OLD', facilityId: 'fac-1', doctoraliaBreakId: 'brk-1',
            status: AdminBlockBreakStatus.ACTIVE,
        });
        const prisma = makePrismaMock(store);
        const client = singleAddrClient({
            moveCalendarBreak: jest.fn(async () => { const e: any = new Error('aborted'); e.name = 'AbortError'; throw e; }),
            getCalendarBreak: jest.fn(async () => ({ since: '2026-09-01T09:00:00-03:00', till: '2026-09-01T11:00:00-03:00' })),
        });
        const res = await makeService(prisma).syncDoctorBlocks(baseInput(client, [rawBlock()]));
        expect(res.ok).toBe(true);
        expect(res.executed.move).toBe(1);
    });

    it('404 no PATCH → recria o break', async () => {
        const store = new Map();
        store.set('r1', {
            id: 'r1', clinicId: 'clinic-1', idprofissional: 42,
            dataagendamento: '2026-09-01', horarioagendamento: '09:00', addressId: 'addr-1',
            rawEndTime: '10:00', periodStart: new Date(), periodEnd: new Date(),
            periodHash: 'OLD', facilityId: 'fac-1', doctoraliaBreakId: 'brk-gone',
            status: AdminBlockBreakStatus.ACTIVE,
        });
        const prisma = makePrismaMock(store);
        const client = singleAddrClient({
            moveCalendarBreak: jest.fn(async () => { throw new Error('HTTP 404 Not Found'); }),
        });
        const res = await makeService(prisma).syncDoctorBlocks(baseInput(client, [rawBlock()]));
        expect(res.ok).toBe(true);
        expect(client.addCalendarBreak).toHaveBeenCalledTimes(1);
        expect(store.get('r1').doctoraliaBreakId).toBe('brk-1'); // novo id do POST mock
    });
});

describe('AdminBlockBreakSyncService — independência de scheduleDay', () => {
    it('executor completa o ciclo inteiro sem NENHUMA dependência de scheduleDay', async () => {
        // Por construção: as únicas dependências são prisma, AdminBlockBreakService,
        // VismedBlockPeriodAuditService e RateLimiter — nenhum VismedAvailabilityService
        // ou VismedService (scheduleDay) é injetado ou acessível.
        setMode('shadow', 'clinic-1');
        const store = new Map();
        const prisma = makePrismaMock(store);
        const client = makeClientMock();
        const svc = makeService(prisma);
        const res = await svc.syncDoctorBlocks(baseInput(client, [rawBlock()]));
        expect(res.ok).toBe(true);
        expect(res.executed.create).toBe(2);
        // Nenhuma propriedade relacionada a scheduleDay/availability existe no serviço
        for (const k of Object.getOwnPropertyNames(svc)) {
            expect(k.toLowerCase()).not.toContain('avail');
            expect(k.toLowerCase()).not.toContain('vismed');
        }
    });
});
