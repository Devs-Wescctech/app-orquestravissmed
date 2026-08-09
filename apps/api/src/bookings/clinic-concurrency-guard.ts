/**
 * WP-02 P2c — Guard de Concorrência entre Polling e Safety Sweep
 *
 * Garante que dois subsistemas (POLLING e SAFETY_SWEEP) nunca executem
 * simultaneamente para a mesma clínica. Política: SKIP (nunca WAIT).
 *
 * - Puramente em memória; sem dependências externas.
 * - Clínicas diferentes são completamente independentes.
 * - Guard liberado em `finally` em qualquer cenário de execução.
 */
import { Injectable } from '@nestjs/common';

export type ConcurrencySubsystem = 'POLLING' | 'SAFETY_SWEEP';

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
        if (active.has(subsystem)) {
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
}
