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
import { Injectable } from '@nestjs/common';

export type ConcurrencySubsystem = 'POLLING' | 'SAFETY_SWEEP' | 'GLOBAL_SYNC' | 'SLOT_SYNC';

@Injectable()
export class ClinicConcurrencyGuard {
    private readonly activeSubsystems = new Map<string, Set<ConcurrencySubsystem>>();

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
        }
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
