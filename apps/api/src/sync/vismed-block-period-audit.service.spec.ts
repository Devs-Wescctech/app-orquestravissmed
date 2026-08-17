/**
 * WP2 — Testes de integração do VismedBlockPeriodAuditService
 *
 * Prove que:
 * 1. Bloqueios com período irrecuperável geram exatamente UM evento AuditLog persistido.
 * 2. A dedup em memória impede INSERTs repetidos na mesma sessão.
 * 3. Bloqueios válidos não geram auditoria e o período não é mutado pelo sinal de consistência.
 * 4. A falha na gravação do AuditLog nunca bloqueia o fluxo principal.
 */

import { VismedBlockPeriodAuditService } from './vismed-block-period-audit.service';
import { ScheduleDayRange } from './vismed-block-period-parser';

// ──────────────────────────────────────────────────────────────────────────────
// Stub do PrismaService
// ──────────────────────────────────────────────────────────────────────────────

function makePrismaStub() {
    const createMock = jest.fn().mockResolvedValue({});
    return {
        auditLog: { create: createMock },
        _createMock: createMock,
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const DATE = '2025-08-15';

function makeService(prisma?: ReturnType<typeof makePrismaStub>) {
    const p = prisma ?? makePrismaStub();
    const svc = new VismedBlockPeriodAuditService(p as any);
    return { svc, prisma: p };
}

// ──────────────────────────────────────────────────────────────────────────────
// parseWithAudit — bloqueios irrecuperáveis
// ──────────────────────────────────────────────────────────────────────────────

describe('VismedBlockPeriodAuditService.parseWithAudit', () => {
    describe('bloqueios com período irrecuperável', () => {
        it('retorna null e grava EXATAMENTE um AuditLog para fim vazio (formato real)', async () => {
            const { svc, prisma } = makeService();

            const result = await svc.parseWithAudit(
                { blockId: 'blk-001', date: DATE, startRaw: '08:00', endRaw: '' },
                { clinicId: 'clinic-1', idprofissional: 42, clinicName: 'Clínica Teste' },
            );

            expect(result).toBeNull();
            expect(prisma._createMock).toHaveBeenCalledTimes(1);

            const callArg = prisma._createMock.mock.calls[0][0];
            expect(callArg.data.action).toBe('BLOCK_PERIOD_UNRECOVERABLE');
            expect(callArg.data.entity).toBe('vismed_block');
            expect(callArg.data.entityId).toBe('blk-001');
            expect(callArg.data.details).toMatchObject({
                failField: 'end',
                failReason: 'EMPTY',
                rawEnd: '',
                clinicId: 'clinic-1',
                idprofissional: 42,
            });
        });

        it('retorna null e audita "011:0" como fim ambíguo (AMBIGUOUS_SINGLE_DIGIT_MINUTE)', async () => {
            const { svc, prisma } = makeService();

            const result = await svc.parseWithAudit(
                { blockId: 'blk-002', date: DATE, startRaw: '12:00', endRaw: '011:1' },
                {},
            );

            expect(result).toBeNull();
            expect(prisma._createMock).toHaveBeenCalledTimes(1);
            const details = prisma._createMock.mock.calls[0][0].data.details;
            expect(details.failReason).toBe('AMBIGUOUS_SINGLE_DIGIT_MINUTE');
            expect(details.failField).toBe('end');
        });

        it('retorna null e audita fim ≤ início (END_NOT_AFTER_START)', async () => {
            const { svc, prisma } = makeService();

            const result = await svc.parseWithAudit(
                { blockId: 'blk-003', date: DATE, startRaw: '12:00', endRaw: '08:00' },
                {},
            );

            expect(result).toBeNull();
            expect(prisma._createMock).toHaveBeenCalledTimes(1);
            const details = prisma._createMock.mock.calls[0][0].data.details;
            expect(details.failReason).toBe('END_NOT_AFTER_START');
            expect(details.failField).toBe('period');
        });

        it('usa combinação date|start|end como entityId quando blockId não é fornecido', async () => {
            const { svc, prisma } = makeService();

            await svc.parseWithAudit(
                { date: DATE, startRaw: '08:00', endRaw: '' },
                {},
            );

            const callArg = prisma._createMock.mock.calls[0][0];
            expect(callArg.data.entityId).toBe(`${DATE}|08:00|`);
        });
    });

    // ── Dedup em memória ──────────────────────────────────────────────────────

    describe('dedup em memória', () => {
        it('NÃO grava segundo AuditLog para o mesmo blockId+campo+razão na mesma sessão', async () => {
            const { svc, prisma } = makeService();
            const raw = { blockId: 'blk-dup', date: DATE, startRaw: '08:00', endRaw: '' };

            await svc.parseWithAudit(raw, {});
            await svc.parseWithAudit(raw, {});
            await svc.parseWithAudit(raw, {});

            // Apenas um INSERT, apesar de três chamadas
            expect(prisma._createMock).toHaveBeenCalledTimes(1);
        });

        it('grava para bloqueios diferentes com mesma razão', async () => {
            const { svc, prisma } = makeService();

            await svc.parseWithAudit({ blockId: 'blk-A', date: DATE, startRaw: '08:00', endRaw: '' }, {});
            await svc.parseWithAudit({ blockId: 'blk-B', date: DATE, startRaw: '08:00', endRaw: '' }, {});

            // Dois INSERTs: IDs de bloqueio diferentes
            expect(prisma._createMock).toHaveBeenCalledTimes(2);
        });

        it('clearAuditCache permite re-auditoria do mesmo bloqueio', async () => {
            const { svc, prisma } = makeService();
            const raw = { blockId: 'blk-reset', date: DATE, startRaw: '08:00', endRaw: '' };

            await svc.parseWithAudit(raw, {});
            svc.clearAuditCache();
            await svc.parseWithAudit(raw, {});

            // Dois INSERTs após reset do cache
            expect(prisma._createMock).toHaveBeenCalledTimes(2);
        });
    });

    // ── Bloqueios válidos ─────────────────────────────────────────────────────

    describe('bloqueios com período válido', () => {
        it('retorna BlockPeriod e NÃO grava AuditLog — formato canônico', async () => {
            const { svc, prisma } = makeService();

            const result = await svc.parseWithAudit(
                { blockId: 'blk-ok', date: DATE, startRaw: '08:00', endRaw: '12:00' },
                {},
            );

            expect(result).not.toBeNull();
            expect(result!.sinceHHMM).toBe('08:00');
            expect(result!.tillHHMM).toBe('12:00');
            expect(prisma._createMock).not.toHaveBeenCalled();
        });

        it('retorna BlockPeriod e NÃO grava AuditLog — formato real "011:0"', async () => {
            const { svc, prisma } = makeService();

            const result = await svc.parseWithAudit(
                { blockId: 'blk-ok2', date: DATE, startRaw: '08:10', endRaw: '011:0' },
                {},
            );

            expect(result).not.toBeNull();
            expect(result!.sinceHHMM).toBe('08:10');
            expect(result!.tillHHMM).toBe('11:00');
            expect(prisma._createMock).not.toHaveBeenCalled();
        });

        it('retorna BlockPeriod e NÃO grava AuditLog — formato real "012:0"', async () => {
            const { svc, prisma } = makeService();

            const result = await svc.parseWithAudit(
                { blockId: 'blk-ok3', date: DATE, startRaw: '08:00', endRaw: '012:0' },
                {},
            );

            expect(result).not.toBeNull();
            expect(result!.tillHHMM).toBe('12:00');
            expect(prisma._createMock).not.toHaveBeenCalled();
        });
    });

    // ── Falha na gravação do AuditLog não bloqueia o fluxo ───────────────────

    describe('resiliência a falhas de banco', () => {
        it('retorna null mesmo quando a gravação do AuditLog falha', async () => {
            const prisma = makePrismaStub();
            prisma._createMock.mockRejectedValueOnce(new Error('DB connection lost'));
            const { svc } = makeService(prisma);

            // Não deve lançar — a auditoria falhou mas o fluxo continua
            const result = await svc.parseWithAudit(
                { blockId: 'blk-db-fail', date: DATE, startRaw: '08:00', endRaw: '' },
                {},
            );

            expect(result).toBeNull();
        });

        it('tenta gravar novamente no próximo ciclo após falha transitória', async () => {
            const prisma = makePrismaStub();
            // Primeira chamada falha, segunda sucede
            prisma._createMock
                .mockRejectedValueOnce(new Error('DB connection lost'))
                .mockResolvedValueOnce({});
            const { svc } = makeService(prisma);

            const raw = { blockId: 'blk-transient', date: DATE, startRaw: '08:00', endRaw: '' };

            // Primeira tentativa: falha — chave NÃO deve ser adicionada ao dedup
            await svc.parseWithAudit(raw, {});
            expect(prisma._createMock).toHaveBeenCalledTimes(1);

            // Segunda tentativa: deve tentar novamente (chave não estava no dedup)
            await svc.parseWithAudit(raw, {});
            expect(prisma._createMock).toHaveBeenCalledTimes(2);

            // Terceira tentativa: dedup em memória já tem a chave (gravação anterior sucedeu)
            await svc.parseWithAudit(raw, {});
            expect(prisma._createMock).toHaveBeenCalledTimes(2);
        });
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkAndLogConsistency — sinal auxiliar não-árbitro
// ──────────────────────────────────────────────────────────────────────────────

describe('VismedBlockPeriodAuditService.checkAndLogConsistency', () => {
    const period = {
        since: new Date(`${DATE}T08:00:00`),
        till:  new Date(`${DATE}T12:00:00`),
        sinceHHMM: '08:00',
        tillHHMM:  '12:00',
    };

    it('NÃO altera o período após verificar scheduleDay que cobre o bloqueio (anomalia)', () => {
        const { svc } = makeService();
        const ranges: ScheduleDayRange[] = [{ start: '07:00', end: '13:00' }];

        const sinceBeforeMs = period.since.getTime();
        const tillBeforeMs  = period.till.getTime();

        // Chama a verificação — deve apenas logar, nunca alterar o período
        svc.checkAndLogConsistency(period, ranges, { blockId: 'blk-x' });

        expect(period.since.getTime()).toBe(sinceBeforeMs);
        expect(period.till.getTime()).toBe(tillBeforeMs);
        expect(period.sinceHHMM).toBe('08:00');
        expect(period.tillHHMM).toBe('12:00');
    });

    it('NÃO altera o período quando scheduleDay confirma o bloqueio (consistente)', () => {
        const { svc } = makeService();
        const ranges: ScheduleDayRange[] = [
            { start: '07:00', end: '08:00' },
            { start: '12:00', end: '17:00' },
        ];

        const sinceBeforeMs = period.since.getTime();
        const tillBeforeMs  = period.till.getTime();

        svc.checkAndLogConsistency(period, ranges, { blockId: 'blk-y' });

        expect(period.since.getTime()).toBe(sinceBeforeMs);
        expect(period.till.getTime()).toBe(tillBeforeMs);
    });

    it('NÃO grava AuditLog — sinal de consistência é apenas log, nunca persistência', async () => {
        const { svc, prisma } = makeService();
        const ranges: ScheduleDayRange[] = [{ start: '07:00', end: '13:00' }];

        svc.checkAndLogConsistency(period, ranges, {});

        // Nenhuma chamada ao banco
        expect(prisma._createMock).not.toHaveBeenCalled();
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseSync — sem efeitos colaterais
// ──────────────────────────────────────────────────────────────────────────────

describe('VismedBlockPeriodAuditService.parseSync', () => {
    it('retorna result completo sem gravar nada no banco', async () => {
        const { svc, prisma } = makeService();

        const r = svc.parseSync({ date: DATE, startRaw: '08:00', endRaw: '' });
        expect(r.ok).toBe(false);
        expect(prisma._createMock).not.toHaveBeenCalled();
    });

    it('retorna period quando válido', () => {
        const { svc } = makeService();

        const r = svc.parseSync({ date: DATE, startRaw: '08:00', endRaw: '011:0' });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.period.sinceHHMM).toBe('08:00');
            expect(r.period.tillHHMM).toBe('11:00');
        }
    });
});
