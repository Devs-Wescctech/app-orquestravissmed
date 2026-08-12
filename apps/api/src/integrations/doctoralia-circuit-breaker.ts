/**
 * WP-08A — Circuit Breaker in-process do cliente Doctoralia.
 *
 * Chave: host normalizado (`domain`) — o rate limiter agregado, o IP de saída e
 * o WAF atuam sobre o tráfego agregado do host, então degradação 5xx/timeout/WAF
 * é degradação do host compartilhado, não de uma clínica. Com um único host em
 * produção (`www.doctoralia.com.br`), comporta-se como breaker global.
 *
 * Máquina de estados:
 *   CLOSED → (5 falhas transitórias consecutivas pós-retry-exhausted OU
 *             1 challenge/WAF 405+captcha imediato) → OPEN → cooldown →
 *   HALF_OPEN → 1 probe → sucesso=CLOSED / falha=OPEN (cooldown progressivo).
 *
 * Semântica de contagem: 1 incremento por OPERAÇÃO LÓGICA esgotada (nunca por
 * tentativa interna do WP-07); awaiters do voo WP-05 compartilham 1 incremento.
 * 400/401/403/404/409/422 e erros de negócio NÃO alimentam o breaker.
 *
 * Sem persistência entre restarts e sem breaker distribuído (out of scope).
 */
import { Logger } from '@nestjs/common';
import { classifyFailure } from './docplanner-retry.policy';
import { isDoctoraliaQueueError } from './doctoralia-queue.errors';
import { getDoctoraliaMetricsService } from '../metrics/doctoralia-metrics.service';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export const CIRCUIT_FAILURE_THRESHOLD = 5;
export const CIRCUIT_INITIAL_COOLDOWN_MS = 60_000;          // 1º OPEN: 60s
export const CIRCUIT_MAX_COOLDOWN_MS = 10 * 60_000;         // teto ~10min
export const CIRCUIT_WAF_MIN_COOLDOWN_MS = 5 * 60_000;      // WAF: mínimo 5min

/**
 * Erro tipado de fast-fail quando o circuito está aberto. Callers:
 * - polling/sweep: skip controlado do ciclo, SEM marcar integração error/disconnected;
 * - Global Sync: finaliza o run como skipped explícito;
 * - UI: mensagem amigável com estimativa de retorno;
 * - push/slot sync: exceção normal → hash/SlotPushState não avança.
 */
export class DoctoraliaCircuitOpenError extends Error {
    readonly domain: string;
    readonly reason: string;
    readonly cooldownRemainingMs: number;

    constructor(domain: string, reason: string, cooldownRemainingMs: number) {
        const secs = Math.max(0, Math.ceil(cooldownRemainingMs / 1000));
        super(
            `Doctoralia temporariamente indisponível (circuito aberto: ${reason}). ` +
            `Nova tentativa automática em ~${secs}s.`,
        );
        this.name = 'DoctoraliaCircuitOpenError';
        this.domain = domain;
        this.reason = reason;
        this.cooldownRemainingMs = cooldownRemainingMs;
    }
}

export function isDoctoraliaCircuitOpenError(err: any): err is DoctoraliaCircuitOpenError {
    return err instanceof DoctoraliaCircuitOpenError || err?.name === 'DoctoraliaCircuitOpenError';
}

/** Detecta challenge/WAF: 405 + página de captcha/challenge (inclusive fluxo OAuth). */
export function isWafChallenge(status: number | undefined, bodyOrDetails: string | undefined): boolean {
    if (status !== 405) return false;
    const text = bodyOrDetails ?? '';
    return /captcha|challenge|awswaf|human|verifica/i.test(text);
}

/** Gate devolvido por beginRequest — marca se esta operação é a probe do HALF_OPEN. */
export interface CircuitGate {
    isProbe: boolean;
}

export interface CircuitBreakerOptions {
    failureThreshold?: number;
    initialCooldownMs?: number;
    maxCooldownMs?: number;
    wafMinCooldownMs?: number;
    now?: () => number;
}

export interface CircuitSnapshot {
    domain: string;
    state: CircuitState;
    consecutiveFailures: number;
    openReason: string | null;
    cooldownMs: number;
    cooldownRemainingMs: number;
    fastFails: number;
    probesExecuted: number;
    probesSucceeded: number;
    probesFailed: number;
    transitions: Record<string, number>;
    lastTransitionAt: string | null;
}

export class DoctoraliaCircuitBreaker {
    private static registry = new Map<string, DoctoraliaCircuitBreaker>();
    private static logger = new Logger('DoctoraliaCircuitBreaker');

    /** Uma instância por host normalizado (sem protocolo). */
    static forDomain(domain: string, opts?: CircuitBreakerOptions): DoctoraliaCircuitBreaker {
        const key = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
        let breaker = this.registry.get(key);
        if (!breaker) {
            breaker = new DoctoraliaCircuitBreaker(key, opts);
            this.registry.set(key, breaker);
        }
        return breaker;
    }

    /** Snapshot de todos os circuitos (observabilidade). */
    static snapshotAll(): CircuitSnapshot[] {
        return [...this.registry.values()].map(b => b.snapshot());
    }

    /** Somente para testes: limpa registry e timers. */
    static resetAll(): void {
        for (const b of this.registry.values()) b.clearProbeTimer();
        this.registry.clear();
    }

    readonly domain: string;
    private state: CircuitState = 'CLOSED';
    private consecutiveFailures = 0;
    private cooldownMs: number;
    private openedUntil = 0;
    private openReason: string | null = null;
    private probeInFlight = false;
    private probeRunner: (() => Promise<any>) | null = null;
    private probeTimer: NodeJS.Timeout | null = null;

    // Contadores de observabilidade
    private fastFails = 0;
    private probesExecuted = 0;
    private probesSucceeded = 0;
    private probesFailed = 0;
    private transitions: Record<string, number> = {};
    private lastTransitionAt: number | null = null;

    private readonly failureThreshold: number;
    private readonly initialCooldownMs: number;
    private readonly maxCooldownMs: number;
    private readonly wafMinCooldownMs: number;
    private readonly now: () => number;

    constructor(domain: string, opts?: CircuitBreakerOptions) {
        this.domain = domain;
        this.failureThreshold = opts?.failureThreshold ?? CIRCUIT_FAILURE_THRESHOLD;
        this.initialCooldownMs = opts?.initialCooldownMs ?? CIRCUIT_INITIAL_COOLDOWN_MS;
        this.maxCooldownMs = opts?.maxCooldownMs ?? CIRCUIT_MAX_COOLDOWN_MS;
        this.wafMinCooldownMs = opts?.wafMinCooldownMs ?? CIRCUIT_WAF_MIN_COOLDOWN_MS;
        this.now = opts?.now ?? Date.now;
        this.cooldownMs = this.initialCooldownMs;
    }

    getState(): CircuitState {
        return this.state;
    }

    getConsecutiveFailures(): number {
        return this.consecutiveFailures;
    }

    /**
     * Registra o executor da probe de recuperação (`getFacilities()` da última
     * conexão válida). Se ausente, a primeira request elegível real atua como probe.
     */
    setProbeRunner(fn: () => Promise<any>): void {
        this.probeRunner = fn;
    }

    /**
     * Checagem na ENTRADA do método público do client — ANTES do voo WP-05, do
     * rate limiter e do retry WP-07. Lança DoctoraliaCircuitOpenError em OPEN
     * (dentro do cooldown) e em HALF_OPEN com probe já em andamento.
     */
    beginRequest(): CircuitGate {
        const now = this.now();
        if (this.state === 'OPEN') {
            if (now < this.openedUntil) {
                this.fastFail(now);
            }
            this.transition('HALF_OPEN', 'cooldown expirado');
        }
        if (this.state === 'HALF_OPEN') {
            if (this.probeInFlight) {
                this.fastFail(now);
            }
            this.probeInFlight = true;
            this.probesExecuted++;
            try { getDoctoraliaMetricsService()?.recordCircuitProbe(this.domain, 'started'); } catch (_e) { /* fail-safe */ }
            return { isProbe: true };
        }
        return { isProbe: false };
    }

    /** Sucesso da operação lógica: zera o contador; probe com sucesso fecha o circuito. */
    recordSuccess(gate: CircuitGate): void {
        this.consecutiveFailures = 0;
        if (gate.isProbe) {
            this.probeInFlight = false;
            this.probesSucceeded++;
            try { getDoctoraliaMetricsService()?.recordCircuitProbe(this.domain, 'success'); } catch (_e) { /* fail-safe */ }
            if (this.state === 'HALF_OPEN') {
                this.cooldownMs = this.initialCooldownMs;
                this.openReason = null;
                this.transition('CLOSED', 'probe com sucesso');
            }
        }
    }

    /**
     * Falha da operação lógica (pós-esgotamento WP-07 — chamado UMA vez por operação).
     * - WAF/challenge (405+captcha): abre imediatamente.
     * - Falha transitória (408/429/5xx/timeout/rede): incrementa; threshold abre.
     * - Não-transitória (400/401/403/404/409/422/negócio): NÃO alimenta o breaker.
     */
    recordFailure(err: any, gate: CircuitGate): void {
        // WP-08B (CRÍTICO): saturação interna de fila (QueueFull/QueueTimeout)
        // NUNCA alimenta o breaker — não incrementa falhas, não abre, não muda
        // estado. Se era a probe, apenas libera o probeInFlight (o host nem foi
        // consultado): a próxima request elegível volta a atuar como probe.
        if (isDoctoraliaQueueError(err)) {
            if (gate.isProbe) this.probeInFlight = false;
            return;
        }
        const waf = isWafChallenge(err?.status, err?.details ?? err?.message);
        if (waf) {
            this.settleProbe(gate, 'failure');
            this.open('WAF_CHALLENGE', true);
            return;
        }
        const transient = classifyFailure(err).transient;
        if (!transient) {
            // Erro definitivo do serviço (auth/negócio): o host respondeu — não conta
            // como degradação. Se era a probe, o host está de pé: fecha o circuito.
            if (gate.isProbe) {
                this.settleProbe(gate, 'success');
                if (this.state === 'HALF_OPEN') {
                    this.cooldownMs = this.initialCooldownMs;
                    this.openReason = null;
                    this.transition('CLOSED', 'probe respondida pelo serviço (erro não-transitório)');
                }
                this.consecutiveFailures = 0;
            }
            return;
        }
        if (gate.isProbe) {
            this.settleProbe(gate, 'failure');
            // Falha em HALF_OPEN: reabre com cooldown dobrado (progressivo até o teto).
            this.cooldownMs = Math.min(this.cooldownMs * 2, this.maxCooldownMs);
            this.open('PROBE_FAILED', false);
            return;
        }
        this.consecutiveFailures++;
        if (this.state === 'CLOSED' && this.consecutiveFailures >= this.failureThreshold) {
            this.open('CONSECUTIVE_TRANSIENT_FAILURES', false);
        }
    }

    /** Abertura imediata por challenge/WAF detectado fora do fluxo normal (ex.: OAuth). */
    tripWafChallenge(): void {
        this.open('WAF_CHALLENGE', true);
    }

    private settleProbe(gate: CircuitGate, outcome: 'success' | 'failure'): void {
        if (!gate.isProbe) return;
        this.probeInFlight = false;
        if (outcome === 'success') this.probesSucceeded++;
        else this.probesFailed++;
        try { getDoctoraliaMetricsService()?.recordCircuitProbe(this.domain, outcome); } catch (_e) { /* fail-safe */ }
    }

    private open(reason: string, isWaf: boolean): void {
        if (isWaf) {
            this.cooldownMs = Math.max(this.cooldownMs, this.wafMinCooldownMs);
        }
        this.openReason = reason;
        this.openedUntil = this.now() + this.cooldownMs;
        this.consecutiveFailures = 0;
        this.probeInFlight = false;
        this.transition('OPEN', reason);
        this.scheduleProbe();
    }

    /** Agenda a probe ativa (getFacilities) para o fim do cooldown, se registrada. */
    private scheduleProbe(): void {
        this.clearProbeTimer();
        if (!this.probeRunner) return;
        this.probeTimer = setTimeout(() => {
            this.probeTimer = null;
            if (this.state !== 'OPEN' || this.now() < this.openedUntil) return;
            const runner = this.probeRunner;
            if (!runner) return;
            // A probe passa pelo fluxo normal do client → beginRequest marca isProbe.
            runner().catch(() => { /* resultado tratado em recordSuccess/recordFailure */ });
        }, this.cooldownMs);
        // Não impede o processo de encerrar (e não interfere em testes).
        (this.probeTimer as any)?.unref?.();
    }

    private clearProbeTimer(): void {
        if (this.probeTimer) {
            clearTimeout(this.probeTimer);
            this.probeTimer = null;
        }
    }

    private fastFail(now: number): never {
        this.fastFails++;
        try { getDoctoraliaMetricsService()?.recordCircuitFastFail(this.domain); } catch (_e) { /* fail-safe */ }
        const remaining = Math.max(0, this.openedUntil - now);
        throw new DoctoraliaCircuitOpenError(
            this.domain,
            this.state === 'HALF_OPEN' ? 'probe de recuperação em andamento' : (this.openReason ?? 'degradação do serviço'),
            this.state === 'HALF_OPEN' ? 0 : remaining,
        );
    }

    private transition(to: CircuitState, reason: string): void {
        const from = this.state;
        if (from === to) return;
        this.state = to;
        this.lastTransitionAt = this.now();
        const key = `${from}->${to}`;
        this.transitions[key] = (this.transitions[key] ?? 0) + 1;
        // Alerta/log ÚNICO na transição — nunca por ciclo.
        const msg = `[CIRCUIT] ${this.domain}: ${key} (${reason})` +
            (to === 'OPEN' ? ` — cooldown ${Math.round(this.cooldownMs / 1000)}s, motivo=${this.openReason}` : '');
        if (to === 'OPEN') DoctoraliaCircuitBreaker.logger.warn(msg);
        else DoctoraliaCircuitBreaker.logger.log(msg);
        try {
            getDoctoraliaMetricsService()?.recordCircuitTransition(this.domain, from, to, reason, this.snapshot());
        } catch (_e) { /* fail-safe */ }
    }

    snapshot(): CircuitSnapshot {
        const now = this.now();
        return {
            domain: this.domain,
            state: this.state,
            consecutiveFailures: this.consecutiveFailures,
            openReason: this.openReason,
            cooldownMs: this.cooldownMs,
            cooldownRemainingMs: this.state === 'OPEN' ? Math.max(0, this.openedUntil - now) : 0,
            fastFails: this.fastFails,
            probesExecuted: this.probesExecuted,
            probesSucceeded: this.probesSucceeded,
            probesFailed: this.probesFailed,
            transitions: { ...this.transitions },
            lastTransitionAt: this.lastTransitionAt ? new Date(this.lastTransitionAt).toISOString() : null,
        };
    }
}
