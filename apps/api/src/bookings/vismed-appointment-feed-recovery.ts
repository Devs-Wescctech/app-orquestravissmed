/**
 * Fronteira para a futura rota VisMed que recoloca agendamentos no feed.
 *
 * A VisMed confirmou somente que a recuperação recebe IDs em lote e redefine
 * sua marca de sincronização. Endpoint, método, payload completo e resposta
 * ainda não foram fornecidos; portanto este contrato NÃO tem implementação
 * HTTP nem é chamado pelo polling.
 */
export interface VismedAppointmentFeedRecoveryClient {
    requestRedelivery(vismedAppointmentIds: readonly string[]): Promise<void>;
}

/**
 * Mantém somente IDs identificáveis e elimina repetições antes da futura
 * chamada em lote. Não persiste ACK, fila ou estado de retry.
 */
export function normalizeVismedAppointmentRecoveryIds(ids: Iterable<unknown>): string[] {
    const normalized = new Set<string>();

    for (const id of ids) {
        if (typeof id !== 'string' && typeof id !== 'number') continue;
        if (typeof id === 'number' && !Number.isFinite(id)) continue;
        const value = String(id).trim();
        if (value) normalized.add(value);
    }

    return [...normalized];
}