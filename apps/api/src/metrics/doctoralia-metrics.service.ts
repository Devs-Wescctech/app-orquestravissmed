/**
 * WP-01 — Observabilidade e Baseline Doctoralia
 *
 * Serviço singleton de métricas em memória (zero acesso a banco, zero chamadas
 * externas). Qualquer falha interna é capturada e logada sem propagar ao fluxo.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DoctoraliaOrigin } from './doctoralia-call-context';

// ──────────────────────────── Tipos públicos ─────────────────────────────────

export interface DoctoraliaRequestEvent {
    doctoraliaRequestId: string;
    origin: DoctoraliaOrigin;
    clinicId?: string;
    operation: string;
    endpoint: string;   // sanitizado: IDs numéricos → :id (com query params preservados)
    /**
     * WP-01: chave do recurso real computada ANTES da sanitização do path.
     * Formato: IDs numéricos extraídos do path em ordem, ex.: "123|456|789"
     * Usado em buildSignature() para distinguir chamadas a recursos diferentes
     * (doctor/address distintos) com a mesma operação e datas.
     * Não contém nenhum dado pessoal — apenas IDs Doctoralia.
     */
    resourceKey?: string;
    method: string;
    httpStatus?: number | 'TIMEOUT' | 'NETWORK' | 'OTHER';
    isRetry: boolean;
    retryNumber: number;
    isOAuth: boolean;
    enqueuedAt: number;
    releasedAt: number;
    sentAt: number;
    respondedAt: number;
    waitMs: number;     // releasedAt − enqueuedAt
    execMs: number;     // respondedAt − sentAt
    requestId?: string; // USER_INTERACTIVE: HTTP requestId
    pollExecutionId?: string;
}

export interface RateLimiterEvent {
    provider: string;
    tokensAvailableBefore: number;
    tokensAvailableAfter: number;
    waitMsExpected: number;
    waitMsActual: number;
    blocked: boolean;
    recordedAt: number;
}

export interface PollExecution {
    pollExecutionId: string;
    clinicId: string;
    startedAt: number;
    endedAt?: number;
    doctoraliaCallCount: number;
    vismedCallCount: number;
    reconciliationCount: number;
}

export interface OverlapEvent {
    clinicId: string;
    newPollExecutionId: string;
    activePollExecutionIds: string[];
    activePollDurations: number[];
    startedAt: number;
    concurrency: number;
}

export interface SlotSyncEvent {
    doctorId: string;
    addressId: string;
    clinicId?: string;
    event: 'SLOT_SYNC_SKIPPED_UNCHANGED' | 'SLOT_SYNC_PUSHED_CHANGED';
    durationMs: number;
    retries: number;
    errors: number;
    recordedAt: number;
}

export interface DuplicateEvent {
    signature: string;
    endpoint: string;
    method: string;
    operation: string;
    clinicId?: string;
    origin: DoctoraliaOrigin;
    windowMs: number;
    recordedAt: number;
}

// ──────────────────────────── Constantes ─────────────────────────────────────

const MAX_EVENTS = 10_000;
const DUPLICATE_WINDOW_MS = 30_000;   // 30s

const WAIT_BUCKETS = [1000, 5000, 10000, 30000, 60000] as const;
type BucketLabel = '<1s' | '1-5s' | '5-10s' | '10-30s' | '30-60s' | '>60s';

function waitBucket(ms: number): BucketLabel {
    if (ms < 1000) return '<1s';
    if (ms < 5000) return '1-5s';
    if (ms < 10000) return '5-10s';
    if (ms < 30000) return '10-30s';
    if (ms < 60000) return '30-60s';
    return '>60s';
}

function sanitizeEndpoint(path: string): string {
    return path.replace(/\/\d+/g, '/:id');
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ──────────────────────────── Serviço ────────────────────────────────────────

/** Singleton global acessível por DocplannerClient (não-NestJS) de forma fail-safe. */
let _globalInstance: DoctoraliaMetricsService | null = null;

export function getDoctoraliaMetricsService(): DoctoraliaMetricsService | null {
    return _globalInstance;
}

@Injectable()
export class DoctoraliaMetricsService {
    private readonly logger = new Logger(DoctoraliaMetricsService.name);

    // Eventos de requisição
    private readonly events: DoctoraliaRequestEvent[] = [];
    // Eventos do RateLimiterService (token bucket)
    private readonly rateLimiterEvents: RateLimiterEvent[] = [];
    // Polls ativos: clinicId → Map<pollExecutionId, PollExecution>
    private readonly activePolls = new Map<string, Map<string, PollExecution>>();
    // Polls finalizados (buffer circular)
    private readonly completedPolls: PollExecution[] = [];
    // Eventos de sobreposição
    private readonly overlapEvents: OverlapEvent[] = [];
    // Contadores de sobreposição
    private totalOverlapCount = 0;
    private maxConcurrentPolls = 0;
    // Slot sync
    private readonly slotSyncEvents: SlotSyncEvent[] = [];
    // Duplicatas
    private readonly duplicateEvents: DuplicateEvent[] = [];
    // Assinaturas recentes: signature → timestamp[]
    private readonly recentSignatures = new Map<string, number[]>();

    // Início da medição
    private startedAt = Date.now();

    // Snapshot ponto-a-ponto do DocplannerClient (acquireRateSlot)
    private lastRateSnapshot: {
        usedInWindow: number;
        remainingInWindow: number;
        queueSizeHigh: number;
        queueSizeLow: number;
        recordedAt: number;
    } | null = null;

    constructor() {
        // Registra instância global para uso por DocplannerClient (não-NestJS)
        _globalInstance = this;
    }

    // ────────────────── record() ────────────────────────────────────────────

    record(event: DoctoraliaRequestEvent): void {
        try {
            if (this.events.length >= MAX_EVENTS) {
                this.events.shift();
            }
            this.events.push(event);
            this.checkDuplicate(event);
        } catch (err: any) {
            this.logger.debug(`[METRICS] record() error (non-fatal): ${err?.message}`);
        }
    }

    recordRateLimiter(event: RateLimiterEvent): void {
        try {
            if (this.rateLimiterEvents.length >= MAX_EVENTS) {
                this.rateLimiterEvents.shift();
            }
            this.rateLimiterEvents.push(event);
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordRateLimiter() error (non-fatal): ${err?.message}`);
        }
    }

    /**
     * Armazena o snapshot mais recente do estado do rate limiter/fila do DocplannerClient.
     * Chamado dentro de acquireRateSlot() ao liberar cada slot — ponto-a-ponto, não série histórica.
     */
    recordRateSnapshot(snapshot: {
        usedInWindow: number;
        remainingInWindow: number;
        queueSizeHigh: number;
        queueSizeLow: number;
    }): void {
        try {
            this.lastRateSnapshot = { ...snapshot, recordedAt: Date.now() };
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordRateSnapshot() error (non-fatal): ${err?.message}`);
        }
    }

    /**
     * Reinicia todas as coleções em memória para o estado inicial.
     * Preserva o `startedAt` como o momento do reset (nova janela de medição).
     */
    reset(): void {
        try {
            this.events.length = 0;
            this.rateLimiterEvents.length = 0;
            this.activePolls.clear();
            this.completedPolls.length = 0;
            this.overlapEvents.length = 0;
            this.totalOverlapCount = 0;
            this.maxConcurrentPolls = 0;
            this.slotSyncEvents.length = 0;
            this.duplicateEvents.length = 0;
            this.recentSignatures.clear();
            this.lastRateSnapshot = null;
            this.startedAt = Date.now();
        } catch (err: any) {
            this.logger.warn(`[METRICS] reset() error: ${err?.message}`);
            throw err;
        }
    }

    // ────────────────── Poll tracking ───────────────────────────────────────

    trackPollStart(clinicId: string, pollExecutionId: string): OverlapEvent | null {
        try {
            if (!this.activePolls.has(clinicId)) {
                this.activePolls.set(clinicId, new Map());
            }
            const clinicPolls = this.activePolls.get(clinicId)!;

            let overlapEvent: OverlapEvent | null = null;
            if (clinicPolls.size > 0) {
                const now = Date.now();
                const activePollIds = [...clinicPolls.keys()];
                const activeDurations = [...clinicPolls.values()].map(p => now - p.startedAt);
                overlapEvent = {
                    clinicId,
                    newPollExecutionId: pollExecutionId,
                    activePollExecutionIds: activePollIds,
                    activePollDurations: activeDurations,
                    startedAt: now,
                    concurrency: clinicPolls.size + 1,
                };
                this.overlapEvents.push(overlapEvent);
                this.totalOverlapCount++;

                // Calcula concorrência global
                let globalConcurrency = 0;
                for (const [, polls] of this.activePolls) {
                    globalConcurrency += polls.size;
                }
                globalConcurrency++; // conta o novo
                if (globalConcurrency > this.maxConcurrentPolls) {
                    this.maxConcurrentPolls = globalConcurrency;
                }

                this.logger.warn(
                    `[METRICS] OVERLAPPING_POLL_DETECTED clinicId=${clinicId} newPoll=${pollExecutionId} ` +
                    `activePolls=[${activePollIds.join(',')}] concurrency=${overlapEvent.concurrency}`,
                );
            } else {
                let globalConcurrency = 0;
                for (const [, polls] of this.activePolls) {
                    globalConcurrency += polls.size;
                }
                globalConcurrency++;
                if (globalConcurrency > this.maxConcurrentPolls) {
                    this.maxConcurrentPolls = globalConcurrency;
                }
            }

            clinicPolls.set(pollExecutionId, {
                pollExecutionId,
                clinicId,
                startedAt: Date.now(),
                doctoraliaCallCount: 0,
                vismedCallCount: 0,
                reconciliationCount: 0,
            });

            return overlapEvent;
        } catch (err: any) {
            this.logger.debug(`[METRICS] trackPollStart() error (non-fatal): ${err?.message}`);
            return null;
        }
    }

    trackPollEnd(clinicId: string, pollExecutionId: string): void {
        try {
            const clinicPolls = this.activePolls.get(clinicId);
            if (!clinicPolls) return;
            const poll = clinicPolls.get(pollExecutionId);
            if (poll) {
                poll.endedAt = Date.now();
                this.completedPolls.push(poll);
                if (this.completedPolls.length > 1000) this.completedPolls.shift();
            }
            clinicPolls.delete(pollExecutionId);
        } catch (err: any) {
            this.logger.debug(`[METRICS] trackPollEnd() error (non-fatal): ${err?.message}`);
        }
    }

    recordSlotSync(event: SlotSyncEvent): void {
        try {
            if (this.slotSyncEvents.length >= MAX_EVENTS) this.slotSyncEvents.shift();
            this.slotSyncEvents.push(event);
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordSlotSync() error (non-fatal): ${err?.message}`);
        }
    }

    // ────────────────── Duplicate detection ─────────────────────────────────

    private checkDuplicate(event: DoctoraliaRequestEvent): void {
        try {
            const sig = this.buildSignature(event);
            if (!sig) return;

            const now = Date.now();
            const prev = this.recentSignatures.get(sig) ?? [];
            const fresh = prev.filter(t => now - t < DUPLICATE_WINDOW_MS);

            if (fresh.length > 0) {
                const dupEvent: DuplicateEvent = {
                    signature: sig,
                    endpoint: event.endpoint,
                    method: event.method,
                    operation: event.operation,
                    clinicId: event.clinicId,
                    origin: event.origin,
                    windowMs: DUPLICATE_WINDOW_MS,
                    recordedAt: now,
                };
                if (this.duplicateEvents.length >= 1000) this.duplicateEvents.shift();
                this.duplicateEvents.push(dupEvent);
                this.logger.debug(
                    `[METRICS] POTENTIAL_DUPLICATE_REQUEST signature=${sig} origin=${event.origin} clinicId=${event.clinicId}`,
                );
            }

            fresh.push(now);
            this.recentSignatures.set(sig, fresh);

            // Limpeza periódica
            if (this.recentSignatures.size > 5000) {
                for (const [k, timestamps] of this.recentSignatures) {
                    if (timestamps.every(t => now - t > DUPLICATE_WINDOW_MS)) {
                        this.recentSignatures.delete(k);
                    }
                }
            }
        } catch (err: any) {
            this.logger.debug(`[METRICS] checkDuplicate() error (non-fatal): ${err?.message}`);
        }
    }

    /**
     * Assinatura lógica por tipo de operação.
     *
     * Inclui `clinicId` e `resourceKey` (IDs reais do path computados antes da
     * sanitização) para diferenciar chamadas a médicos/endereços/clínicas distintas
     * com a mesma operação e intervalo de datas.
     *
     * - bookings/slots: clinicId+resourceKey+method+operation+start+end
     * - breaks:         clinicId+resourceKey+method+operation+since+till
     * - demais:         clinicId+resourceKey+method+operation+endpoint
     */
    private buildSignature(event: DoctoraliaRequestEvent): string | null {
        if (event.isOAuth) return null; // OAuth não é duplicado funcional
        const ep = event.endpoint;
        const m = event.method;
        const op = event.operation;
        // clinicId + resourceKey discriminam o recurso real; evitam falsos positivos
        // entre clínicas distintas ou médicos/endereços distintos dentro da mesma clínica.
        const clinic = event.clinicId ?? '';
        const resource = event.resourceKey ?? '';

        // Extrai query params da URL (start/end/since/till)
        const urlParams = this.extractUrlParams(ep);

        if (op.includes('BOOKING') || op.includes('SLOT')) {
            const start = urlParams.start ?? '';
            const end = urlParams.end ?? '';
            return `${clinic}|${resource}|${m}|${op}|${start}|${end}`;
        }
        if (op.includes('BREAK')) {
            const since = urlParams.since ?? '';
            const till = urlParams.till ?? '';
            return `${clinic}|${resource}|${m}|${op}|${since}|${till}`;
        }
        return `${clinic}|${resource}|${m}|${op}|${ep}`;
    }

    private extractUrlParams(endpoint: string): Record<string, string> {
        const result: Record<string, string> = {};
        // Extrai facilityId, doctorId, addressId de padrão /facilities/:id/doctors/:id/addresses/:id
        const match = endpoint.match(
            /facilities\/([^/]+)\/doctors\/([^/]+)(?:\/addresses\/([^/]+))?/,
        );
        if (match) {
            result.facilityId = match[1];
            result.doctorId = match[2];
            if (match[3]) result.addressId = match[3];
        }
        // Query params
        const qIdx = endpoint.indexOf('?');
        if (qIdx >= 0) {
            const qs = endpoint.slice(qIdx + 1);
            for (const part of qs.split('&')) {
                const [k, v] = part.split('=');
                if (k && v) result[decodeURIComponent(k)] = decodeURIComponent(v);
            }
        }
        return result;
    }

    // ────────────────── Relatório ────────────────────────────────────────────

    getBaseline(): Record<string, any> {
        try {
            return this.buildBaseline();
        } catch (err: any) {
            this.logger.warn(`[METRICS] getBaseline() error: ${err?.message}`);
            return { error: 'Failed to build baseline', message: err?.message };
        }
    }

    private buildBaseline(): Record<string, any> {
        const apiEvents = this.events.filter(e => !e.isOAuth);
        const oauthEvents = this.events.filter(e => e.isOAuth);

        // Volume por origem
        const byOrigin: Record<string, number> = {};
        for (const e of this.events) {
            byOrigin[e.origin] = (byOrigin[e.origin] ?? 0) + 1;
        }

        // Fila (waitMs) — p50/p95/p99/max/buckets
        const waitMsAll = this.events.map(e => e.waitMs).sort((a, b) => a - b);
        const buckets: Record<BucketLabel, number> = {
            '<1s': 0, '1-5s': 0, '5-10s': 0, '10-30s': 0, '30-60s': 0, '>60s': 0,
        };
        for (const ms of waitMsAll) buckets[waitBucket(ms)]++;

        // Erros
        const errorCounts: Record<string, number> = {};
        for (const e of this.events) {
            const s = e.httpStatus;
            if (!s || typeof s === 'number' && s < 400) continue;
            const key = typeof s === 'number' ? String(s) : s;
            errorCounts[key] = (errorCounts[key] ?? 0) + 1;
        }

        // Polling
        const clinicPollCounts: Record<string, number> = {};
        for (const p of this.completedPolls) {
            clinicPollCounts[p.clinicId] = (clinicPollCounts[p.clinicId] ?? 0) + 1;
        }
        const totalActivePolls = [...this.activePolls.values()].reduce((s, m) => s + m.size, 0);

        // Agendamentos (USER_INTERACTIVE)
        const uiEvents = apiEvents.filter(e => e.origin === 'USER_INTERACTIVE');
        const uiWaitMs = uiEvents.map(e => e.waitMs).sort((a, b) => a - b);
        const uiExecMs = uiEvents.map(e => e.execMs).sort((a, b) => a - b);
        const uiTimeouts = uiEvents.filter(e => e.httpStatus === 'TIMEOUT').length;
        const uiErrors = uiEvents.filter(e => e.httpStatus && (typeof e.httpStatus === 'string' || e.httpStatus >= 400)).length;

        // RateLimiterService
        const rlBlocked = this.rateLimiterEvents.filter(e => e.blocked).length;
        const rlWaitMs = this.rateLimiterEvents.map(e => e.waitMsActual).sort((a, b) => a - b);

        // Escopo de instância
        const instanceId = process.env.NODE_APP_INSTANCE ?? process.env.REPL_ID ?? process.pid.toString();
        const instanceCountRaw = process.env.NODE_APP_INSTANCE ?? null;
        const instanceCount = instanceCountRaw !== null ? 'DETERMINED' : 'UNKNOWN';
        const scope = instanceCount === 'UNKNOWN' ? 'SINGLE_INSTANCE' : 'MULTI_INSTANCE_PARTIAL';

        return {
            generatedAt: new Date().toISOString(),
            dataSource: 'live' as const,
            measurementPeriodMs: Date.now() - this.startedAt,
            measurementScope: {
                instanceId,
                instanceCount,
                scope,
                note: instanceCount === 'UNKNOWN'
                    ? 'NODE_APP_INSTANCE não configurado — assume instância única'
                    : 'Métricas desta instância apenas',
            },
            volume: {
                DOCTORALIA_API_REQUEST_COUNT: apiEvents.length,
                DOCTORALIA_OAUTH_REQUEST_COUNT: oauthEvents.length,
                totalDoctoraliaRequests: this.events.length,
                byOrigin,
            },
            queue: {
                waitMs: {
                    p50: percentile(waitMsAll, 50),
                    p95: percentile(waitMsAll, 95),
                    p99: percentile(waitMsAll, 99),
                    max: waitMsAll[waitMsAll.length - 1] ?? 0,
                    buckets,
                },
                DOCTORALIA_RATE_LIMIT_USAGE: this.lastRateSnapshot?.usedInWindow ?? null,
                DOCTORALIA_RATE_LIMIT_REMAINING: this.lastRateSnapshot?.remainingInWindow ?? null,
                DOCTORALIA_QUEUE_SIZE_HIGH: this.lastRateSnapshot?.queueSizeHigh ?? null,
                DOCTORALIA_QUEUE_SIZE_LOW: this.lastRateSnapshot?.queueSizeLow ?? null,
                rateSnapshotRecordedAt: this.lastRateSnapshot
                    ? new Date(this.lastRateSnapshot.recordedAt).toISOString()
                    : null,
            },
            rateLimiterService: {
                totalEvents: this.rateLimiterEvents.length,
                blockedRequests: rlBlocked,
                waitMs: {
                    p50: percentile(rlWaitMs, 50),
                    p95: percentile(rlWaitMs, 95),
                    max: rlWaitMs[rlWaitMs.length - 1] ?? 0,
                },
            },
            errors: errorCounts,
            polling: {
                clinicsPolled: Object.keys(clinicPollCounts).length,
                totalCompletedPolls: this.completedPolls.length,
                totalActivePolls,
                OVERLAPPING_POLL_COUNT: this.totalOverlapCount,
                MAX_CONCURRENT_POLLS: this.maxConcurrentPolls,
                recentOverlaps: this.overlapEvents.slice(-10),
            },
            appointments: {
                totalRequests: uiEvents.length,
                avgWaitMs: uiWaitMs.length ? Math.round(uiWaitMs.reduce((a, b) => a + b, 0) / uiWaitMs.length) : 0,
                p95WaitMs: percentile(uiWaitMs, 95),
                p99WaitMs: percentile(uiWaitMs, 99),
                avgExecMs: uiExecMs.length ? Math.round(uiExecMs.reduce((a, b) => a + b, 0) / uiExecMs.length) : 0,
                p95ExecMs: percentile(uiExecMs, 95),
                timeouts: uiTimeouts,
                errors: uiErrors,
            },
            slotSync: {
                totalEvents: this.slotSyncEvents.length,
                skippedUnchanged: this.slotSyncEvents.filter(e => e.event === 'SLOT_SYNC_SKIPPED_UNCHANGED').length,
                pushed: this.slotSyncEvents.filter(e => e.event === 'SLOT_SYNC_PUSHED_CHANGED').length,
            },
            duplicates: {
                POTENTIAL_DUPLICATE_REQUEST_COUNT: this.duplicateEvents.length,
                recentDuplicates: this.duplicateEvents.slice(-10),
            },
        };
    }

    /** Expõe dados para testes sem expor internals desnecessários. */
    getEvents(): readonly DoctoraliaRequestEvent[] {
        return this.events;
    }

    getOverlapEvents(): readonly OverlapEvent[] {
        return this.overlapEvents;
    }

    getDuplicateEvents(): readonly DuplicateEvent[] {
        return this.duplicateEvents;
    }

    getRateLimiterEvents(): readonly RateLimiterEvent[] {
        return this.rateLimiterEvents;
    }

    getTotalOverlapCount(): number {
        return this.totalOverlapCount;
    }

    getMaxConcurrentPolls(): number {
        return this.maxConcurrentPolls;
    }

    /** Sanitiza endpoint: substitui IDs numéricos por :id. Exposto para uso do client. */
    static sanitizeEndpoint(path: string): string {
        return sanitizeEndpoint(path);
    }
}
