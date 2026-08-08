/**
 * WP-01 — Observabilidade Doctoralia
 * Contexto assíncrono propagado via AsyncLocalStorage para rastrear a origem
 * de cada chamada à API Doctoralia sem alterar assinaturas de função.
 */
import { AsyncLocalStorage } from 'async_hooks';

export type DoctoraliaOrigin =
    | 'USER_INTERACTIVE'
    | 'POLLING'
    | 'RECONCILIATION'
    | 'SLOT_SYNC'
    | 'SAFETY_SWEEP'
    | 'WEBHOOK'
    | 'SCHEDULER'
    | 'RETRY'
    | 'AUTHENTICATION'
    | 'OTHER';

export type ReconciliationSubtype =
    | 'reconcileDisappearedFromVismed'
    | 'reconcileBookedWithoutVismedId'
    | 'reconcileUnlinkedWithDoctoralia'
    | 'reconcileCancelledOnDoctoralia';

export interface DoctoraliaCallContext {
    origin: DoctoraliaOrigin;
    clinicId?: string;
    integrationConnectionId?: string;
    doctorId?: string;
    processId?: string;
    retryNumber?: number;
    requestId?: string;                  // Para USER_INTERACTIVE: HTTP requestId
    reconciliationSubtype?: ReconciliationSubtype;
    pollExecutionId?: string;
}

/** Singleton de armazenamento assíncrono — nunca vaza entre requisições paralelas. */
export const doctoraliaCallContextStorage = new AsyncLocalStorage<DoctoraliaCallContext>();

/**
 * Executa fn com o contexto fornecido. Qualquer chamada dentro de fn herdará
 * automaticamente o contexto via AsyncLocalStorage — sem alterar assinaturas.
 */
export function runWithDoctoraliaContext<T>(
    ctx: DoctoraliaCallContext,
    fn: () => T | Promise<T>,
): T | Promise<T> {
    return doctoraliaCallContextStorage.run(ctx, fn);
}

/** Lê o contexto atual (undefined se não há contexto ativo). */
export function getDoctoraliaContext(): DoctoraliaCallContext | undefined {
    return doctoraliaCallContextStorage.getStore();
}
