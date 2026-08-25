/**
 * Fronteira da rota oficial que recoloca agendamentos no feed incremental.
 * O aceite da solicitação não é ACK de processamento: os itens retornam ao
 * polling normal e percorrem o mesmo upsert.
 */
export interface VismedAppointmentFeedRecoveryClient {
    requestRedelivery(vismedAppointmentIds: readonly string[]): Promise<void>;
}

/**
 * Mantém somente IDs identificáveis e elimina repetições antes da chamada em
 * lote. Não persiste ACK, fila ou estado de retry.
 */
export function normalizeVismedAppointmentRecoveryIds(ids: Iterable<unknown>): string[] {
    const normalized = new Set<string>();

    for (const id of ids) {
        if (typeof id !== 'string' && typeof id !== 'number') continue;
        if (typeof id === 'number' && !Number.isFinite(id)) continue;
        const value = String(id).trim();
        // A API recebe CSV sem mecanismo de escape. Vírgulas ou controles
        // poderiam transformar um candidato em IDs adicionais.
        if (value && !/[,\u0000-\u001f\u007f]/.test(value)) normalized.add(value);
    }

    return [...normalized];
}