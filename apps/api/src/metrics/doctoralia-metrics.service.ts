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
const MAX_RATE_SNAPSHOTS = 100;        // histórico circular de snapshots de rate limiter

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

// ─────────── WP-02 P2c + WP-04: tipos de skip do guard de concorrência ──────

/** Rótulo curto de cada subsistema no nome do contador. */
const CONCURRENCY_ACTORS = ['POLL', 'SWEEP', 'GLOBAL_SYNC', 'SLOT_SYNC'] as const;
type ConcurrencyActor = (typeof CONCURRENCY_ACTORS)[number];

/**
 * <QUEM FOI SKIPADO>_SKIPPED_<QUEM ESTAVA ATIVO>_ACTIVE — todos os cruzamentos.
 * Task 133 adiciona <QUEM FOI SKIPADO>_SKIPPED_GLOBAL_SYNC_PENDING (bloqueio por
 * reserva de prioridade do Global Sync, sem subsistema ativo) e
 * GLOBAL_SYNC_RESERVATION_EXPIRED (expiração de reserva por TTL — evento anômalo).
 */
export type ConcurrencySkipType =
    | `${ConcurrencyActor}_SKIPPED_${ConcurrencyActor}_ACTIVE`
    | `${ConcurrencyActor}_SKIPPED_GLOBAL_SYNC_PENDING`
    | 'GLOBAL_SYNC_RESERVATION_EXPIRED';

export function emptyConcurrencySkipCounts(): Record<ConcurrencySkipType, number> {
    const counts = {} as Record<ConcurrencySkipType, number>;
    for (const skipped of CONCURRENCY_ACTORS) {
        for (const active of CONCURRENCY_ACTORS) {
            counts[`${skipped}_SKIPPED_${active}_ACTIVE`] = 0;
        }
        counts[`${skipped}_SKIPPED_GLOBAL_SYNC_PENDING`] = 0;
    }
    counts['GLOBAL_SYNC_RESERVATION_EXPIRED'] = 0;
    return counts;
}

/** Mapeia o subsistema do guard para o rótulo do contador. */
export function concurrencyActorOf(subsystem: 'POLLING' | 'SAFETY_SWEEP' | 'GLOBAL_SYNC' | 'SLOT_SYNC'): ConcurrencyActor {
    if (subsystem === 'POLLING') return 'POLL';
    if (subsystem === 'SAFETY_SWEEP') return 'SWEEP';
    return subsystem;
}

// ─────────── WP-08B: backpressure da fila HIGH/LOW do DocplannerClient ──────

const MAX_QUEUE_WAIT_SAMPLES = 500;

function emptyQueueBackpressureStats() {
    const wait = () => ({ count: 0, totalMs: 0, samples: [] as number[] });
    return {
        rejectedFull: { HIGH: 0, LOW: 0 },
        expired: { HIGH: 0, LOW: 0 },
        current: { HIGH: 0, LOW: 0 },
        peak: { HIGH: 0, LOW: 0 },
        oldestWaiterAgeMs: { HIGH: 0, LOW: 0 },
        waits: { HIGH: wait(), LOW: wait() },
    };
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

    // WP-02 P2c + WP-04: Contadores de bloqueio por concorrência (todos os cruzamentos)
    private concurrencySkipCounts: Record<ConcurrencySkipType, number> = emptyConcurrencySkipCounts();

    // WP-05: GETs que se juntaram a um voo idêntico já em andamento (dedup in-flight)
    private dedupedGetCount = 0;

    // WP-08B: backpressure da fila HIGH/LOW do DocplannerClient
    private queueBackpressureStats = emptyQueueBackpressureStats();

    // WP-07: contadores aditivos de retries transitórios do DocplannerClient
    private transientRetryStats = {
        total: 0,
        byClassification: {} as Record<string, number>,
        succeeded: 0,
        exhausted: 0,
        retryAfterWaits: 0,
        retryAfterWaitMsTotal: 0,
    };

    // Início da medição
    private startedAt = Date.now();

    // Snapshot ponto-a-ponto do DocplannerClient (acquireRateSlot) — último valor observado
    private lastRateSnapshot: {
        usedInWindow: number;
        remainingInWindow: number;
        queueSizeHigh: number;
        queueSizeLow: number;
        recordedAt: number;
        // Budget WRITE (opcional — preenchido quando o client propaga esses valores)
        writeUsedInMinute?: number;
        writeRemainingInMinute?: number;
        writeUsedInHour?: number;
        writeRemainingInHour?: number;
    } | null = null;

    // Histórico circular de snapshots (máx. MAX_RATE_SNAPSHOTS entradas, FIFO)
    private readonly rateSnapshots: Array<{
        usedInWindow: number;
        remainingInWindow: number;
        queueSizeHigh: number;
        queueSizeLow: number;
        recordedAt: number;
        writeUsedInMinute?: number;
        writeRemainingInMinute?: number;
        writeUsedInHour?: number;
        writeRemainingInHour?: number;
    }> = [];

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
     * Chamado dentro de acquireRateSlot() ao liberar cada slot.
     * Mantém histórico circular (MAX_RATE_SNAPSHOTS entradas) para cálculo de picos na janela.
     * Os campos de budget WRITE são opcionais para retrocompatibilidade.
     */
    recordRateSnapshot(snapshot: {
        usedInWindow: number;
        remainingInWindow: number;
        queueSizeHigh: number;
        queueSizeLow: number;
        // Budget WRITE (aditivo — não quebra consumidores existentes)
        writeUsedInMinute?: number;
        writeRemainingInMinute?: number;
        writeUsedInHour?: number;
        writeRemainingInHour?: number;
    }): void {
        try {
            const entry = { ...snapshot, recordedAt: Date.now() };
            this.lastRateSnapshot = entry;
            if (this.rateSnapshots.length >= MAX_RATE_SNAPSHOTS) {
                this.rateSnapshots.shift();
            }
            this.rateSnapshots.push(entry);
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
            this.rateSnapshots.length = 0;
            // WP-02 P2c + WP-04
            this.concurrencySkipCounts = emptyConcurrencySkipCounts();
            // WP-05
            this.dedupedGetCount = 0;
            // WP-07
            this.transientRetryStats = {
                total: 0,
                byClassification: {},
                succeeded: 0,
                exhausted: 0,
                retryAfterWaits: 0,
                retryAfterWaitMsTotal: 0,
            };
            // WP-08A
            this.circuitStats.clear();
            // WP-08B
            this.queueBackpressureStats = emptyQueueBackpressureStats();
            // Task 170: pacing LOW
            this.lowPacingStats = {
                waitCount: 0, totalWaitMs: 0, maxWaitMs: 0,
                lastOccupancyPct: 0, lastAppliedAt: null,
            };
            this.startedAt = Date.now();
        } catch (err: any) {
            this.logger.warn(`[METRICS] reset() error: ${err?.message}`);
            throw err;
        }
    }

    // ─────────── WP-02 P2c + WP-04: Concurrency skip recording ──────────────

    /**
     * Registra um bloqueio por concorrência de clínica.
     * Formato: <QUEM FOI SKIPADO>_SKIPPED_<QUEM ESTAVA ATIVO>_ACTIVE.
     * Subsistemas: POLL (polling), SWEEP (safety sweep), GLOBAL_SYNC (sync
     * completo Doctoralia por clínica) e SLOT_SYNC (re-sync do Block Watcher).
     * WP-04 adicionou todos os cruzamentos de/por GLOBAL_SYNC e SLOT_SYNC.
     */
    recordConcurrencySkip(type: ConcurrencySkipType, clinicId?: string): void {
        try {
            this.concurrencySkipCounts[type] = (this.concurrencySkipCounts[type] ?? 0) + 1;
            this.logger.debug(`[METRICS] ${type} clinicId=${clinicId ?? 'unknown'}`);
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordConcurrencySkip() error (non-fatal): ${err?.message}`);
        }
    }

    getConcurrencySkipCounts(): Record<ConcurrencySkipType, number> {
        return { ...this.concurrencySkipCounts };
    }

    // ─────────── WP-05: contador de GETs deduplicados (fail-safe, aditivo) ───

    recordDedupedGet(): void {
        try {
            this.dedupedGetCount++;
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordDedupedGet() error (non-fatal): ${err?.message}`);
        }
    }

    getDedupedGetCount(): number {
        return this.dedupedGetCount;
    }

    // ─────────── WP-07: retries transitórios (fail-safe, aditivo) ────────────

    /** Registra UMA retentativa transitória; retryAfterMs presente quando o Retry-After foi honrado. */
    recordTransientRetry(classification: string, retryAfterMs?: number): void {
        try {
            this.transientRetryStats.total++;
            this.transientRetryStats.byClassification[classification] =
                (this.transientRetryStats.byClassification[classification] ?? 0) + 1;
            if (retryAfterMs !== undefined) {
                this.transientRetryStats.retryAfterWaits++;
                this.transientRetryStats.retryAfterWaitMsTotal += retryAfterMs;
            }
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordTransientRetry() error (non-fatal): ${err?.message}`);
        }
    }

    /** Desfecho de uma sequência que teve retry: sucesso após retry ou orçamento esgotado. */
    recordTransientRetryOutcome(outcome: 'succeeded' | 'exhausted'): void {
        try {
            this.transientRetryStats[outcome]++;
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordTransientRetryOutcome() error (non-fatal): ${err?.message}`);
        }
    }

    getTransientRetryStats() {
        return {
            ...this.transientRetryStats,
            byClassification: { ...this.transientRetryStats.byClassification },
        };
    }

    // ─────────── WP-08B: backpressure da fila HIGH/LOW (fail-safe) ───────────

    /** Rejeição imediata por fila cheia (nenhum waiter criado, nenhum slot). */
    recordQueueRejectedFull(priority: 'HIGH' | 'LOW', queueSize: number): void {
        try {
            this.queueBackpressureStats.rejectedFull[priority]++;
            this.logger.debug(`[METRICS] QUEUE_REJECTED_FULL priority=${priority} queueSize=${queueSize}`);
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordQueueRejectedFull() error (non-fatal): ${err?.message}`);
        }
    }

    /** Waiter expirou o deadline de espera na fila (removido sem consumir slot). */
    recordQueueExpired(priority: 'HIGH' | 'LOW', waitMs: number): void {
        try {
            this.queueBackpressureStats.expired[priority]++;
            this.logger.debug(`[METRICS] QUEUE_EXPIRED priority=${priority} waitMs=${waitMs}`);
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordQueueExpired() error (non-fatal): ${err?.message}`);
        }
    }

    /** Espera efetiva na fila até o grant (base para média/p95 por prioridade). */
    recordQueueWait(priority: 'HIGH' | 'LOW', waitMs: number): void {
        try {
            const w = this.queueBackpressureStats.waits[priority];
            w.count++;
            w.totalMs += waitMs;
            if (w.samples.length >= MAX_QUEUE_WAIT_SAMPLES) w.samples.shift();
            w.samples.push(waitMs);
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordQueueWait() error (non-fatal): ${err?.message}`);
        }
    }

    /** Profundidade atual + idade do waiter mais antigo (gauges + picos desde restart). */
    recordQueueDepth(high: number, low: number, oldestHighAgeMs: number, oldestLowAgeMs: number): void {
        try {
            const s = this.queueBackpressureStats;
            s.current.HIGH = high;
            s.current.LOW = low;
            s.oldestWaiterAgeMs.HIGH = oldestHighAgeMs;
            s.oldestWaiterAgeMs.LOW = oldestLowAgeMs;
            if (high > s.peak.HIGH) s.peak.HIGH = high;
            if (low > s.peak.LOW) s.peak.LOW = low;
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordQueueDepth() error (non-fatal): ${err?.message}`);
        }
    }

    // ─────────── Task 170: pacing de grants LOW (fail-safe, aditivo) ─────────

    private lowPacingStats = {
        waitCount: 0,
        totalWaitMs: 0,
        maxWaitMs: 0,
        lastOccupancyPct: 0,
        lastAppliedAt: null as number | null,
    };

    /**
     * Registra UMA espera de pacing aplicada a um grant LOW (ocupação da janela
     * agregada ≥ threshold). occupancy em fração 0–1; waitMs = atraso aplicado.
     */
    recordLowPacingWait(occupancy: number, waitMs: number): void {
        try {
            const s = this.lowPacingStats;
            s.waitCount++;
            s.totalWaitMs += waitMs;
            if (waitMs > s.maxWaitMs) s.maxWaitMs = waitMs;
            s.lastOccupancyPct = Math.round(occupancy * 100);
            s.lastAppliedAt = Date.now();
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordLowPacingWait() error (non-fatal): ${err?.message}`);
        }
    }

    getLowPacingStats() {
        const s = this.lowPacingStats;
        return {
            waitCount: s.waitCount,
            totalWaitMs: s.totalWaitMs,
            avgWaitMs: s.waitCount > 0 ? Math.round(s.totalWaitMs / s.waitCount) : 0,
            maxWaitMs: s.maxWaitMs,
            lastOccupancyPct: s.lastOccupancyPct,
            lastAppliedAt: s.lastAppliedAt ? new Date(s.lastAppliedAt).toISOString() : null,
        };
    }

    getQueueBackpressureStats() {
        const s = this.queueBackpressureStats;
        const summarize = (p: 'HIGH' | 'LOW') => {
            const w = s.waits[p];
            const sorted = [...w.samples].sort((a, b) => a - b);
            return {
                grantedCount: w.count,
                avgWaitMs: w.count > 0 ? Math.round(w.totalMs / w.count) : 0,
                p95WaitMs: percentile(sorted, 95),
            };
        };
        return {
            queueHighCurrent: s.current.HIGH,
            queueLowCurrent: s.current.LOW,
            queueHighRejectedFull: s.rejectedFull.HIGH,
            queueLowRejectedFull: s.rejectedFull.LOW,
            queueHighExpired: s.expired.HIGH,
            queueLowExpired: s.expired.LOW,
            oldestWaiterAgeMsHigh: s.oldestWaiterAgeMs.HIGH,
            oldestWaiterAgeMsLow: s.oldestWaiterAgeMs.LOW,
            peakHigh: s.peak.HIGH,
            peakLow: s.peak.LOW,
            waitHigh: summarize('HIGH'),
            waitLow: summarize('LOW'),
        };
    }

    // ────────────────── WP-08A: Circuit breaker Doctoralia ──────────────────

    private circuitStats = new Map<string, {
        domain: string;
        state: string;
        openReason: string | null;
        cooldownMs: number | null;
        consecutiveFailures: number;
        transitions: Record<string, number>;
        fastFails: number;
        probesStarted: number;
        probesSucceeded: number;
        probesFailed: number;
        lastTransitionAt: string | null;
        lastSnapshot: Record<string, any> | null;
    }>();

    private circuitEntry(domain: string) {
        let e = this.circuitStats.get(domain);
        if (!e) {
            e = {
                domain, state: 'CLOSED', openReason: null, cooldownMs: null,
                consecutiveFailures: 0, transitions: {}, fastFails: 0,
                probesStarted: 0, probesSucceeded: 0, probesFailed: 0,
                lastTransitionAt: null, lastSnapshot: null,
            };
            this.circuitStats.set(domain, e);
        }
        return e;
    }

    /** Transição de estado do breaker (CLOSED→OPEN, OPEN→HALF_OPEN, ...). */
    recordCircuitTransition(domain: string, from: string, to: string, reason: string, snapshot?: Record<string, any>): void {
        try {
            const e = this.circuitEntry(domain);
            const key = `${from}->${to}`;
            e.transitions[key] = (e.transitions[key] ?? 0) + 1;
            e.state = to;
            e.openReason = to === 'OPEN' ? reason : (to === 'CLOSED' ? null : e.openReason);
            e.lastTransitionAt = new Date().toISOString();
            if (snapshot) {
                e.lastSnapshot = snapshot;
                e.cooldownMs = snapshot.cooldownMs ?? e.cooldownMs;
                e.consecutiveFailures = snapshot.consecutiveFailures ?? e.consecutiveFailures;
            }
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordCircuitTransition() error (non-fatal): ${err?.message}`);
        }
    }

    /** Fast-fail por circuito aberto (nenhum slot/voo/retry consumido). */
    recordCircuitFastFail(domain: string): void {
        try {
            this.circuitEntry(domain).fastFails++;
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordCircuitFastFail() error (non-fatal): ${err?.message}`);
        }
    }

    /** Probe HALF_OPEN: iniciada / sucesso / falha. */
    recordCircuitProbe(domain: string, outcome: 'started' | 'success' | 'failure'): void {
        try {
            const e = this.circuitEntry(domain);
            if (outcome === 'started') e.probesStarted++;
            else if (outcome === 'success') e.probesSucceeded++;
            else e.probesFailed++;
        } catch (err: any) {
            this.logger.debug(`[METRICS] recordCircuitProbe() error (non-fatal): ${err?.message}`);
        }
    }

    getCircuitStats(): Record<string, any> {
        const byDomain: Record<string, any> = {};
        for (const [domain, e] of this.circuitStats) {
            byDomain[domain] = { ...e, transitions: { ...e.transitions } };
        }
        return { byDomain };
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

        // ── Escopo de instância ──────────────────────────────────────────────────
        // Regra crítica: SINGLE_INSTANCE_CONFIRMED exige evidência positiva verificável.
        // Ausência de variável não é evidência de instância única — resultado = UNKNOWN.
        // NODE_APP_INSTANCE presente → PM2 clustering → MULTI_INSTANCE.
        const instanceEnv = process.env.NODE_APP_INSTANCE ?? null;
        const instanceId = instanceEnv ?? process.env.REPL_ID ?? process.pid.toString();

        let scope: 'SINGLE_INSTANCE_CONFIRMED' | 'MULTI_INSTANCE' | 'UNKNOWN';
        let instanceCount: number | null;
        let scopeNote: string | undefined;

        if (instanceEnv !== null) {
            // NODE_APP_INSTANCE presente indica PM2/cluster com múltiplas réplicas possíveis.
            // O índice 0 não significa que não há instâncias 1, 2, …
            scope = 'MULTI_INSTANCE';
            instanceCount = null; // contagem total de réplicas não é determinável aqui
            scopeNote = 'Métricas parciais: apenas esta instância/processo. NODE_APP_INSTANCE presente indica cluster.';
        } else {
            // Sem evidência positiva de instância única — não inventar confirmação.
            scope = 'UNKNOWN';
            instanceCount = null;
            scopeNote = 'Escopo desconhecido: métricas representam apenas este processo. Sem evidência verificável de instância única.';
        }

        // ── Estatísticas agregadas do histórico de snapshots ─────────────────────
        const snaps = this.rateSnapshots;
        const snapCount = snaps.length;

        function snapStat(field: keyof typeof snaps[0]): { current: number | null; max: number | null; min: number | null } {
            if (snapCount === 0 || field === 'recordedAt') {
                return { current: null, max: null, min: null };
            }
            const values = snaps.map(s => s[field] as number);
            return {
                current: values[values.length - 1] ?? null,
                max: Math.max(...values),
                min: Math.min(...values),
            };
        }

        const rateLimitUsageStat = snapStat('usedInWindow');
        const rateLimitRemainingStat = snapStat('remainingInWindow');
        const queueHighStat = snapStat('queueSizeHigh');
        const queueLowStat = snapStat('queueSizeLow');

        return {
            generatedAt: new Date().toISOString(),
            dataSource: 'live' as const,
            measurementPeriodMs: Date.now() - this.startedAt,
            measurementScope: {
                instanceId,
                instanceCount,
                scope,
                ...(scopeNote ? { note: scopeNote } : {}),
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
                // Retrocompatibilidade: último snapshot observado (ponto-a-ponto)
                DOCTORALIA_RATE_LIMIT_USAGE: this.lastRateSnapshot?.usedInWindow ?? null,
                DOCTORALIA_RATE_LIMIT_REMAINING: this.lastRateSnapshot?.remainingInWindow ?? null,
                DOCTORALIA_QUEUE_SIZE_HIGH: this.lastRateSnapshot?.queueSizeHigh ?? null,
                DOCTORALIA_QUEUE_SIZE_LOW: this.lastRateSnapshot?.queueSizeLow ?? null,
                rateSnapshotRecordedAt: this.lastRateSnapshot
                    ? new Date(this.lastRateSnapshot.recordedAt).toISOString()
                    : null,
                // Estatísticas agregadas da janela de medição (baseadas no histórico circular)
                snapshotCount: snapCount,
                rateLimitUsage: rateLimitUsageStat,
                rateLimitRemaining: rateLimitRemainingStat,
                queueHigh: queueHighStat,
                queueLow: queueLowStat,
                // Task 170: pacing de grants LOW (esperas aplicadas quando a
                // ocupação da janela agregada ≥ threshold). Seção aditiva.
                lowPacing: this.getLowPacingStats(),
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
            // WP-05: GETs idênticos que se juntaram a um voo em andamento (não consumiram
            // slot WAF nem posição na fila). Seção aditiva — não altera métricas atuais.
            dedup: {
                DOCTORALIA_DEDUPED_GET_COUNT: this.dedupedGetCount,
            },
            // WP-08A: circuit breaker Doctoralia (estado por domain, transições,
            // fast-fails, probes). Seção aditiva.
            circuitBreaker: this.getCircuitStats(),
            // Budget WRITE (PUT/POST/PATCH/DELETE): limites oficiais Doctoralia.
            // Seção aditiva — não altera campos existentes; só presente quando o client
            // tiver emitido ao menos um snapshot com dados de WRITE.
            writeBudget: (() => {
                const snap = this.lastRateSnapshot;
                if (!snap || snap.writeUsedInMinute === undefined) return null;
                // Estatísticas do histórico circular (máx/mín/corrente por janela)
                const snapsWithWrite = this.rateSnapshots.filter(s => s.writeUsedInMinute !== undefined);
                const usedMinValues = snapsWithWrite.map(s => s.writeUsedInMinute!);
                const usedHourValues = snapsWithWrite.map(s => s.writeUsedInHour!);
                return {
                    limitPerMinute: 40,
                    limitPerHour: 2400,
                    current: {
                        usedInMinute: snap.writeUsedInMinute,
                        remainingInMinute: snap.writeRemainingInMinute ?? null,
                        usedInHour: snap.writeUsedInHour ?? null,
                        remainingInHour: snap.writeRemainingInHour ?? null,
                    },
                    historical: {
                        snapshotCount: snapsWithWrite.length,
                        usedInMinute: {
                            max: usedMinValues.length ? Math.max(...usedMinValues) : null,
                            min: usedMinValues.length ? Math.min(...usedMinValues) : null,
                        },
                        usedInHour: {
                            max: usedHourValues.length ? Math.max(...usedHourValues) : null,
                            min: usedHourValues.length ? Math.min(...usedHourValues) : null,
                        },
                    },
                };
            })(),
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
            // WP-02 P2c + WP-04: Guard de concorrência por clínica (todos os cruzamentos)
            concurrencyGuard: { ...this.concurrencySkipCounts },
            // WP-14: retries transitórios (WP-07) — seção aditiva, nada renomeado.
            retry: this.getTransientRetryStats(),
            // WP-14: backpressure da fila HIGH/LOW (WP-08B) — seção aditiva.
            backpressure: this.getQueueBackpressureStats(),
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
