/**
 * Resolução fail-closed da conexão VisMed de uma clínica.
 *
 * Ponto único de validação usado tanto pelo VismedSyncProcessor (caminho via fila)
 * quanto pelo SyncService.runVismedSyncDirect (caminho fallback sem Redis), garantindo
 * comportamento IDÊNTICO nos dois caminhos.
 *
 * Regras fail-closed:
 *  - Conexão VisMed ausente ou inexistente → VismedConnectionError
 *  - status 'error' ou 'disconnected' → VismedConnectionError
 *  - clientId ausente ou não-numérico → VismedConnectionError
 *  - domain ausente ou vazio → VismedConnectionError
 *
 * Nunca faz fallback silencioso para 'api-vissmed-7' nem para empresa 286.
 */

export class VismedConnectionError extends Error {
    readonly code = 'VISMED_CONNECTION_ERROR';
    constructor(message: string) {
        super(message);
        this.name = 'VismedConnectionError';
    }
}

export interface ResolvedVismedConnection {
    baseUrl: string;
    idEmpresaGestora: number;
}

/** Minimal prisma shape needed by the resolver (allows injection of fake in tests). */
interface PrismaLike {
    integrationConnection: {
        findFirst(args: any): Promise<{
            status?: string | null;
            clientId?: string | null;
            domain?: string | null;
        } | null>;
    };
}

export async function resolveVismedConnection(
    prisma: PrismaLike,
    clinicId: string,
): Promise<ResolvedVismedConnection> {
    const conn = await prisma.integrationConnection.findFirst({
        where: { clinicId, provider: 'vismed' },
    });

    if (!conn) {
        throw new VismedConnectionError(
            `Conexão VisMed não encontrada para clinicId=${clinicId}. Configure a integração VisMed antes de executar o Full Sync.`,
        );
    }

    if (conn.status === 'error' || conn.status === 'disconnected') {
        throw new VismedConnectionError(
            `Conexão VisMed está com status "${conn.status}" para clinicId=${clinicId}. Corrija a integração antes de executar o Full Sync.`,
        );
    }

    const idEmpresaGestora = conn.clientId ? Number(conn.clientId) : NaN;
    if (!Number.isFinite(idEmpresaGestora) || idEmpresaGestora <= 0) {
        throw new VismedConnectionError(
            `clientId inválido ou ausente na conexão VisMed de clinicId=${clinicId} (valor: ${JSON.stringify(conn.clientId)}). Corrija a configuração.`,
        );
    }

    const domain = typeof conn.domain === 'string' ? conn.domain.trim() : '';
    if (!domain) {
        throw new VismedConnectionError(
            `domain ausente na conexão VisMed de clinicId=${clinicId}. Configure o domínio (ex.: https://app.vissmed.com.br/api-docctor-3).`,
        );
    }

    return { baseUrl: domain, idEmpresaGestora };
}
