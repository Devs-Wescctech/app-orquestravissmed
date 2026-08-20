/**
 * WP-02 P2c + WP-04 + Task 223 — Guard de Concorrência por clínica
 *
 * Matriz de concorrência (Task 223):
 * - POLLING e SAFETY_SWEEP podem coexistir (em qualquer ordem).
 * - Mesmo ator em duplicata bloqueia (POLLING+POLLING, SWEEP+SWEEP).
 * - GLOBAL_SYNC conflita com tudo (POLLING, SAFETY_SWEEP, SLOT_SYNC, outro GLOBAL_SYNC).
 * - SLOT_SYNC conflita com tudo (POLLING, SAFETY_SWEEP, GLOBAL_SYNC, outro SLOT_SYNC).
 * - GLOBAL_SYNC_PENDING bloqueia novos POLLING/SAFETY_SWEEP/SLOT_SYNC mesmo que um
 *   par compatível esteja ativo.
 * - NOTIFICATION_POLL tem single-flight próprio e é sempre independente.
 *
 * - Puramente em memória; sem dependências externas (sem lock cross-instance).
 * - Clínicas diferentes são completamente independentes.
 * - Guard liberado em `finally` em qualquer cenário de execução.
 */
import { Injectable, Logger } from '@nestjs/common';

export type ConcurrencySubsystem =
    | 'NOTIFICATION_POLL'
    | 'POLLING'
    | 'SAFETY_SWEEP'
    | 'GLOBAL_SYNC'
    | 'SLOT_SYNC';

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

/**
 * Subsistemas "pesados" que conflitam com TUDO (inclusive entre si e com POLLING/SWEEP).
 * POLLING e SAFETY_SWEEP podem coexistir entre si mas conflitam com estes.
 */
const HEAVY_SUBSYSTEMS = new Set<ConcurrencySubsystem>(['GLOBAL_SYNC', 'SLOT_SYNC']);

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
     *
     * Matriz Task 223:
     * - NOTIFICATION_POLL: single-flight próprio (independente dos demais).
     * - POLLING: bloqueia se POLLING já ativo OU se GLOBAL_SYNC/SLOT_SYNC ativos.
     * - SAFETY_SWEEP: bloqueia se SAFETY_SWEEP já ativo OU se GLOBAL_SYNC/SLOT_SYNC ativos.
     * - GLOBAL_SYNC: bloqueia se QUALQUER outro exclusivo (exceto NOTIFICATION_POLL) ativo.
     * - SLOT_SYNC: bloqueia se QUALQUER outro exclusivo (exceto NOTIFICATION_POLL) ativo.
     */
    tryAcquire(clinicId: string, subsystem: ConcurrencySubsystem): boolean {
        let active = this.activeSubsystems.get(clinicId);
        if (!active) {
            active = new Set();
            this.activeSubsystems.set(clinicId, active);
        }

        // NOTIFICATION_POLL tem single-flight próprio. Não participa da exclusão
        // ampla porque uma leitura curta da Doctoralia não pode ser perdida por
        // um poll VisMed/Global Sync/Slot Sync longo (nem bloqueá-los).
        if (subsystem === 'NOTIFICATION_POLL') {
            if (active.has('NOTIFICATION_POLL')) return false;
            active.add(subsystem);
            return true;
        }

        // Conjunto de subsistemas exclusivos ativos (excluindo NOTIFICATION_POLL independente).
        const exclusiveActive = [...active].filter(s => s !== 'NOTIFICATION_POLL');

        if (HEAVY_SUBSYSTEMS.has(subsystem)) {
            // GLOBAL_SYNC e SLOT_SYNC conflitam com TUDO (exceto NOTIFICATION_POLL).
            if (exclusiveActive.length > 0) return false;
        } else {
            // POLLING e SAFETY_SWEEP: podem coexistir entre si (Task 223),
            // mas são bloqueados por GLOBAL_SYNC, SLOT_SYNC, ou duplicata do mesmo ator.
            if (active.has(subsystem)) return false;
            if (exclusiveActive.some(s => HEAVY_SUBSYSTEMS.has(s))) return false;
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
        // Verifica se os exclusivos foram todos liberados (ignorando NOTIFICATION_POLL).
        const exclusiveActive = [...active].filter(s => s !== 'NOTIFICATION_POLL');
        if (exclusiveActive.length === 0) {
            // Todos os exclusivos foram liberados — se a clínica está totalmente vazia,
            // limpa o mapa. Se apenas NOTIFICATION_POLL resta, mantém.
            if (active.size === 0) {
                this.activeSubsystems.delete(clinicId);
            }
            // Task 133: quando não há mais exclusivos ativos, dispara o callback
            // de re-disparo do Global Sync se houver reserva pendente.
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
     * ativo que REALMENTE bloqueia o solicitante, ou 'GLOBAL_SYNC_PENDING'
     * quando o bloqueio veio da reserva (nenhum conflito ativo), ou null se
     * a clínica está livre.
     *
     * Task 223: aceita `forSubsystem` opcional para retornar o verdadeiro
     * ator conflitante quando POLLING e SAFETY_SWEEP coexistem:
     * - Terceiro SWEEP com [POLLING, SWEEP] ativos → SAFETY_SWEEP (duplicata)
     * - Terceiro POLL com [POLLING, SWEEP] ativos → POLLING (duplicata)
     */
    getBlockReason(clinicId: string, forSubsystem?: ConcurrencySubsystem): ConcurrencyBlockReason | null {
        const activeSet = this.activeSubsystems.get(clinicId);
        const exclusiveActive = activeSet
            ? [...activeSet].filter(s => s !== 'NOTIFICATION_POLL')
            : [];

        if (exclusiveActive.length > 0) {
            // Se o solicitante específico é conhecido, retorna o ator que realmente bloqueia.
            if (forSubsystem && (forSubsystem === 'POLLING' || forSubsystem === 'SAFETY_SWEEP')) {
                // Duplicata do mesmo ator é o motivo real (POLLING+SWEEP coexistem, mas
                // um terceiro do mesmo tipo é bloqueado pela duplicata).
                if (activeSet!.has(forSubsystem)) return forSubsystem;
                // Bloqueado por um heavy subsystem (GLOBAL_SYNC/SLOT_SYNC)
                const heavy = exclusiveActive.find(s => HEAVY_SUBSYSTEMS.has(s));
                if (heavy) return heavy;
                // Nenhuma duplicata, nenhum heavy — o bloqueio veio da reserva de prioridade
                // (POLLING+SWEEP são compatíveis entre si; se o par compatível está ativo,
                // o bloqueio é necessariamente pela reserva GLOBAL_SYNC_PENDING).
                if (this.getValidReservation(clinicId)) return 'GLOBAL_SYNC_PENDING';
            }
            // Sem contexto do solicitante: retorna o primeiro exclusivo ativo
            // (comportamento original para chamadores sem o contexto).
            return exclusiveActive[0] as ConcurrencySubsystem;
        }
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
     * Retorna o subsistema atualmente ativo que bloquearia uma nova aquisição
     * (sem adquirir). Leva em conta a matriz Task 223:
     * - Se o solicitante não especificado, retorna o primeiro exclusivo não-NOTIFICATION_POLL.
     * - Para diagnóstico de getBlockReason: quando POLLING+SWEEP coexistem e o
     *   bloqueio é por duplicata, retorna o ator duplicado.
     *
     * NOTA: Este método genérico retorna o primeiro exclusivo ativo. Para obter
     * o motivo correto de bloqueio para um ator específico, use getBlockReasonFor().
     */
    getActiveSubsystem(clinicId: string): ConcurrencySubsystem | null {
        const active = this.activeSubsystems.get(clinicId);
        if (!active || active.size === 0) return null;
        // Quando notifications coexistem com um subsistema exclusivo, o motivo
        // de bloqueio é sempre o subsistema exclusivo (notifications não bloqueiam).
        return [...active].find(current => current !== 'NOTIFICATION_POLL')
            ?? (active.has('NOTIFICATION_POLL') ? 'NOTIFICATION_POLL' : null);
    }

    /**
     * Retorna o motivo verdadeiro de bloqueio para um ator específico tentando
     * adquirir. Usado por getBlockReason quando há coexistência POLLING+SWEEP.
     *
     * Task 223:
     * - Terceiro POLLING com [POLLING, SWEEP] ativos → POLLING (duplicata)
     * - Terceiro SWEEP com [POLLING, SWEEP] ativos → SAFETY_SWEEP (duplicata)
     * - GLOBAL_SYNC/SLOT_SYNC com qualquer exclusivo → primeiro exclusivo ativo
     */
    getBlockReasonFor(clinicId: string, subsystem: ConcurrencySubsystem): ConcurrencyBlockReason | null {
        const active = this.activeSubsystems.get(clinicId);
        if (!active) {
            if (this.getValidReservation(clinicId)) return 'GLOBAL_SYNC_PENDING';
            return null;
        }
        const exclusiveActive = [...active].filter(s => s !== 'NOTIFICATION_POLL');
        if (exclusiveActive.length === 0) {
            if (this.getValidReservation(clinicId)) return 'GLOBAL_SYNC_PENDING';
            return null;
        }
        // Para POLLING e SAFETY_SWEEP: se o mesmo ator já está ativo, é a duplicata
        if ((subsystem === 'POLLING' || subsystem === 'SAFETY_SWEEP') && active.has(subsystem)) {
            return subsystem;
        }
        // Para GLOBAL_SYNC/SLOT_SYNC: qualquer exclusivo ativo bloqueia
        return exclusiveActive[0] as ConcurrencySubsystem;
    }
}
