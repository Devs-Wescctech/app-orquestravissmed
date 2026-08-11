/**
 * WP-02 P2c + WP-04 — Guard de Concorrência por clínica
 *
 * Garante que os subsistemas POLLING, SAFETY_SWEEP, GLOBAL_SYNC e SLOT_SYNC
 * nunca executem simultaneamente para a mesma clínica. Política: SKIP (nunca WAIT).
 *
 * - GLOBAL_SYNC = sync completo Doctoralia por clínica (processor BullMQ ou caminho
 *   direto sem Redis). O lock cobre o run INTEIRO (decisão aprovada: não reduzir à
 *   fase push_to_doctoralia — starvation temporária do polling é aceita e visível
 *   via métricas).
 * - SLOT_SYNC = re-sync direcionado do Block Watcher (fast-lane 10min). O acquire
 *   fica no watcher (watchClinic), NUNCA dentro do SlotSyncService — o Global Sync
 *   o chama internamente e se auto-bloquearia.
 * - Puramente em memória; sem dependências externas (sem lock cross-instance).
 * - Clínicas diferentes são completamente independentes.
 * - Guard liberado em `finally` em qualquer cenário de execução.
 */
import { Injectable, Logger } from '@nestjs/common';

export type ConcurrencySubsystem = 'POLLING' | 'SAFETY_SWEEP' | 'GLOBAL_SYNC' | 'SLOT_SYNC';

/**
 * Motivo de bloqueio exposto aos chamadores após um tryAcquire falho:
 * o subsistema ativo OU 'GLOBAL_SYNC_PENDING' quando o bloqueio veio de uma
 * reserva de prioridade do Global Sync (Task 133) sem nenhum subsistema ativo.
 */
export type ConcurrencyBlockReason = ConcurrencySubsystem | 'GLOBAL_SYNC_PENDING';

interface PriorityReservation {
    /** Timestamp (ms) em que a reserva expira (TTL observável). */
    expiresAt: number;
    /** Callback OPACO de re-disparo — o guard não conhece o domínio. */
    callback: () => void;
    /** Callback OPACO opcional para reportar métrica na expiração. */
    onExpire?: () => void;
    /**
     * Tag OPACA definida pelo solicitante (ex.: id do run adiado). O guard não a
     * interpreta; é devolvida em consumePriority() para correlação no domínio.
     */
    tag?: string;
}

@Injectable()
export class ClinicConcurrencyGuard {
    /** TTL padrão da reserva de prioridade (~25min < janela do cron de 30min). */
    static readonly DEFAULT_PRIORITY_TTL_MS = 25 * 60 * 1000;

    private readonly logger = new Logger(ClinicConcurrencyGuard.name);
    private readonly activeSubsystems = new Map<string, Set<ConcurrencySubsystem>>();
    /** Task 133: reserva de prioridade do Global Sync por clínica (no máx. UMA). */
    private readonly priorityReservations = new Map<string, PriorityReservation>();

    /**
     * Tenta adquirir o slot de execução para `subsystem` na clínica `clinicId`.
     * Retorna `true` se adquiriu (pode executar) ou `false` se já estava ativo (SKIP).
     */
    tryAcquire(clinicId: string, subsystem: ConcurrencySubsystem): boolean {
        let active = this.activeSubsystems.get(clinicId);
        if (!active) {
            active = new Set();
            this.activeSubsystems.set(clinicId, active);
        }
        // Exclusão mútua por clínica: rejeita se QUALQUER subsistema estiver
        // ativo (não apenas o mesmo). Isso torna o tryAcquire a barreira
        // atômica — a segurança não depende da sequência isActive() → tryAcquire()
        // feita pelos chamadores (que serve apenas para escolher o motivo do skip).
        if (active.size > 0) {
            return false;
        }
        // Task 133: reserva de prioridade — enquanto há Global Sync aguardando,
        // novos POLLING/SAFETY_SWEEP/SLOT_SYNC são rejeitados. O próprio
        // GLOBAL_SYNC nunca é bloqueado pela reserva.
        if (subsystem !== 'GLOBAL_SYNC' && this.getValidReservation(clinicId)) {
            return false;
        }
        active.add(subsystem);
        return true;
    }

    /**
     * Libera o slot de execução. Chamar sempre em `finally`.
     * Idempotente: chamar em um slot já liberado não causa erros.
     */
    release(clinicId: string, subsystem: ConcurrencySubsystem): void {
        const active = this.activeSubsystems.get(clinicId);
        if (!active) return;
        active.delete(subsystem);
        if (active.size === 0) {
            this.activeSubsystems.delete(clinicId);
            // Task 133: último release deixou a clínica livre — se há reserva
            // de prioridade pendente, dispara o callback opaco de re-disparo.
            // setImmediate + try/catch: nunca propaga erro para o chamador do
            // release, e exceção no callback nunca trava a clínica.
            const reservation = this.getValidReservation(clinicId);
            if (reservation) {
                setImmediate(() => {
                    // Revalidação por IDENTIDADE no momento da execução: entre o
                    // agendamento e agora, a reserva pode ter sido consumida por um
                    // GLOBAL_SYNC independente, descartada (clearPriority) ou
                    // substituída por coalescência — o callback antigo NÃO pode
                    // disparar um resume obsoleto (exactly-once).
                    if (this.getValidReservation(clinicId) !== reservation) return;
                    try {
                        reservation.callback();
                    } catch (err: any) {
                        this.logger.error(`[GUARD] Callback de prioridade falhou clinicId=${clinicId}: ${err?.message} — reserva descartada (próxima janela do cron cobre)`);
                        this.priorityReservations.delete(clinicId);
                    }
                });
            }
        }
    }

    // ─── Task 133: reserva de prioridade do Global Sync ─────────────────────

    /**
     * Registra (ou coalesce) a reserva de prioridade do Global Sync para a
     * clínica. Apenas UMA reserva por clínica: uma nova solicitação substitui o
     * callback, mas PRESERVA o deadline original (TTL não é renovado em
     * re-registro — impede loop infinito de re-disparos).
     */
    requestPriority(
        clinicId: string,
        callback: () => void,
        opts?: { ttlMs?: number; onExpire?: () => void; tag?: string },
    ): void {
        const existing = this.getValidReservation(clinicId);
        const ttlMs = opts?.ttlMs ?? ClinicConcurrencyGuard.DEFAULT_PRIORITY_TTL_MS;
        this.priorityReservations.set(clinicId, {
            expiresAt: existing ? existing.expiresAt : Date.now() + ttlMs,
            callback,
            onExpire: opts?.onExpire ?? existing?.onExpire,
            tag: opts?.tag ?? existing?.tag,
        });
    }

    /** Remove a reserva de prioridade (descarte: clínica desativada, erro no re-disparo, etc.). */
    clearPriority(clinicId: string): void {
        this.priorityReservations.delete(clinicId);
    }

    /**
     * CONSUMO explícito da reserva por uma execução GLOBAL_SYNC que rodou
     * (política aprovada: qualquer Global Sync que consegue o acquire satisfaz e
     * consome a reserva ao terminar). Remove a reserva e devolve a tag opaca
     * para que o domínio correlacione o run adiado ao run que o satisfez —
     * a satisfação por um run independente é observável, nunca silenciosa.
     * Retorna null se não havia reserva válida.
     */
    consumePriority(clinicId: string): { tag?: string } | null {
        const reservation = this.getValidReservation(clinicId);
        if (!reservation) return null;
        this.priorityReservations.delete(clinicId);
        return { tag: reservation.tag };
    }

    /** Há reserva de prioridade válida (não expirada) para a clínica? */
    hasPriorityPending(clinicId: string): boolean {
        return this.getValidReservation(clinicId) !== null;
    }

    /**
     * Motivo inequívoco do bloqueio após um tryAcquire falho: o subsistema
     * ativo, ou 'GLOBAL_SYNC_PENDING' quando o bloqueio veio da reserva
     * (nenhum subsistema ativo), ou null se a clínica está livre.
     */
    getBlockReason(clinicId: string): ConcurrencyBlockReason | null {
        const active = this.getActiveSubsystem(clinicId);
        if (active) return active;
        if (this.getValidReservation(clinicId)) return 'GLOBAL_SYNC_PENDING';
        return null;
    }

    /**
     * Retorna a reserva se existir e ainda estiver válida; expira lazily por
     * TTL com log de warning + callback opaco de métrica (evento anômalo
     * VISÍVEL — nunca tratado silenciosamente como sucesso).
     */
    private getValidReservation(clinicId: string): PriorityReservation | null {
        const reservation = this.priorityReservations.get(clinicId);
        if (!reservation) return null;
        if (Date.now() >= reservation.expiresAt) {
            this.priorityReservations.delete(clinicId);
            this.logger.warn(`[GUARD] GLOBAL_SYNC_RESERVATION_EXPIRED clinicId=${clinicId} — reserva de prioridade expirou por TTL sem executar; próxima janela do cron cobre`);
            try { reservation.onExpire?.(); } catch (_e) { /* métricas nunca quebram o guard */ }
            return null;
        }
        return reservation;
    }

    /**
     * Verifica se um subsistema está ativo para a clínica (sem adquirir).
     * Usado para checar se o subsistema concorrente está em execução.
     */
    isActive(clinicId: string, subsystem: ConcurrencySubsystem): boolean {
        return this.activeSubsystems.get(clinicId)?.has(subsystem) ?? false;
    }

    /**
     * Retorna o subsistema atualmente ativo para a clínica (ou null).
     * Usado APENAS para escolher o motivo do skip em logs/métricas após um
     * tryAcquire falho — a barreira atômica continua sendo o tryAcquire.
     */
    getActiveSubsystem(clinicId: string): ConcurrencySubsystem | null {
        const active = this.activeSubsystems.get(clinicId);
        if (!active || active.size === 0) return null;
        return active.values().next().value ?? null;
    }
}
