/**
 * WP1 — Testes da camada de acesso AdminBlockBreak.
 *
 * Cobre:
 *  - Idempotência do upsert (mesmo resultado em chamadas repetidas)
 *  - Unicidade da chave natural (clínica+médico+data+hora+endereço)
 *  - Múltiplos endereços por bloqueio (1 bloqueio → N registros, um por addressId)
 *  - cancel() idempotente (não lança se registro não existe)
 *  - cancelAllForDoctor() cobre todos os endereços ativos
 *  - findByNaturalKey retorna null quando ausente
 *  - computeBlockPeriodHash é determinístico
 */

import { AdminBlockBreakService, AdminBlockBreakStatus, computeBlockPeriodHash, reconstructDoctorHash, BlockBreakUpsertData } from './admin-block-break.service';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<any> = {}) {
    return {
        id: 'uuid-1',
        clinicId: 'clinic-1',
        idprofissional: 42,
        dataagendamento: '2026-08-17',
        horarioagendamento: '09:00',
        addressId: 'addr-1',
        periodStart: new Date('2026-08-17T12:00:00.000Z'),
        periodEnd: new Date('2026-08-17T12:30:00.000Z'),
        periodHash: 'deadbeef',
        facilityId: 'fac-1',
        doctoraliaBreakId: null,
        status: AdminBlockBreakStatus.ACTIVE,
        lastSyncAttemptAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
}

/** Minimal in-memory store backing the Prisma mock. */
function makeStore(): Map<string, any> {
    return new Map();
}

function naturalKey(r: any) {
    return `${r.clinicId}|${r.idprofissional}|${r.dataagendamento}|${r.horarioagendamento}|${r.addressId}`;
}

function makePrismaMock(store: Map<string, any>) {
    return {
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
                return [...store.values()].filter(r => {
                    if (where.clinicId && r.clinicId !== where.clinicId) return false;
                    if (where.idprofissional !== undefined && r.idprofissional !== where.idprofissional) return false;
                    if (where.status && r.status !== where.status) return false;
                    if (where.addressId !== undefined && r.addressId !== where.addressId) return false;
                    return true;
                });
            }),
            findUnique: jest.fn(async ({ where }: any) => {
                const key = naturalKey(where.clinicId_idprofissional_dataagendamento_horarioagendamento_addressId);
                return [...store.values()].find(r => naturalKey(r) === key) ?? null;
            }),
            update: jest.fn(async ({ where, data }: any) => {
                const key = naturalKey(where.clinicId_idprofissional_dataagendamento_horarioagendamento_addressId);
                const existing = [...store.values()].find(r => naturalKey(r) === key);
                if (!existing) {
                    const err: any = new Error('Record not found');
                    err.code = 'P2025';
                    throw err;
                }
                const updated = { ...existing, ...data, updatedAt: new Date() };
                store.set(existing.id, updated);
                return updated;
            }),
            updateMany: jest.fn(async ({ where, data }: any) => {
                let count = 0;
                for (const [id, r] of store) {
                    if (where.clinicId && r.clinicId !== where.clinicId) continue;
                    if (where.idprofissional !== undefined && r.idprofissional !== where.idprofissional) continue;
                    if (where.status && r.status !== where.status) continue;
                    if (where.addressId !== undefined && r.addressId !== where.addressId) continue;
                    // Handle id: { in: [...] } for reconcile stale cancellation
                    if (where.id?.in && !where.id.in.includes(id)) continue;
                    store.set(id, { ...r, ...data, updatedAt: new Date() });
                    count++;
                }
                return { count };
            }),
        },
    };
}

// ─── computeBlockPeriodHash ──────────────────────────────────────────────────

describe('computeBlockPeriodHash', () => {
    const params = {
        horarioagendamento: '09:00',
        horarioagendamentofinal: '09:30',
        dataagendamento: '2026-08-17',
    };

    it('é determinístico: mesmos inputs → mesmo hash', () => {
        expect(computeBlockPeriodHash(params)).toBe(computeBlockPeriodHash(params));
    });

    it('difere quando horário de início muda', () => {
        const changed = { ...params, horarioagendamento: '10:00' };
        expect(computeBlockPeriodHash(params)).not.toBe(computeBlockPeriodHash(changed));
    });

    it('difere quando data muda', () => {
        const changed = { ...params, dataagendamento: '2026-08-18' };
        expect(computeBlockPeriodHash(params)).not.toBe(computeBlockPeriodHash(changed));
    });

    it('difere quando horário final muda (mesmo que malformado)', () => {
        const changed = { ...params, horarioagendamentofinal: '10:00' };
        expect(computeBlockPeriodHash(params)).not.toBe(computeBlockPeriodHash(changed));
    });

    it('tolera valores undefined/null sem lançar', () => {
        expect(() =>
            computeBlockPeriodHash({
                horarioagendamento: undefined as any,
                horarioagendamentofinal: null as any,
                dataagendamento: '',
            }),
        ).not.toThrow();
    });
});

// ─── AdminBlockBreakService ──────────────────────────────────────────────────

describe('AdminBlockBreakService', () => {
    let store: Map<string, any>;
    let svc: AdminBlockBreakService;

    const BASE: BlockBreakUpsertData = {
        clinicId: 'clinic-1',
        idprofissional: 42,
        dataagendamento: '2026-08-17',
        horarioagendamento: '09:00',
        addressId: 'addr-1',
        periodStart: new Date('2026-08-17T12:00:00.000Z'),
        periodEnd: new Date('2026-08-17T12:30:00.000Z'),
        facilityId: 'fac-1',
    };

    beforeEach(() => {
        store = makeStore();
        svc = new AdminBlockBreakService(makePrismaMock(store) as any);
    });

    // ── upsert: criação ─────────────────────────────────────────────────────

    it('cria um registro novo na primeira chamada', async () => {
        const result = await svc.upsert(BASE);
        expect(result.clinicId).toBe('clinic-1');
        expect(result.idprofissional).toBe(42);
        expect(result.status).toBe(AdminBlockBreakStatus.ACTIVE);
        expect(store.size).toBe(1);
    });

    it('grava periodHash determinístico (SHA-256, não vazio)', async () => {
        const result = await svc.upsert(BASE);
        expect(result.periodHash).toMatch(/^[a-f0-9]{64}$/);
    });

    // ── upsert: idempotência ────────────────────────────────────────────────

    it('upsert repetido não duplica o registro (idempotência)', async () => {
        await svc.upsert(BASE);
        await svc.upsert(BASE);
        expect(store.size).toBe(1);
    });

    it('upsert repetido retorna o registro existente atualizado', async () => {
        const first = await svc.upsert(BASE);
        const second = await svc.upsert(BASE);
        expect(second.id).toBe(first.id);
    });

    it('upsert com período diferente atualiza hash sem criar novo registro', async () => {
        const first = await svc.upsert(BASE);
        const updated = await svc.upsert({
            ...BASE,
            periodStart: new Date('2026-08-17T13:00:00.000Z'),
            periodEnd: new Date('2026-08-17T13:30:00.000Z'),
        });
        expect(store.size).toBe(1);
        expect(updated.id).toBe(first.id);
        expect(updated.periodHash).not.toBe(first.periodHash);
    });

    it('upsert com doctoraliaBreakId atualiza o campo', async () => {
        await svc.upsert(BASE);
        const linked = await svc.upsert({ ...BASE, doctoraliaBreakId: 'break-123' });
        expect(linked.doctoraliaBreakId).toBe('break-123');
        expect(store.size).toBe(1);
    });

    // ── unicidade da chave natural ──────────────────────────────────────────

    it('chaves naturais distintas por clinicId criam registros separados', async () => {
        await svc.upsert(BASE);
        await svc.upsert({ ...BASE, clinicId: 'clinic-2' });
        expect(store.size).toBe(2);
    });

    it('chaves naturais distintas por idprofissional criam registros separados', async () => {
        await svc.upsert(BASE);
        await svc.upsert({ ...BASE, idprofissional: 99 });
        expect(store.size).toBe(2);
    });

    it('chaves naturais distintas por dataagendamento criam registros separados', async () => {
        await svc.upsert(BASE);
        await svc.upsert({ ...BASE, dataagendamento: '2026-08-18' });
        expect(store.size).toBe(2);
    });

    it('chaves naturais distintas por horarioagendamento criam registros separados', async () => {
        await svc.upsert(BASE);
        await svc.upsert({ ...BASE, horarioagendamento: '10:00' });
        expect(store.size).toBe(2);
    });

    // ── múltiplos endereços por bloqueio ────────────────────────────────────

    it('um bloqueio → N breaks: endereços distintos criam N registros', async () => {
        const addresses = ['addr-1', 'addr-2', 'addr-3'];
        for (const addressId of addresses) {
            await svc.upsert({ ...BASE, addressId });
        }
        expect(store.size).toBe(3);
    });

    it('upsert repetido para cada endereço não duplica (idempotência multi-endereço)', async () => {
        const addresses = ['addr-1', 'addr-2'];
        for (const addressId of addresses) {
            await svc.upsert({ ...BASE, addressId });
            await svc.upsert({ ...BASE, addressId }); // repetição
        }
        expect(store.size).toBe(2);
    });

    it('findActiveByDoctor retorna todos os endereços do mesmo bloqueio', async () => {
        await svc.upsert({ ...BASE, addressId: 'addr-1' });
        await svc.upsert({ ...BASE, addressId: 'addr-2' });
        await svc.upsert({ ...BASE, addressId: 'addr-3' });
        const results = await svc.findActiveByDoctor('clinic-1', 42);
        expect(results).toHaveLength(3);
    });

    // ── findByNaturalKey ────────────────────────────────────────────────────

    it('findByNaturalKey retorna null quando registro não existe', async () => {
        const result = await svc.findByNaturalKey({
            clinicId: 'clinic-1',
            idprofissional: 42,
            dataagendamento: '2026-08-17',
            horarioagendamento: '09:00',
            addressId: 'addr-inexistente',
        });
        expect(result).toBeNull();
    });

    it('findByNaturalKey retorna o registro correto quando existe', async () => {
        await svc.upsert(BASE);
        const found = await svc.findByNaturalKey({
            clinicId: BASE.clinicId,
            idprofissional: BASE.idprofissional,
            dataagendamento: BASE.dataagendamento,
            horarioagendamento: BASE.horarioagendamento,
            addressId: BASE.addressId,
        });
        expect(found).not.toBeNull();
        expect(found!.clinicId).toBe('clinic-1');
    });

    // ── findActiveByClinic ──────────────────────────────────────────────────

    it('findActiveByClinic retorna apenas registros ACTIVE desta clínica', async () => {
        await svc.upsert(BASE);
        await svc.upsert({ ...BASE, clinicId: 'clinic-2' });
        const results = await svc.findActiveByClinic('clinic-1');
        expect(results).toHaveLength(1);
        expect(results[0].clinicId).toBe('clinic-1');
    });

    it('findActiveByClinic exclui registros CANCELLED', async () => {
        await svc.upsert(BASE);
        await svc.cancel({
            clinicId: BASE.clinicId,
            idprofissional: BASE.idprofissional,
            dataagendamento: BASE.dataagendamento,
            horarioagendamento: BASE.horarioagendamento,
            addressId: BASE.addressId,
        });
        const results = await svc.findActiveByClinic('clinic-1');
        expect(results).toHaveLength(0);
    });

    // ── cancel ──────────────────────────────────────────────────────────────

    it('cancel muda status para CANCELLED', async () => {
        await svc.upsert(BASE);
        const cancelled = await svc.cancel({
            clinicId: BASE.clinicId,
            idprofissional: BASE.idprofissional,
            dataagendamento: BASE.dataagendamento,
            horarioagendamento: BASE.horarioagendamento,
            addressId: BASE.addressId,
        });
        expect(cancelled?.status).toBe(AdminBlockBreakStatus.CANCELLED);
    });

    it('cancel retorna null (não lança) quando registro não existe', async () => {
        const result = await svc.cancel({
            clinicId: 'clinic-inexistente',
            idprofissional: 0,
            dataagendamento: '2000-01-01',
            horarioagendamento: '00:00',
            addressId: 'addr-x',
        });
        expect(result).toBeNull();
    });

    it('cancel repetido é idempotente (não lança na segunda chamada)', async () => {
        await svc.upsert(BASE);
        const key = {
            clinicId: BASE.clinicId,
            idprofissional: BASE.idprofissional,
            dataagendamento: BASE.dataagendamento,
            horarioagendamento: BASE.horarioagendamento,
            addressId: BASE.addressId,
        };
        await svc.cancel(key);
        // segunda chamada: registro já CANCELLED → update chama update novamente (idempotente)
        await expect(svc.cancel(key)).resolves.not.toThrow();
    });

    // ── cancelAllForDoctor ──────────────────────────────────────────────────

    it('cancelAllForDoctor cancela todos os endereços ativos do médico', async () => {
        await svc.upsert({ ...BASE, addressId: 'addr-1' });
        await svc.upsert({ ...BASE, addressId: 'addr-2' });
        await svc.upsert({ ...BASE, addressId: 'addr-3' });

        const result = await svc.cancelAllForDoctor('clinic-1', 42);
        expect(result.count).toBe(3);

        const remaining = await svc.findActiveByDoctor('clinic-1', 42);
        expect(remaining).toHaveLength(0);
    });

    it('cancelAllForDoctor não cancela médicos de outras clínicas', async () => {
        await svc.upsert({ ...BASE, clinicId: 'clinic-1', addressId: 'addr-1' });
        await svc.upsert({ ...BASE, clinicId: 'clinic-2', addressId: 'addr-1' });

        await svc.cancelAllForDoctor('clinic-1', 42);

        const remaining = await svc.findActiveByClinic('clinic-2');
        expect(remaining).toHaveLength(1);
    });

    it('cancelAllForDoctor retorna count=0 quando não há registros ativos', async () => {
        const result = await svc.cancelAllForDoctor('clinic-inexistente', 0);
        expect(result.count).toBe(0);
    });

    // ── rawEndTime e hash raw ───────────────────────────────────────────────

    it('upsert com rawEndTime usa computeBlockPeriodHash (não hash de datas)', async () => {
        const withRaw = await svc.upsert({ ...BASE, rawEndTime: '09:30' });
        const expected = computeBlockPeriodHash({
            horarioagendamento: BASE.horarioagendamento,
            horarioagendamentofinal: '09:30',
            dataagendamento: BASE.dataagendamento,
        });
        expect(withRaw.periodHash).toBe(expected);
    });

    it('upsert com rawEndTime diferente produz hash diferente', async () => {
        const r1 = await svc.upsert({ ...BASE, rawEndTime: '09:30' });
        const r2 = await svc.upsert({ ...BASE, addressId: 'addr-2', rawEndTime: '10:00' });
        expect(r1.periodHash).not.toBe(r2.periodHash);
    });

    it('upsert com periodHash explícito usa o valor fornecido diretamente', async () => {
        const customHash = 'abc123def456';
        const result = await svc.upsert({ ...BASE, periodHash: customHash });
        expect(result.periodHash).toBe(customHash);
    });

    it('upsert sem rawEndTime cai para hash de datas (não lança)', async () => {
        await expect(svc.upsert(BASE)).resolves.not.toThrow();
        const result = await svc.upsert(BASE);
        expect(result.periodHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('rawEndTime malformado não lança no upsert', async () => {
        await expect(svc.upsert({ ...BASE, rawEndTime: '012:0' })).resolves.not.toThrow();
    });

    // ── cancelSnapshotForDoctor ─────────────────────────────────────────────

    it('cancelSnapshotForDoctor cancela apenas registros com addressId=""', async () => {
        // Snapshot record (addressId='')
        await svc.upsert({ ...BASE, addressId: '' });
        // Real break record (addressId real)
        await svc.upsert({ ...BASE, addressId: 'addr-real' });

        await svc.cancelSnapshotForDoctor('clinic-1', 42);

        const active = await svc.findActiveByClinic('clinic-1');
        // Snapshot cancelado; break real ainda ativo
        expect(active).toHaveLength(1);
        expect(active[0].addressId).toBe('addr-real');
    });

    it('cancelSnapshotForDoctor retorna count=0 quando nada há para cancelar', async () => {
        const result = await svc.cancelSnapshotForDoctor('clinic-x', 999);
        expect(result.count).toBe(0);
    });

    // ── reconstructDoctorHash ──────────────────────────────────────────────

    it('reconstructDoctorHash é determinístico (mesma lista → mesmo hash)', () => {
        const blocks = [
            { dataagendamento: '2026-08-17', horarioagendamento: '09:00', rawEndTime: '09:30' },
            { dataagendamento: '2026-08-17', horarioagendamento: '14:00', rawEndTime: '14:30' },
        ];
        expect(reconstructDoctorHash(blocks)).toBe(reconstructDoctorHash(blocks));
    });

    it('reconstructDoctorHash não depende da ordem de entrada', () => {
        const block1 = { dataagendamento: '2026-08-17', horarioagendamento: '09:00', rawEndTime: '09:30' };
        const block2 = { dataagendamento: '2026-08-17', horarioagendamento: '14:00', rawEndTime: '14:30' };
        expect(reconstructDoctorHash([block1, block2])).toBe(reconstructDoctorHash([block2, block1]));
    });

    it('reconstructDoctorHash difere quando bloco é adicionado', () => {
        const block1 = { dataagendamento: '2026-08-17', horarioagendamento: '09:00', rawEndTime: '09:30' };
        const block2 = { dataagendamento: '2026-08-17', horarioagendamento: '14:00', rawEndTime: '14:30' };
        expect(reconstructDoctorHash([block1])).not.toBe(reconstructDoctorHash([block1, block2]));
    });

    // ── loadAllSnapshots ────────────────────────────────────────────────────

    it('loadAllSnapshots retorna mapa vazio quando banco está vazio', async () => {
        const result = await svc.loadAllSnapshots();
        expect(result.size).toBe(0);
    });

    it('loadAllSnapshots reconstrói snapshot por clínica e médico', async () => {
        // Dois blocos do mesmo médico (addressId='') em clinic-1
        await svc.upsert({
            ...BASE, addressId: '', rawEndTime: '09:30',
            dataagendamento: '2026-08-17', horarioagendamento: '09:00',
        });
        await svc.upsert({
            ...BASE, addressId: '', rawEndTime: '14:30',
            dataagendamento: '2026-08-17', horarioagendamento: '14:00',
        });
        // Um bloco de outro médico na mesma clínica
        await svc.upsert({
            ...BASE, idprofissional: 99, addressId: '', rawEndTime: '10:00',
        });

        const snapshots = await svc.loadAllSnapshots();
        expect(snapshots.size).toBe(1); // uma clínica
        const clinicSnap = snapshots.get('clinic-1')!;
        expect(clinicSnap.size).toBe(2); // dois médicos
        expect(clinicSnap.has(42)).toBe(true);
        expect(clinicSnap.has(99)).toBe(true);
    });

    it('loadAllSnapshots exclui registros CANCELLED', async () => {
        await svc.upsert({ ...BASE, addressId: '' });
        await svc.cancelSnapshotForDoctor('clinic-1', 42);

        const snapshots = await svc.loadAllSnapshots();
        expect(snapshots.size).toBe(0);
    });

    it('loadAllSnapshots exclui registros com addressId real (não sentinela)', async () => {
        // Apenas breaks reais (não snapshot)
        await svc.upsert({ ...BASE, addressId: 'addr-real' });

        const snapshots = await svc.loadAllSnapshots();
        expect(snapshots.size).toBe(0);
    });

    // ── reconcileSnapshotForDoctor ──────────────────────────────────────────

    it('reconcileSnapshotForDoctor cancela bloco removido quando médico ainda tem outros', async () => {
        // Persiste A e B
        await svc.upsert({ ...BASE, addressId: '', horarioagendamento: '09:00', rawEndTime: '09:30' });
        await svc.upsert({ ...BASE, addressId: '', horarioagendamento: '14:00', rawEndTime: '14:30' });

        // Agora só B permanece (A desapareceu, C entrou)
        await svc.upsert({ ...BASE, addressId: '', horarioagendamento: '15:00', rawEndTime: '15:30' });
        const result = await svc.reconcileSnapshotForDoctor('clinic-1', 42, [
            { dataagendamento: BASE.dataagendamento, horarioagendamento: '14:00' },
            { dataagendamento: BASE.dataagendamento, horarioagendamento: '15:00' },
        ]);

        // A deve ser cancelado; B e C permanecem
        expect(result.cancelledCount).toBe(1);
        const active = await svc.findActiveByDoctor('clinic-1', 42);
        const activeHoras = active.map(r => r.horarioagendamento).sort();
        expect(activeHoras).toEqual(['14:00', '15:00']);
    });

    it('reconcileSnapshotForDoctor é idempotente quando conjunto não mudou', async () => {
        await svc.upsert({ ...BASE, addressId: '', horarioagendamento: '09:00' });
        await svc.upsert({ ...BASE, addressId: '', horarioagendamento: '14:00' });

        const r1 = await svc.reconcileSnapshotForDoctor('clinic-1', 42, [
            { dataagendamento: BASE.dataagendamento, horarioagendamento: '09:00' },
            { dataagendamento: BASE.dataagendamento, horarioagendamento: '14:00' },
        ]);
        expect(r1.cancelledCount).toBe(0);

        // Segunda chamada igual
        const r2 = await svc.reconcileSnapshotForDoctor('clinic-1', 42, [
            { dataagendamento: BASE.dataagendamento, horarioagendamento: '09:00' },
            { dataagendamento: BASE.dataagendamento, horarioagendamento: '14:00' },
        ]);
        expect(r2.cancelledCount).toBe(0);
    });

    it('reconcileSnapshotForDoctor cancela todos quando currentBlocks é vazio', async () => {
        await svc.upsert({ ...BASE, addressId: '', horarioagendamento: '09:00' });
        await svc.upsert({ ...BASE, addressId: '', horarioagendamento: '14:00' });

        const result = await svc.reconcileSnapshotForDoctor('clinic-1', 42, []);
        expect(result.cancelledCount).toBe(2);

        const active = await svc.findActiveByDoctor('clinic-1', 42);
        expect(active).toHaveLength(0);
    });

    it('reconcileSnapshotForDoctor não toca registros com addressId real', async () => {
        await svc.upsert({ ...BASE, addressId: '', horarioagendamento: '09:00' });
        await svc.upsert({ ...BASE, addressId: 'addr-real', horarioagendamento: '09:00' });

        // Cancela snapshot de 09:00 mas não o break real
        await svc.reconcileSnapshotForDoctor('clinic-1', 42, []);

        const allActive = await svc.findActiveByClinic('clinic-1');
        expect(allActive).toHaveLength(1);
        expect(allActive[0].addressId).toBe('addr-real');
    });

    // ── round-trip A+B → B+C + loadAllSnapshots (simulação restart) ────────

    it('round-trip: A+B → B+C reconcilado → loadAllSnapshots só vê B+C', async () => {
        // Estado inicial: A e B
        await svc.upsert({ ...BASE, addressId: '', horarioagendamento: '09:00', rawEndTime: '09:30' });
        await svc.upsert({ ...BASE, addressId: '', horarioagendamento: '14:00', rawEndTime: '14:30' });

        // Novo estado: B e C (A saiu, C entrou)
        await svc.upsert({ ...BASE, addressId: '', horarioagendamento: '14:00', rawEndTime: '14:30' }); // B ainda
        await svc.upsert({ ...BASE, addressId: '', horarioagendamento: '16:00', rawEndTime: '16:30' }); // C novo
        await svc.reconcileSnapshotForDoctor('clinic-1', 42, [
            { dataagendamento: BASE.dataagendamento, horarioagendamento: '14:00' },
            { dataagendamento: BASE.dataagendamento, horarioagendamento: '16:00' },
        ]);

        // Simula restart: loadAllSnapshots deve retornar apenas B+C
        const snapshots = await svc.loadAllSnapshots();
        const doctorSnap = snapshots.get('clinic-1');
        expect(doctorSnap).toBeDefined();

        // O hash deve ser igual ao que BlockWatcher.hashBlocks computaria para B+C
        const blocksBC = [
            { dataagendamento: BASE.dataagendamento, horarioagendamento: '14:00', rawEndTime: '14:30' },
            { dataagendamento: BASE.dataagendamento, horarioagendamento: '16:00', rawEndTime: '16:30' },
        ];
        const expectedHash = reconstructDoctorHash(blocksBC);
        expect(doctorSnap!.get(42)).toBe(expectedHash);
    });

    it('round-trip: remoção completa do médico → loadAllSnapshots retorna mapa vazio', async () => {
        await svc.upsert({ ...BASE, addressId: '', horarioagendamento: '09:00', rawEndTime: '09:30' });
        await svc.cancelSnapshotForDoctor('clinic-1', 42);

        const snapshots = await svc.loadAllSnapshots();
        expect(snapshots.size).toBe(0);
    });

    it('loadAllSnapshots produz hash igual ao que o BlockWatcher computaria', () => {
        // Simula o que BlockWatcher.hashBlocks faz com os mesmos dados
        const block1 = { dataagendamento: '2026-08-17', horarioagendamento: '09:00', rawEndTime: '09:30' };
        const block2 = { dataagendamento: '2026-08-17', horarioagendamento: '14:00', rawEndTime: '14:30' };
        const dbRecords = [block1, block2];

        // Replica hashBlocks do BlockWatcher
        const norm = dbRecords
            .map(r => ({ d: r.dataagendamento, i: r.horarioagendamento, f: r.rawEndTime }))
            .sort((a, b) => (a.d + a.i + a.f!).localeCompare(b.d + b.i + b.f!));
        const crypto = require('crypto');
        const expectedHash = crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex');

        expect(reconstructDoctorHash(dbRecords)).toBe(expectedHash);
    });
});
