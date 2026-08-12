/**
 * WP-07 — Política PURA de retry HTTP para o DocplannerClient.
 *
 * Sem estado, sem I/O: recebe o erro classificado e devolve a decisão
 * (repetir ou não + quanto esperar). Toda a matriz operação × falha vive aqui,
 * testável isoladamente.
 *
 * Regras aprovadas:
 * - Máximo 3 tentativas HTTP TOTAIS (1 inicial + 2 retries) — inclui a
 *   repetição do mecanismo de 401 no orçamento.
 * - Elegíveis: apenas GET e PUT REPLACE_SLOTS (mesma matriz de idempotência
 *   do retry de 401 — isRetryableOperation do client).
 * - Falhas transitórias: 408, 429, 500, 502, 503, 504, timeout (AbortError),
 *   ECONNRESET, EAI_AGAIN, ETIMEDOUT.
 * - NUNCA repete: 400/401/403/404/405(WAF)/409/422, erros de negócio,
 *   ECONNREFUSED, POST/PATCH/DELETE e PUTs que não sejam REPLACE_SLOTS.
 * - Backoff exponencial com FULL JITTER: delay = random(0, min(cap, base·2^n)),
 *   base 1s, teto 30s.
 * - 429 respeita Retry-After (segundos OU HTTP-date): usa o MAIOR entre header
 *   e backoff; acima de 120s propaga a falha sem bloquear.
 */

export const MAX_HTTP_ATTEMPTS = 3;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;
export const RETRY_AFTER_MAX_MS = 120_000;

/** Status HTTP considerados transitórios (elegíveis a retry). */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Códigos de rede transitórios. ECONNREFUSED fica DE FORA (falha sustentada). */
const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT']);

export interface FailureClassification {
    /** true se a falha é de natureza transitória (retry faz sentido). */
    transient: boolean;
    /** Rótulo para métricas/logs: HTTP_503, TIMEOUT, ECONNRESET, HTTP_404, ... */
    classification: string;
    /** Status HTTP, quando houver. */
    status?: number;
}

/** Extrai o código de rede do erro (err.code ou err.cause.code — fetch do Node encapsula). */
function networkCode(err: any): string | undefined {
    const code = err?.code ?? err?.cause?.code;
    return typeof code === 'string' ? code : undefined;
}

/** Classifica uma falha do DocplannerClient (erro lançado por executeRequest). */
export function classifyFailure(err: any): FailureClassification {
    // WP-08B (CRÍTICO): erros de backpressure da fila são NON-RETRYABLE —
    // jamais `timeout da fila → retry → fila → timeout → retry`. Checagem por
    // code/name (sem import) para manter esta política pura e acíclica.
    if (err?.code === 'DOCTORALIA_QUEUE_FULL' || err?.name === 'DoctoraliaQueueFullError') {
        return { transient: false, classification: 'DOCTORALIA_QUEUE_FULL' };
    }
    if (err?.code === 'DOCTORALIA_QUEUE_TIMEOUT' || err?.name === 'DoctoraliaQueueTimeoutError') {
        return { transient: false, classification: 'DOCTORALIA_QUEUE_TIMEOUT' };
    }
    if (err?.name === 'AbortError') {
        return { transient: true, classification: 'TIMEOUT' };
    }
    const status = typeof err?.status === 'number' ? err.status : undefined;
    if (status !== undefined) {
        return {
            transient: RETRYABLE_STATUSES.has(status),
            classification: `HTTP_${status}`,
            status,
        };
    }
    const code = networkCode(err);
    if (code) {
        return { transient: TRANSIENT_NETWORK_CODES.has(code), classification: code };
    }
    return { transient: false, classification: 'OTHER' };
}

/**
 * Backoff exponencial com FULL JITTER: random(0, min(cap, base·2^retryIndex)).
 * retryIndex = 0 para o 1º retry, 1 para o 2º, ...
 */
export function computeBackoffMs(retryIndex: number, random: () => number = Math.random): number {
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, retryIndex));
    return random() * ceiling;
}

/**
 * Interpreta o header Retry-After: número inteiro de segundos OU HTTP-date.
 * Retorna ms (>= 0) ou null se ausente/ininteligível.
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number = Date.now()): number | null {
    if (value === null || value === undefined) return null;
    const v = String(value).trim();
    if (!v) return null;
    if (/^\d+$/.test(v)) return parseInt(v, 10) * 1000;
    const parsed = Date.parse(v);
    if (Number.isNaN(parsed)) return null;
    return Math.max(0, parsed - nowMs);
}

export type RetryDecision =
    | { retry: false; reason: string; exhausted: boolean }
    | { retry: true; delayMs: number; classification: string; usedRetryAfter: boolean };

export interface DecideRetryInput {
    error: any;
    /** Operação elegível pela matriz de idempotência (GET ou PUT REPLACE_SLOTS)? */
    retryEligible: boolean;
    /** Tentativas HTTP já consumidas (inclui a repetição de 401, se houve). */
    attemptsUsed: number;
    /** Índice do retry transitório (0 para o 1º retry) — controla o backoff. */
    retryIndex: number;
    random?: () => number;
    nowMs?: number;
}

/** Decide se repete e quanto esperar. Pura: sem efeitos colaterais. */
export function decideRetry(input: DecideRetryInput): RetryDecision {
    const { error, retryEligible, attemptsUsed, retryIndex } = input;
    const random = input.random ?? Math.random;
    const nowMs = input.nowMs ?? Date.now();

    if (!retryEligible) {
        return { retry: false, reason: 'operacao-nao-idempotente', exhausted: false };
    }
    const failure = classifyFailure(error);
    if (!failure.transient) {
        return { retry: false, reason: `falha-nao-transitoria:${failure.classification}`, exhausted: false };
    }
    if (attemptsUsed >= MAX_HTTP_ATTEMPTS) {
        return { retry: false, reason: 'orcamento-esgotado', exhausted: true };
    }

    let delayMs = computeBackoffMs(retryIndex, random);
    let usedRetryAfter = false;
    if (failure.status === 429) {
        const retryAfterMs = parseRetryAfterMs(error?.retryAfter, nowMs);
        if (retryAfterMs !== null) {
            if (retryAfterMs > RETRY_AFTER_MAX_MS) {
                // Servidor pede espera longa demais: propaga em vez de bloquear a fila.
                return { retry: false, reason: 'retry-after-acima-do-teto', exhausted: false };
            }
            usedRetryAfter = true;
            delayMs = Math.max(retryAfterMs, delayMs);
        }
    }
    return { retry: true, delayMs, classification: failure.classification, usedRetryAfter };
}
