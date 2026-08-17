/**
 * WP2 — Serviço de auditoria de períodos de bloqueio VisMed irrecuperáveis
 *
 * Envolve `parseBlockPeriod` com persistência automática de eventos de auditoria
 * quando o parser retorna `ok: false` (período irrecuperável). O evento é gravado
 * na tabela `AuditLog` com dedup em memória por (blockId + campo + razão) para
 * evitar ruído em ciclos de polling consecutivos.
 *
 * O bloqueio irrecuperável fica visível no painel administrador
 * (filtro: action = "BLOCK_PERIOD_UNRECOVERABLE") e nos logs estruturados —
 * nunca é descartado silenciosamente.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
    BlockPeriodRaw,
    BlockPeriod,
    ParseBlockPeriodResult,
    parseBlockPeriod,
    checkScheduleDayConsistency,
    ScheduleDayRange,
} from './vismed-block-period-parser';

export type { BlockPeriodRaw, BlockPeriod, ParseBlockPeriodResult };

@Injectable()
export class VismedBlockPeriodAuditService {
    private readonly logger = new Logger(VismedBlockPeriodAuditService.name);

    /**
     * Dedup em memória: evita gravar o mesmo evento de auditoria repetidamente
     * durante ciclos de polling consecutivos sem precisar consultar o banco antes
     * de cada INSERT. Chave: `${blockId}|${failField}|${failReason}`.
     * Reset a cada restart do servidor (aceitável: o log já persiste no banco).
     */
    private readonly auditedKeys = new Set<string>();

    constructor(private readonly prisma: PrismaService) {}

    /**
     * Parseia o período de um bloqueio e persiste evento de auditoria quando
     * o resultado é irrecuperável (ok: false).
     *
     * @param raw    Registro bruto do bloqueio VisMed
     * @param context Contexto adicional para enriquecer o log de auditoria
     * @returns BlockPeriod normalizado ou null (com auditoria gravada)
     */
    async parseWithAudit(
        raw: BlockPeriodRaw,
        context: { clinicId?: string; idprofissional?: number; clinicName?: string } = {},
    ): Promise<BlockPeriod | null> {
        const result = parseBlockPeriod(raw);

        if (result.ok === true) {
            return result.period;
        }

        // ── Período irrecuperável — auditar ──────────────────────────────────
        // Narrowing explícito: TypeScript sabe que result.ok === false aqui.
        const { failField, failReason, rawStart, rawEnd, date } = result;

        // Identifica o bloqueio para dedup: usa blockId quando disponível,
        // caso contrário usa a combinação date|start|end como proxy.
        const blockIdStr =
            raw.blockId != null ? String(raw.blockId) : `${date}|${rawStart}|${rawEnd}`;

        const dedupKey = `${blockIdStr}|${failField}|${failReason}`;

        this.logger.warn(
            `[BLOCK-PERIOD-PARSER] Período irrecuperável` +
                ` blockId=${blockIdStr}` +
                ` campo=${failField} razão=${failReason}` +
                ` startRaw="${rawStart}" endRaw="${rawEnd}"` +
                ` data=${date}` +
                (context.clinicName ? ` clínica="${context.clinicName}"` : '') +
                (context.idprofissional != null
                    ? ` idprofissional=${context.idprofissional}`
                    : ''),
        );

        if (!this.auditedKeys.has(dedupKey)) {
            try {
                await this.prisma.auditLog.create({
                    data: {
                        action: 'BLOCK_PERIOD_UNRECOVERABLE',
                        entity: 'vismed_block',
                        entityId: blockIdStr,
                        details: {
                            failField,
                            failReason,
                            rawStart,
                            rawEnd,
                            date,
                            clinicId: context.clinicId ?? null,
                            idprofissional: context.idprofissional ?? null,
                        },
                    },
                });
                // Adiciona ao dedup APENAS após gravação bem-sucedida.
                // Se a gravação falhar (ex.: timeout de banco), o próximo ciclo
                // de polling tentará novamente — sem perda silenciosa de eventos.
                this.auditedKeys.add(dedupKey);
            } catch (err: any) {
                // Falha na auditoria nunca deve bloquear o fluxo principal.
                // A chave NÃO é adicionada ao dedup — próximo ciclo retentará.
                this.logger.error(
                    `[BLOCK-PERIOD-PARSER] Falha ao gravar auditoria blockId=${blockIdStr}: ${err?.message}`,
                );
            }
        }

        return null;
    }

    /**
     * Versão síncrona sem persistência — útil em contextos onde o await não é
     * viável ou onde a auditoria já é feita pelo chamador.
     * Retorna o resultado completo do parser para inspeção.
     */
    parseSync(raw: BlockPeriodRaw): ParseBlockPeriodResult {
        return parseBlockPeriod(raw);
    }

    /**
     * Verifica consistência entre período normalizado e scheduleDay, e loga
     * qualquer anomalia detectada.
     *
     * ⚠ Nunca altera o período — é puramente um emissor de sinal de anomalia.
     * O resultado de `parseBlockPeriod` é sempre a fonte de verdade do período.
     */
    checkAndLogConsistency(
        period: BlockPeriod,
        scheduleDayRanges: ScheduleDayRange[],
        context: {
            blockId?: string | number;
            clinicId?: string;
            idprofissional?: number;
        } = {},
    ): void {
        const signal = checkScheduleDayConsistency(period, scheduleDayRanges);
        if (signal.consistent === false) {
            this.logger.warn(
                `[BLOCK-PERIOD-CONSISTENCY] Anomalia detectada` +
                    ` blockId=${context.blockId ?? 'N/A'}` +
                    (context.clinicId ? ` clinicId=${context.clinicId}` : '') +
                    (context.idprofissional != null
                        ? ` idprofissional=${context.idprofissional}`
                        : '') +
                    ` — ${signal.reason}`,
            );
        }
    }

    /**
     * Limpa o dedup em memória.
     * Útil em testes ou quando o servidor inicia um novo ciclo de auditoria.
     */
    clearAuditCache(): void {
        this.auditedKeys.clear();
    }
}
