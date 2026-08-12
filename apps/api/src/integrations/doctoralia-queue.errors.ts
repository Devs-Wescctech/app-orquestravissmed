/**
 * WP-08B — Erros tipados de backpressure do Request Coordinator Doctoralia.
 *
 * Ambos ocorrem ANTES de qualquer chamada HTTP: não consomem rate slot, não
 * consomem budget GET/WRITE, não alimentam o circuit breaker (WP-08A) e são
 * NON-RETRYABLE na política WP-07. Nunca devem marcar
 * IntegrationConnection.status = 'error'/'disconnected'.
 *
 * Este arquivo NÃO importa nada do client/breaker/retry para permanecer
 * acíclico e importável de qualquer camada.
 */

export type DoctoraliaQueuePriority = 'HIGH' | 'LOW';

/** Fila HIGH/LOW cheia: rejeição imediata ANTES do push (sem waiter, sem slot). */
export class DoctoraliaQueueFullError extends Error {
    readonly code = 'DOCTORALIA_QUEUE_FULL';
    readonly priority: DoctoraliaQueuePriority;
    readonly queueSize: number;

    constructor(priority: DoctoraliaQueuePriority, queueSize: number) {
        super(
            `Sistema temporariamente sobrecarregado (fila ${priority} da Doctoralia cheia: ` +
            `${queueSize} requisições aguardando). Tente novamente em instantes.`,
        );
        this.name = 'DoctoraliaQueueFullError';
        this.priority = priority;
        this.queueSize = queueSize;
    }
}

/** Deadline de ESPERA NA FILA expirado (não substitui o timeout HTTP de 30s). */
export class DoctoraliaQueueTimeoutError extends Error {
    readonly code = 'DOCTORALIA_QUEUE_TIMEOUT';
    readonly priority: DoctoraliaQueuePriority;
    readonly queueSize: number;
    readonly waitMs: number;
    readonly deadlineMs: number;

    constructor(priority: DoctoraliaQueuePriority, queueSize: number, waitMs: number, deadlineMs: number) {
        super(
            `Tempo de espera na fila ${priority} da Doctoralia esgotado ` +
            `(${Math.round(waitMs / 1000)}s aguardando; limite ${Math.round(deadlineMs / 1000)}s). ` +
            `Tente novamente em instantes.`,
        );
        this.name = 'DoctoraliaQueueTimeoutError';
        this.priority = priority;
        this.queueSize = queueSize;
        this.waitMs = waitMs;
        this.deadlineMs = deadlineMs;
    }
}

export function isDoctoraliaQueueFullError(err: any): err is DoctoraliaQueueFullError {
    return err instanceof DoctoraliaQueueFullError
        || err?.name === 'DoctoraliaQueueFullError'
        || err?.code === 'DOCTORALIA_QUEUE_FULL';
}

export function isDoctoraliaQueueTimeoutError(err: any): err is DoctoraliaQueueTimeoutError {
    return err instanceof DoctoraliaQueueTimeoutError
        || err?.name === 'DoctoraliaQueueTimeoutError'
        || err?.code === 'DOCTORALIA_QUEUE_TIMEOUT';
}

/** Qualquer erro de backpressure da fila (full OU timeout de espera). */
export function isDoctoraliaQueueError(
    err: any,
): err is DoctoraliaQueueFullError | DoctoraliaQueueTimeoutError {
    return isDoctoraliaQueueFullError(err) || isDoctoraliaQueueTimeoutError(err);
}
