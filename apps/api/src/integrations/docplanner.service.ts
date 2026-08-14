import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { getDoctoraliaMetricsService } from '../metrics/doctoralia-metrics.service';
import { getDoctoraliaContext } from '../metrics/doctoralia-call-context';
import { randomUUID } from 'crypto';
import { decideRetry, MAX_HTTP_ATTEMPTS } from './docplanner-retry.policy';
import { DoctoraliaCircuitBreaker, isWafChallenge } from './doctoralia-circuit-breaker';
import { DoctoraliaQueueFullError, DoctoraliaQueueTimeoutError } from './doctoralia-queue.errors';

/**
 * WP-08B — Waiter enriquecido da fila de vazão: além da classe do método e do
 * resolve, carrega reject (rejeição tipada), enqueuedAt (idade/espera), o timer
 * de deadline e a flag `settled` que resolve deterministicamente a corrida
 * grant × timeout (o primeiro vence; o outro é no-op).
 */
/**
 * Task 162 — Handle do grant de slot: identifica as reservas EXATAS gravadas
 * nas janelas (agregada e WRITE) para permitir devolução por identidade caso a
 * tentativa seja bloqueada pelo gate de retry antes do fetch.
 */
interface RateSlotGrant {
    aggTs: number;
    writeTs?: number;
}

interface RateWaiter {
    methodClass: 'GET' | 'WRITE';
    resolve: (grant: RateSlotGrant) => void;
    reject: (err: any) => void;
    enqueuedAt: number;
    deadlineTimer: ReturnType<typeof setTimeout> | null;
    settled: boolean;
}

/**
 * Task 162 — Estado compartilhado das tentativas HTTP de UMA operação lógica.
 * `breaker`/`gate` carregam o contexto de admissão até o ponto de dispatch para
 * o gate não-admissional de retry (WP-07 e repetição pós-401).
 */
interface RetryAttemptState {
    attempts: number;
    breaker?: DoctoraliaCircuitBreaker;
    gate?: { isProbe: boolean };
}

interface CachedToken {
    token: string;
    /** epoch ms após o qual o token não deve mais ser usado */
    expiresAt: number;
}

@Injectable()
export class DocplannerClient implements OnModuleDestroy {
    private readonly logger = new Logger(DocplannerClient.name);

    /**
     * Cache GLOBAL de tokens OAuth por (domínio + clientId), compartilhado entre todas as
     * instâncias do cliente. Sem isso, cada polling/sync/teste pedia um token novo
     * (~milhares de POSTs /oauth/v2/token por dia), o que o AWS WAF da Doctoralia pontua
     * como comportamento de robô abusivo e passa a responder com página de verificação
     * (405 + captcha). Um token vale ~1h; reutilizá-lo reduz a ~24 autenticações/dia.
     */
    private static tokenCache = new Map<string, CachedToken>();
    /**
     * Single-flight de autenticação por credencial (`domain|clientId`).
     * `fresh=true` indica que a promessa fará (ou já está fazendo) um POST OAuth
     * novo — só essas podem ser compartilhadas por forceRefresh/pós-401. Entradas
     * `fresh=false` ainda podem resolver via token persistido no banco.
     * A entrada é registrada SINCRONAMENTE no miss do cache (sem await entre o
     * miss e o set), fechando a janela de corrida que gerava POSTs duplicados.
     */
    private static inflightAuth = new Map<string, { promise: Promise<string>; fresh: boolean }>();

    /**
     * Limitador GLOBAL de vazão (todas as instâncias/conexões): o AWS WAF da Doctoralia
     * barra IPs fora do Brasil que excedem 500 requisições por janela de 5 minutos
     * (informado pelo suporte em 29/07/2026). Limitamos a 400/5min (margem de 20%),
     * enfileirando o excedente em vez de estourar a regra — o sync fica mais lento
     * nos picos, mas nunca dispara o bloqueio.
     */
    private static readonly RATE_LIMIT = 400;
    private static readonly RATE_WINDOW_MS = 5 * 60 * 1000;

    /**
     * Task 155 (WP-12C, correção mínima) — Headroom temporal ε no refill das
     * janelas deslizantes. A prova do WP-12C mostrou que, com a janela cheia,
     * o próximo grant era liberado no instante em que o evento mais antigo
     * completava EXATAMENTE a janela (zero headroom); o jitter de transporte
     * (p99=16ms, máx=44ms medido) comprimia a fronteira e as CHEGADAS no
     * destino caíam dentro de uma janela real <60s (42 WRITEs/59.995ms;
     * 401/299.961ms), mesmo com grants ≤ limite na semântica estrita.
     *
     * ε = 300ms: ~7× o jitter máximo medido (44ms), dentro do intervalo
     * recomendado pelo parecer (250–500ms); cobre também a divergência de
     * semântica inclusiva/estrita na fronteira e custa <1% de throughput.
     * Aplicado a TODAS as janelas (WRITE/min, WRITE/h, agregado/5min): cada
     * evento "ocupa" seu slot por janela+ε, então, com janela cheia, o próximo
     * grant só ocorre após `janela + ε` do evento mais antigo. Os BUDGETS
     * permanecem INTACTOS (40/min, 2.400/h, 400/5min).
     */
    private static readonly REFILL_HEADROOM_MS =
        DocplannerClient.resolveRefillHeadroom(process.env.DOCTORALIA_REFILL_HEADROOM_MS);

    /**
     * Resolve o ε a partir do override opcional, com CLAMP no intervalo seguro
     * [250, 500]ms do parecer WP-12C: valor inválido/ausente → 300ms (default);
     * 0/negativo nunca desabilita a proteção (mínimo 250ms); acima de 500ms
     * degradaria throughput sem ganho (máx 500ms).
     */
    private static resolveRefillHeadroom(raw: string | undefined): number {
        const parsed = Number.parseInt(raw ?? '', 10);
        if (!Number.isFinite(parsed)) return 300;
        return Math.min(500, Math.max(250, parsed));
    }
    /** Timestamps (epoch ms) das requisições feitas dentro da janela corrente. */
    private static rateTimestamps: number[] = [];
    private static lastThrottleLogAt = 0;

    /**
     * Limites oficiais para requisições WRITE (PUT/POST/PATCH/DELETE), conforme
     * informado pela Doctoralia: 40 writes/minuto e 2.400 writes/hora.
     * O teto agregado de 400/5min permanece intacto e aplicado a TODOS os métodos.
     * GETs são limitados apenas pela janela agregada (conservadora: ~4.800/h << 8.000/h oficial).
     */
    private static readonly WRITE_LIMIT_MIN = 40;
    private static readonly WRITE_WINDOW_MIN_MS = 60 * 1000;
    private static readonly WRITE_LIMIT_HOUR = 2400;
    private static readonly WRITE_WINDOW_HOUR_MS = 60 * 60 * 1000;
    /**
     * Timestamps de requisições WRITE: entradas são mantidas até WRITE_WINDOW_HOUR_MS.
     * Contagem de 1min é obtida filtrando em tempo real; contagem de 1h usa o array completo.
     */
    private static writeTimestamps: number[] = [];
    private static lastWriteThrottleLogAt = 0;

    /**
     * Duas filas de espera pela vazão: a prioritária (varredura de segurança e outras
     * operações pequenas/urgentes) passa na frente da normal (sync global em massa).
     * IMPORTANTE: isso apenas REORDENA quem usa cada slot — o teto continua sendo
     * exatamente RATE_LIMIT (400) requisições por janela de 5 minutos.
     * Cada item carrega a classe do método (GET ou WRITE) para que o pump possa
     * conceder slots a GETs enquanto a janela WRITE estiver cheia.
     */
    private static waitingHigh: RateWaiter[] = [];
    private static waitingLow: RateWaiter[] = [];
    private static pumping = false;

    /**
     * WP-08B — Backpressure explícito: caps de tamanho + deadlines de ESPERA NA
     * FILA (não substitui o timeout HTTP de 30s). Cap atingido ou deadline
     * expirado rejeitam com erro tipado, sem consumir rate slot e sem HTTP.
     */
    private static readonly QUEUE_CAP_HIGH = 50;
    private static readonly QUEUE_CAP_LOW =
        (Number.parseInt(process.env.DOCTORALIA_QUEUE_CAP_LOW ?? '', 10) > 0
            ? Number.parseInt(process.env.DOCTORALIA_QUEUE_CAP_LOW!, 10)
            : 100);
    private static readonly QUEUE_DEADLINE_HIGH_MS = 15_000;
    /**
     * Task 155: o deadline LOW precisa acomodar o refill com headroom ε — um
     * WRITE enfileirado logo após a janela/min encher só recebe slot após
     * `60s + ε` (60.300ms); com o deadline anterior de exatamente 60.000ms ele
     * expiraria e seria rejeitado ANTES do refill. Ajuste técnico indispensável
     * para o ε funcionar sem descartar writes legítimos: 60s + ε + 700ms de
     * margem de scheduling (≈61s). A semântica do deadline permanece a mesma.
     */
    private static readonly QUEUE_DEADLINE_LOW_MS =
        60_000 + DocplannerClient.REFILL_HEADROOM_MS + 700;
    /** Logs de rejeição rate-limited (fila saturada gera muitos eventos). */
    private static lastQueueRejectLogAt = 0;
    /** WP-08B — Shutdown: recusa novos waiters e impede callbacks pós-shutdown. */
    private static shuttingDown = false;
    /** Grants prioritários consecutivos (para a cota anti-inanição da fila normal). */
    private static consecutiveHighGrants = 0;

    /**
     * Wakeup para o pump quando ele está dormindo na espera do budget WRITE.
     * Quando um novo item é enfileirado (acquireRateSlot), chamamos este resolve
     * para que o pump reavalie elegibilidade imediatamente — essencial para que
     * um GET recém-chegado não fique preso atrás de um write bloqueado.
     */
    private static wakeupFn: (() => void) | null = null;

    /** Contexto assíncrono: marca chamadas feitas dentro de runWithPriority(). */
    private static priorityAls = new AsyncLocalStorage<boolean>();

    /**
     * Executa fn com prioridade na fila de vazão da Doctoralia. Não aumenta o
     * limite de requisições — só garante que estas poucas chamadas não fiquem
     * horas atrás das milhares do sync global.
     */
    static runWithPriority<T>(fn: () => Promise<T>): Promise<T> {
        return DocplannerClient.priorityAls.run(true, fn);
    }

    /**
     * Retorna o estado atual das janelas WRITE (sem modificar nada).
     * Evicta entradas expiradas como efeito colateral (necessário para contagens corretas).
     */
    private static snapshotWriteWindows(now: number): {
        writeUsedMin: number; writeRemainingMin: number;
        writeUsedHour: number; writeRemainingHour: number;
        writeFull: boolean;
    } {
        const wts = DocplannerClient.writeTimestamps;
        // Headroom ε: cada write ocupa a janela por janela+ε (ver REFILL_HEADROOM_MS).
        const cutoffHour = now - DocplannerClient.WRITE_WINDOW_HOUR_MS - DocplannerClient.REFILL_HEADROOM_MS;
        while (wts.length && wts[0] <= cutoffHour) wts.shift();
        const cutoffMin = now - DocplannerClient.WRITE_WINDOW_MIN_MS - DocplannerClient.REFILL_HEADROOM_MS;
        const writeUsedHour = wts.length;
        const writeUsedMin = wts.filter(t => t > cutoffMin).length;
        const writeRemainingMin = Math.max(0, DocplannerClient.WRITE_LIMIT_MIN - writeUsedMin);
        const writeRemainingHour = Math.max(0, DocplannerClient.WRITE_LIMIT_HOUR - writeUsedHour);
        const writeFull = writeUsedMin >= DocplannerClient.WRITE_LIMIT_MIN
            || writeUsedHour >= DocplannerClient.WRITE_LIMIT_HOUR;
        return { writeUsedMin, writeRemainingMin, writeUsedHour, writeRemainingHour, writeFull };
    }

    /**
     * Encontra o índice do primeiro item elegível na fila.
     * Se writeFull=true, somente GETs são elegíveis (writes precisam esperar).
     * Retorna -1 se nenhum item elegível existe.
     */
    private static findEligible(
        queue: RateWaiter[],
        writeFull: boolean,
    ): number {
        for (let i = 0; i < queue.length; i++) {
            // WP-08B: waiters expirados (settled) nunca são elegíveis nem concedidos.
            if (queue[i].settled) continue;
            if (!writeFull || queue[i].methodClass === 'GET') return i;
        }
        return -1;
    }

    private static async pumpRateQueue(logger: Logger): Promise<void> {
        if (DocplannerClient.pumping) return;
        DocplannerClient.pumping = true;
        try {
            while (DocplannerClient.waitingHigh.length || DocplannerClient.waitingLow.length) {
                let reservedAggTs = 0;
                for (;;) {
                    // WP-08B: shutdown drena as filas e acorda o pump — nenhum
                    // grant nem timer novo pode acontecer depois disso.
                    if (DocplannerClient.shuttingDown) return;
                    const now = Date.now();

                    // ── Janela agregada ─────────────────────────────────────
                    // Headroom ε: eviction só após janela+ε (ver REFILL_HEADROOM_MS).
                    const cutoff = now - DocplannerClient.RATE_WINDOW_MS - DocplannerClient.REFILL_HEADROOM_MS;
                    const ts = DocplannerClient.rateTimestamps;
                    while (ts.length && ts[0] <= cutoff) ts.shift();
                    const aggFull = ts.length >= DocplannerClient.RATE_LIMIT;

                    // ── Janelas WRITE ───────────────────────────────────────
                    const wSnap = DocplannerClient.snapshotWriteWindows(now);

                    // ── Elegibilidade ───────────────────────────────────────
                    const eligHighIdx = DocplannerClient.findEligible(DocplannerClient.waitingHigh, wSnap.writeFull);
                    const eligLowIdx = DocplannerClient.findEligible(DocplannerClient.waitingLow, wSnap.writeFull);
                    const anyEligible = eligHighIdx >= 0 || eligLowIdx >= 0;

                    if (aggFull) {
                        // Todos aguardam a janela agregada
                        const waitMs = Math.max(ts[0] + DocplannerClient.RATE_WINDOW_MS + DocplannerClient.REFILL_HEADROOM_MS - now, 250);
                        if (now - DocplannerClient.lastThrottleLogAt > 30_000) {
                            DocplannerClient.lastThrottleLogAt = now;
                            logger.warn(
                                `[RATE-LIMIT] Janela de ${DocplannerClient.RATE_LIMIT} req/5min cheia — segurando ` +
                                `requisições por ~${Math.ceil(waitMs / 1000)}s para não disparar o WAF da Doctoralia ` +
                                `(fila: ${DocplannerClient.waitingHigh.length} prioritária(s), ${DocplannerClient.waitingLow.length} normal(is)).`,
                            );
                        }
                        // WP-08B: espera cancelável — o shutdown aciona o wakeup
                        // para que o pump não fique dormindo até 5min com o
                        // processo encerrando; o timer perdedor é sempre cancelado.
                        let aggTimerId: ReturnType<typeof setTimeout> | undefined;
                        const aggTimer = new Promise<void>(r => {
                            aggTimerId = setTimeout(r, waitMs);
                            (aggTimerId as any)?.unref?.();
                        });
                        const aggWakeup = new Promise<void>(r => { DocplannerClient.wakeupFn = r; });
                        await Promise.race([aggTimer, aggWakeup]);
                        clearTimeout(aggTimerId);
                        DocplannerClient.wakeupFn = null;
                        continue;
                    }

                    if (!anyEligible) {
                        // Janela agregada tem espaço, mas só há writes e a janela WRITE está cheia.
                        // IMPORTANTE: usamos Promise.race com um wakeup para que um GET recém-chegado
                        // acorde o pump imediatamente — sem isso, o GET ficaria preso na fila enquanto
                        // o pump dorme esperando o budget WRITE liberar (potencialmente por 1h).
                        const wts = DocplannerClient.writeTimestamps;
                        // Headroom ε: o refill só ocorre janela+ε após o evento mais antigo.
                        const eps = DocplannerClient.REFILL_HEADROOM_MS;
                        const cutoffMin = now - DocplannerClient.WRITE_WINDOW_MIN_MS - eps;
                        const firstInMin = wts.find(t => t > cutoffMin);
                        const waitMin = wSnap.writeUsedMin >= DocplannerClient.WRITE_LIMIT_MIN && firstInMin !== undefined
                            ? Math.max(firstInMin + DocplannerClient.WRITE_WINDOW_MIN_MS + eps - now, 50)
                            : Infinity;
                        const waitHour = wSnap.writeUsedHour >= DocplannerClient.WRITE_LIMIT_HOUR && wts.length > 0
                            ? Math.max(wts[0] + DocplannerClient.WRITE_WINDOW_HOUR_MS + eps - now, 50)
                            : Infinity;
                        const naturalWaitMs = Math.min(waitMin, waitHour);
                        if (now - DocplannerClient.lastWriteThrottleLogAt > 30_000) {
                            DocplannerClient.lastWriteThrottleLogAt = now;
                            logger.warn(
                                `[RATE-LIMIT-WRITE] Janela WRITE cheia (${wSnap.writeUsedMin}/${DocplannerClient.WRITE_LIMIT_MIN}/min, ` +
                                `${wSnap.writeUsedHour}/${DocplannerClient.WRITE_LIMIT_HOUR}/h) — segurando writes por ` +
                                `~${Math.ceil(Math.min(naturalWaitMs, 9_999_999) / 1000)}s ` +
                                `(fila: ${DocplannerClient.waitingHigh.length} prioritária(s), ${DocplannerClient.waitingLow.length} normal(is)).`,
                            );
                        }
                        // Wakeup imediato quando um novo item (ex.: GET) é enfileirado.
                        // IMPORTANTE: o timer perdedor é sempre cancelado — sem isso,
                        // cada GET que acorda o pump deixaria um setTimeout vivo por até
                        // 1h (budget/hora), causando leak de recursos e open handles no Jest.
                        const sleepMs = naturalWaitMs === Infinity ? 250 : naturalWaitMs;
                        let timerId: ReturnType<typeof setTimeout> | undefined;
                        const timerPromise = new Promise<void>(r => {
                            timerId = setTimeout(r, sleepMs);
                            (timerId as any)?.unref?.();
                        });
                        const wakeup = new Promise<void>(r => { DocplannerClient.wakeupFn = r; });
                        await Promise.race([timerPromise, wakeup]);
                        clearTimeout(timerId); // cancela o timer se o wakeup venceu (e vice-versa — no-op se timer venceu)
                        DocplannerClient.wakeupFn = null;
                        continue;
                    }

                    // Reserva slot agregado (timestamp exato guardado para o grant)
                    reservedAggTs = now;
                    ts.push(now);
                    break;
                }

                // Anti-inanição: a cada 4 slots prioritários seguidos, cede 1 à fila normal.
                // Recomputa elegibilidade (write window pode ter mudado após a espera acima).
                const now2 = Date.now();
                const wSnap2 = DocplannerClient.snapshotWriteWindows(now2);
                const eligHighIdx2 = DocplannerClient.findEligible(DocplannerClient.waitingHigh, wSnap2.writeFull);
                const eligLowIdx2 = DocplannerClient.findEligible(DocplannerClient.waitingLow, wSnap2.writeFull);

                let next: RateWaiter | undefined;
                if (
                    eligLowIdx2 >= 0 &&
                    (DocplannerClient.consecutiveHighGrants >= 4 || eligHighIdx2 < 0)
                ) {
                    next = DocplannerClient.waitingLow.splice(eligLowIdx2, 1)[0];
                    DocplannerClient.consecutiveHighGrants = 0;
                } else if (eligHighIdx2 >= 0) {
                    next = DocplannerClient.waitingHigh.splice(eligHighIdx2, 1)[0];
                    DocplannerClient.consecutiveHighGrants++;
                }

                // WP-08B: corrida grant × timeout — se o waiter expirou entre a
                // seleção e o grant, ele NÃO é concedido e o slot é devolvido.
                if (next && !next.settled) {
                    next.settled = true;
                    if (next.deadlineTimer) {
                        clearTimeout(next.deadlineTimer);
                        next.deadlineTimer = null;
                    }
                    // Registra no budget WRITE se for uma mutação
                    const grant: RateSlotGrant = { aggTs: reservedAggTs };
                    if (next.methodClass === 'WRITE') {
                        DocplannerClient.writeTimestamps.push(now2);
                        grant.writeTs = now2;
                    }
                    next.resolve(grant);
                    DocplannerClient.reportQueueDepth();
                } else {
                    // Slot reservado sem candidato elegível (corrida rara): devolve
                    // a reserva EXATA feita acima (identidade, não posição).
                    const i = DocplannerClient.rateTimestamps.indexOf(reservedAggTs);
                    if (i >= 0) DocplannerClient.rateTimestamps.splice(i, 1);
                }
            }
        } finally {
            DocplannerClient.pumping = false;
        }
    }

    /** WP-08B: publica profundidade/idade das filas nas métricas (fail-safe). */
    private static reportQueueDepth(): void {
        try {
            const metrics = getDoctoraliaMetricsService();
            if (!metrics) return;
            const now = Date.now();
            const oldest = (q: RateWaiter[]) => (q.length ? Math.max(0, now - q[0].enqueuedAt) : 0);
            metrics.recordQueueDepth(
                DocplannerClient.waitingHigh.length,
                DocplannerClient.waitingLow.length,
                oldest(DocplannerClient.waitingHigh),
                oldest(DocplannerClient.waitingLow),
            );
        } catch (_e) { /* fail-safe */ }
    }

    /**
     * WP-08B — Shutdown limpo do coordinator: recusa novos waiters, cancela
     * todos os timers de deadline, rejeita waiters pendentes e limpa o wakeupFn.
     * Nenhuma Promise fica pendurada e nenhum callback roda pós-shutdown.
     */
    static shutdownRateQueue(): void {
        DocplannerClient.shuttingDown = true;
        const drain = (queue: RateWaiter[], priority: 'HIGH' | 'LOW') => {
            for (const w of queue.splice(0, queue.length)) {
                if (w.settled) continue;
                w.settled = true;
                if (w.deadlineTimer) {
                    clearTimeout(w.deadlineTimer);
                    w.deadlineTimer = null;
                }
                try {
                    w.reject(new DoctoraliaQueueTimeoutError(
                        priority, 0, Date.now() - w.enqueuedAt, 0,
                    ));
                } catch (_e) { /* fail-safe */ }
            }
        };
        drain(DocplannerClient.waitingHigh, 'HIGH');
        drain(DocplannerClient.waitingLow, 'LOW');
        // Acorda o pump (se dormindo) para que ele veja as filas vazias e encerre.
        const wake = DocplannerClient.wakeupFn;
        DocplannerClient.wakeupFn = null;
        wake?.();
    }

    onModuleDestroy(): void {
        DocplannerClient.shutdownRateQueue();
    }

    /**
     * Aguarda (se necessário) até haver espaço nas janelas de vazão e registra a requisição.
     * WP-08B: aplica cap por fila (rejeição ANTES do push) e deadline de espera
     * por waiter — ambos rejeitam com erro tipado sem consumir rate slot.
     */
    private static acquireRateSlot(logger: Logger, methodClass: 'GET' | 'WRITE'): Promise<RateSlotGrant> {
        const priority = DocplannerClient.priorityAls.getStore() === true;
        const prLabel: 'HIGH' | 'LOW' = priority ? 'HIGH' : 'LOW';
        const queue = priority ? DocplannerClient.waitingHigh : DocplannerClient.waitingLow;

        if (DocplannerClient.shuttingDown) {
            return Promise.reject(new DoctoraliaQueueTimeoutError(prLabel, queue.length, 0, 0));
        }

        const cap = priority ? DocplannerClient.QUEUE_CAP_HIGH : DocplannerClient.QUEUE_CAP_LOW;
        if (queue.length >= cap) {
            try { getDoctoraliaMetricsService()?.recordQueueRejectedFull(prLabel, queue.length); } catch (_e) { /* fail-safe */ }
            const now = Date.now();
            if (now - DocplannerClient.lastQueueRejectLogAt > 30_000) {
                DocplannerClient.lastQueueRejectLogAt = now;
                logger.warn(
                    `[QUEUE-FULL] Fila ${prLabel} da Doctoralia cheia (${queue.length}/${cap}) — ` +
                    `rejeitando novas requisições sem consumir rate slot (log limitado a 1/30s).`,
                );
            }
            return Promise.reject(new DoctoraliaQueueFullError(prLabel, queue.length));
        }

        const deadlineMs = priority
            ? DocplannerClient.QUEUE_DEADLINE_HIGH_MS
            : DocplannerClient.QUEUE_DEADLINE_LOW_MS;

        return new Promise<RateSlotGrant>((resolve, reject) => {
            const waiter: RateWaiter = {
                methodClass,
                enqueuedAt: Date.now(),
                deadlineTimer: null,
                settled: false,
                reject,
                resolve: (grant: RateSlotGrant) => {
                    // Emite snapshot de fila sem alterar o algoritmo
                    try {
                        const metrics = getDoctoraliaMetricsService();
                        if (metrics) {
                            const now = Date.now();
                            const cutoffAgg = now - DocplannerClient.RATE_WINDOW_MS - DocplannerClient.REFILL_HEADROOM_MS;
                            const ts = DocplannerClient.rateTimestamps;
                            const used = ts.filter(t => t > cutoffAgg).length;
                            const remaining = DocplannerClient.RATE_LIMIT - used;
                            const wSnap = DocplannerClient.snapshotWriteWindows(now);
                            metrics.recordRateSnapshot({
                                usedInWindow: used,
                                remainingInWindow: remaining,
                                queueSizeHigh: DocplannerClient.waitingHigh.length,
                                queueSizeLow: DocplannerClient.waitingLow.length,
                                writeUsedInMinute: wSnap.writeUsedMin,
                                writeRemainingInMinute: wSnap.writeRemainingMin,
                                writeUsedInHour: wSnap.writeUsedHour,
                                writeRemainingInHour: wSnap.writeRemainingHour,
                            });
                            // WP-08B: espera efetiva na fila (média/p95 por prioridade)
                            metrics.recordQueueWait(prLabel, now - waiter.enqueuedAt);
                        }
                    } catch (_e) { /* fail-safe */ }
                    resolve(grant);
                },
            };

            // Deadline de ESPERA NA FILA: ao expirar, remove o waiter, rejeita a
            // Promise com erro tipado e NÃO consome rate slot nem executa HTTP.
            waiter.deadlineTimer = setTimeout(() => {
                if (waiter.settled) return; // grant venceu a corrida — no-op
                waiter.settled = true;
                waiter.deadlineTimer = null;
                const q = priority ? DocplannerClient.waitingHigh : DocplannerClient.waitingLow;
                const idx = q.indexOf(waiter);
                if (idx >= 0) q.splice(idx, 1);
                const waitMs = Date.now() - waiter.enqueuedAt;
                try { getDoctoraliaMetricsService()?.recordQueueExpired(prLabel, waitMs); } catch (_e) { /* fail-safe */ }
                const now = Date.now();
                if (now - DocplannerClient.lastQueueRejectLogAt > 30_000) {
                    DocplannerClient.lastQueueRejectLogAt = now;
                    logger.warn(
                        `[QUEUE-TIMEOUT] Waiter ${prLabel} expirou após ${Math.round(waitMs / 1000)}s na fila ` +
                        `(deadline ${Math.round(deadlineMs / 1000)}s) — rejeitando sem consumir rate slot (log limitado a 1/30s).`,
                    );
                }
                DocplannerClient.reportQueueDepth();
                reject(new DoctoraliaQueueTimeoutError(prLabel, q.length, waitMs, deadlineMs));
            }, deadlineMs);
            (waiter.deadlineTimer as any)?.unref?.();

            queue.push(waiter);
            DocplannerClient.reportQueueDepth();
            // Acorda o pump se ele estiver dormindo na espera do budget WRITE
            // (ex.: pump bloqueado por write-full mas acabou de chegar um GET elegível).
            DocplannerClient.wakeupFn?.();
            void DocplannerClient.pumpRateQueue(logger);
        });
    }

    private accessToken: string;
    private baseUrl: string;
    private authPromise: Promise<string> | null = null;
    private clientId: string | null = null;
    private clientSecret: string | null = null;
    /** Persistência opcional do token (banco), para sobreviver a restarts do container. */
    private persistLoad: (() => Promise<CachedToken | null>) | null = null;
    private persistSave: ((t: CachedToken) => Promise<void>) | null = null;

    constructor(private configService: ConfigService) {}

    setPersistence(load: () => Promise<CachedToken | null>, save: (t: CachedToken) => Promise<void>) {
        this.persistLoad = load;
        this.persistSave = save;
    }

    setAccessToken(token: string) {
        this.accessToken = token;
    }

    setBaseUrl(url: string) {
        let u = url.replace(/\/$/, '');
        // Normaliza domínios Doctoralia/ZnanyLekarz sem "www": a Doctoralia passou a
        // responder 301 no domínio raiz, e o redirect converte o POST de autenticação
        // em GET (→ 405 com página de verificação do WAF). Sempre usar o host www.
        u = u.replace(/^(https?:\/\/)?(doctoralia\.[a-z.]+|znanylekarz\.pl)$/i, (_m, proto, host) => `${proto || ''}www.${host}`);
        this.baseUrl = u;
    }

    private getBaseUrl(): string {
        return this.baseUrl || 'https://www.doctoralia.com.br';
    }

    /**
     * WP-06: identidade estável `domain|clientId` desta conexão, usada como prefixo
     * das chaves do StableDataCache. Acessor de leitura — não altera comportamento.
     */
    getCacheIdentity(): string {
        return `${this.getBaseUrl().replace(/^https?:\/\//, '')}|${this.clientId ?? ''}`;
    }

    async authenticate(clientId: string, clientSecret: string): Promise<string> {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        // WP-08A: registra esta conexão como executora da probe de recuperação
        // (getFacilities — leitura pura, payload pequeno, sem efeito colateral).
        // Se nenhuma conexão registrar, a primeira request real após o cooldown
        // atua como probe (fallback).
        this.getCircuitBreaker().setProbeRunner(() => this.getFacilities());
        this.authPromise = this.getToken(false);
        return this.authPromise;
    }

    /**
     * Força a obtenção de um token NOVO (ignora memória e banco). Usado pelo renovador
     * em segundo plano quando o token atual está perto de expirar — sem forçar, o
     * getToken(false) devolveria o token ainda-válido e a renovação nunca aconteceria.
     */
    async forceTokenRefresh(clientId: string, clientSecret: string): Promise<string> {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.authPromise = this.getToken(true);
        return this.authPromise;
    }

    /** Obtém um token: do cache global se ainda válido; senão autentica (com dedupe de chamadas concorrentes). */
    private async getToken(forceRefresh: boolean): Promise<string> {
        const domain = this.getBaseUrl().replace(/^https?:\/\//, '');
        const cacheKey = `${domain}|${this.clientId}`;

        if (!forceRefresh) {
            const cached = DocplannerClient.tokenCache.get(cacheKey);
            if (cached && cached.expiresAt > Date.now()) {
                this.accessToken = cached.token;
                return cached.token;
            }
            // Dedupe: se já há autenticação em andamento para esta credencial,
            // aguarda-a — verificado ANTES de qualquer await (sem janela de corrida).
            const existing = DocplannerClient.inflightAuth.get(cacheKey);
            if (existing) {
                const token = await existing.promise;
                this.accessToken = token;
                return token;
            }
            // Registro SÍNCRONO do single-flight: nenhum await entre o miss do cache
            // e o set da promessa compartilhada. O carregamento do token persistido
            // (banco) acontece DENTRO da promessa — quem chegar durante esse await
            // adere à mesma promessa em vez de disparar outro POST OAuth.
            const entry: { promise: Promise<string>; fresh: boolean } = { promise: null as any, fresh: false };
            entry.promise = (async () => {
                // Memória vazia (ex.: restart do container): tenta o token persistido no banco.
                if (this.persistLoad) {
                    try {
                        const persisted = await this.persistLoad();
                        if (persisted && persisted.expiresAt > Date.now()) {
                            DocplannerClient.tokenCache.set(cacheKey, persisted);
                            this.logger.log(`Token OAuth recuperado do banco para ${cacheKey.split('|')[0]} (válido por ~${Math.round((persisted.expiresAt - Date.now()) / 60000)}min).`);
                            return persisted.token;
                        }
                    } catch (err: any) {
                        this.logger.warn(`Falha ao ler token persistido: ${err?.message}`);
                    }
                }
                entry.fresh = true; // a partir daqui é um POST OAuth de verdade
                return this.fetchNewToken(domain, cacheKey);
            })().finally(() => {
                DocplannerClient.inflightAuth.delete(cacheKey);
            });
            DocplannerClient.inflightAuth.set(cacheKey, entry);
            const token = await entry.promise;
            this.accessToken = token;
            return token;
        }

        // forceRefresh: precisa de um token NOVO. Compartilha um in-flight existente
        // apenas se ele for "fresh" (já vai fazer POST OAuth); se for um carregamento
        // do token persistido (potencialmente o token velho que causou o 401), espera
        // terminar e tenta de novo — sem nunca disparar dois POSTs em paralelo.
        DocplannerClient.tokenCache.delete(cacheKey);
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const existing = DocplannerClient.inflightAuth.get(cacheKey);
            if (!existing) {
                const entry: { promise: Promise<string>; fresh: boolean } = { promise: null as any, fresh: true };
                entry.promise = this.fetchNewToken(domain, cacheKey).finally(() => {
                    DocplannerClient.inflightAuth.delete(cacheKey);
                });
                DocplannerClient.inflightAuth.set(cacheKey, entry);
                const token = await entry.promise;
                this.accessToken = token;
                return token;
            }
            if (existing.fresh) {
                // Dois forceRefresh/401 simultâneos compartilham o MESMO refresh.
                const token = await existing.promise;
                this.accessToken = token;
                return token;
            }
            // In-flight não-fresh (pode resolver com token persistido/stale): espera
            // terminar (sucesso ou erro) e reavalia. Cada iteração consome um in-flight
            // concluído, então o laço termina — sem deadlock.
            await existing.promise.catch(() => { /* erro tratado pelo dono da promessa */ });
            DocplannerClient.tokenCache.delete(cacheKey);
        }
    }

    /** IP público de saída no instante da chamada (cache de 5min; falha vira "desconhecido"). */
    private static egressIpCache: { ip: string; at: number } | null = null;
    private async getEgressIp(): Promise<string> {
        const c = DocplannerClient.egressIpCache;
        if (c && Date.now() - c.at < 5 * 60 * 1000) return c.ip;
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 5000);
            const res = await fetch('https://api.ipify.org', { signal: ctrl.signal });
            clearTimeout(t);
            const ip = (await res.text()).trim();
            DocplannerClient.egressIpCache = { ip, at: Date.now() };
            return ip;
        } catch {
            return 'desconhecido';
        }
    }

    private async fetchNewToken(domain: string, cacheKey: string): Promise<string> {
        const url = `https://${domain}/oauth/v2/token`;
        const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

        // WP-12C: correlação API↔mock no harness (inerte fora do harness).
        const _oauthCorrelationId = randomUUID();
        const _oauthSendCorrelation = process.env.LOADTEST_CORRELATION_HEADER === 'true';
        const _oauthEnqueuedAt = Date.now();
        await DocplannerClient.acquireRateSlot(this.logger, 'WRITE');
        const _oauthReleasedAt = Date.now();
        const _oauthSentAt = Date.now();
        // WP-01: httpStatus default para NETWORK; será sobrescrito se fetch retornar
        let _oauthHttpStatus: number | 'TIMEOUT' | 'NETWORK' | 'OTHER' = 'NETWORK';
        let response: Awaited<ReturnType<typeof fetch>> | undefined;
        // WP-07: timeout de 30s no OAuth, consistente com o timeout HTTP do client.
        const oauthController = new AbortController();
        const oauthTimeout = setTimeout(() => oauthController.abort(), 30000);
        try {
            response = await fetch(url, {
                method: 'POST',
                signal: oauthController.signal,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${basicAuth}`,
                    // O fetch do Node não envia User-Agent; o WAF da Doctoralia pontua
                    // requisições sem identificação como robô suspeito.
                    'User-Agent': 'Orquestrador/1.0 (VisMed integration)',
                    ...(_oauthSendCorrelation ? { 'x-loadtest-correlation-id': _oauthCorrelationId } : {}),
                },
                body: 'grant_type=client_credentials&scope=integration',
            });
            _oauthHttpStatus = response.status;
        } catch (fetchErr: any) {
            _oauthHttpStatus = fetchErr?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
            throw fetchErr;
        } finally {
            clearTimeout(oauthTimeout);
            // WP-01: registra chamada OAuth em finally — cobre sucesso, HTTP error E network failure
            const _oauthRespondedAt = Date.now();
            try {
                const metrics = getDoctoraliaMetricsService();
                if (metrics) {
                    metrics.record({
                        doctoraliaRequestId: _oauthCorrelationId,
                        origin: 'AUTHENTICATION',
                        operation: 'OAUTH_TOKEN',
                        endpoint: '/oauth/v2/token',
                        method: 'POST',
                        httpStatus: _oauthHttpStatus,
                        isRetry: false,
                        retryNumber: 0,
                        isOAuth: true,
                        enqueuedAt: _oauthEnqueuedAt,
                        releasedAt: _oauthReleasedAt,
                        sentAt: _oauthSentAt,
                        respondedAt: _oauthRespondedAt,
                        waitMs: _oauthReleasedAt - _oauthEnqueuedAt,
                        execMs: _oauthRespondedAt - _oauthSentAt,
                    });
                }
            } catch (_e) { /* fail-safe: metrics never propagate */ }
        }

        if (!response!.ok) {
            const errorText = await response.text();
            // Diagnóstico forense do bloqueio WAF: registra cabeçalhos da resposta,
            // content-type e o IP público de saída NO INSTANTE da falha, para
            // comparação entre execuções que funcionam e que falham.
            const diag = [
                `content-type=${response.headers.get('content-type')}`,
                `server=${response.headers.get('server')}`,
                `via=${response.headers.get('via')}`,
                `x-amzn-waf-action=${response.headers.get('x-amzn-waf-action')}`,
                `x-amzn-requestid=${response.headers.get('x-amzn-requestid')}`,
                `x-amz-cf-id=${response.headers.get('x-amz-cf-id')}`,
                `x-amz-cf-pop=${response.headers.get('x-amz-cf-pop')}`,
                `x-cache=${response.headers.get('x-cache')}`,
            ].join(' | ');
            const egressIp = await this.getEgressIp();
            this.logger.error(
                `[AUTH-DIAG] Falha OAuth ${response.status} em ${url} | ip_saida=${egressIp} | ${diag} | corpo(200c)=${errorText.slice(0, 200).replace(/\s+/g, ' ')}`,
            );
            // WP-08A: challenge/WAF no fluxo OAuth (405 + página de captcha) abre o
            // circuito do host IMEDIATAMENTE, sem esperar threshold.
            if (isWafChallenge(response.status, errorText)) {
                try {
                    DoctoraliaCircuitBreaker.forDomain(domain).tripWafChallenge();
                } catch (_e) { /* fail-safe */ }
            }
            throw new Error(`Failed to authenticate with Docplanner: ${response.status} ${errorText}`);
        }

        this.logger.log(`[AUTH-DIAG] OAuth OK em ${url} | ip_saida=${await this.getEgressIp()}`);

        const data = await response.json() as any;
        // expires_in em segundos (padrão OAuth); margem de 60s para não usar token na iminência
        // de expirar. Fallback conservador de 50min se o campo não vier.
        const ttlMs = (typeof data.expires_in === 'number' && data.expires_in > 120)
            ? (data.expires_in - 60) * 1000
            : 50 * 60 * 1000;
        const entry: CachedToken = { token: data.access_token, expiresAt: Date.now() + ttlMs };
        DocplannerClient.tokenCache.set(cacheKey, entry);
        this.logger.log(`Novo token OAuth obtido para ${cacheKey.split('|')[0]} (válido por ~${Math.round(ttlMs / 60000)}min).`);
        if (this.persistSave) {
            this.persistSave(entry).catch(err => this.logger.warn(`Falha ao persistir token: ${err?.message}`));
        }
        return data.access_token;
    }

    /**
     * WP-05: Deduplicação de GETs idênticos in-flight (mesmo padrão do inflightAuth).
     * Mapa GLOBAL (static) porque DocplannerService.createClient() cria uma instância
     * nova por uso. Chave: domain|clientId|method|path (path inclui a query completa).
     * NÃO é cache: a entrada sai do mapa em finally — sucesso OU erro — e a próxima
     * chamada após conclusão faz requisição nova. Erros jamais ficam armazenados.
     */
    private static inflightGets = new Map<string, Promise<any>>();

    /**
     * Cada awaiter recebe cópia independente do resultado, para que a mutação local
     * de um consumidor não afete o outro. structuredClone é nativo do Node ≥17
     * (sem dependência nova); fallback JSON para o improvável caso não-clonável.
     */
    private static cloneResult(result: any): any {
        if (result === null || result === undefined || typeof result !== 'object') return result;
        try {
            return structuredClone(result);
        } catch {
            return JSON.parse(JSON.stringify(result));
        }
    }

    /** WP-08A: breaker chaveado pelo host normalizado desta conexão. */
    private getCircuitBreaker(): DoctoraliaCircuitBreaker {
        return DoctoraliaCircuitBreaker.forDomain(this.getBaseUrl().replace(/^https?:\/\//, ''));
    }

    /**
     * WP-08A: envolve a operação lógica (voo WP-05 completo, com retries WP-07
     * dentro) na contabilidade do breaker: 1 sucesso ou 1 falha por operação —
     * nunca por tentativa interna. Awaiters do dedup compartilham o resultado.
     */
    private async executeWithBreaker(
        breaker: DoctoraliaCircuitBreaker,
        gate: { isProbe: boolean },
        method: string,
        path: string,
        data?: any,
    ): Promise<any> {
        try {
            const result = await this.executeWithRetry(method, path, data, breaker, gate);
            breaker.recordSuccess(gate);
            return result;
        } catch (err: any) {
            breaker.recordFailure(err, gate);
            throw err;
        }
    }

    private async request(method: string, path: string, data?: any, isRetry = false): Promise<any> {
        const breaker = this.getCircuitBreaker();
        // WP-05: dedup APENAS para GET, excluindo GET_NOTIFICATIONS (stream consumível).
        // Mutações (POST/PUT/PATCH/DELETE) e OAuth ficam explicitamente fora.
        // O join acontece AQUI, ANTES de acquireRateSlot — o segundo chamador não
        // consome slot WAF nem posição na fila de vazão.
        if (method === 'GET' && !isRetry && this.inferOperation(method, path) !== 'GET_NOTIFICATIONS') {
            const domain = this.getBaseUrl().replace(/^https?:\/\//, '');
            const key = `${domain}|${this.clientId ?? ''}|${method}|${path}`;
            const existing = DocplannerClient.inflightGets.get(key);
            if (existing) {
                // Voo iniciado ANTES de o circuito abrir completa normalmente; o join
                // não cria voo novo nem consome slot — awaiters compartilham o mesmo
                // resultado/erro e o único incremento do breaker feito pelo voo.
                this.logger.debug(`[DEDUP] GET idêntico já em voo — juntando-se à requisição existente: ${path}`);
                try {
                    getDoctoraliaMetricsService()?.recordDedupedGet();
                } catch (_e) { /* fail-safe */ }
                return DocplannerClient.cloneResult(await existing);
            }
            // WP-08A: checagem do breaker ANTES de criar voo novo (fast-fail em OPEN).
            const gate = breaker.beginRequest();
            // WP-07: o loop de retry roda DENTRO do voo único — awaiters compartilham
            // uma única sequência de tentativas.
            const flight = this.executeWithBreaker(breaker, gate, method, path, data).finally(() => {
                DocplannerClient.inflightGets.delete(key);
            });
            DocplannerClient.inflightGets.set(key, flight);
            return DocplannerClient.cloneResult(await flight);
        }
        // WP-08A: checagem também para WRITEs e GET_NOTIFICATIONS — antes do rate limiter.
        const gate = breaker.beginRequest();
        return this.executeWithBreaker(breaker, gate, method, path, data);
    }

    /** Espera assíncrona (isolada em método estático para ser espiável em testes). */
    private static sleep(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }

    /**
     * WP-07 — Loop de retry para falhas transitórias (5xx/408/429/timeout/rede).
     * Envolve executeRequest DEPOIS da deduplicação (WP-05): cada tentativa
     * readquire slot no rate limiter dentro de executeRequest. O ramo de 401
     * permanece intocado dentro de executeRequest; sua repetição compartilha o
     * MESMO orçamento de tentativas (attemptState), impedindo loop cruzado.
     */
    private async executeWithRetry(
        method: string,
        path: string,
        data?: any,
        // Task 162: breaker+gate para o gate não-admissional de retry (WP-08A).
        breaker?: DoctoraliaCircuitBreaker,
        gate?: { isProbe: boolean },
    ): Promise<any> {
        const operation = this.inferOperation(method, path);
        const retryEligible = this.isRetryableOperation(method, operation);
        // Task 162: breaker+gate viajam no attemptState até o ponto de dispatch —
        // o gate é reforçado DENTRO de executeRequest (inclusive no retry de 401).
        const attemptState: RetryAttemptState = { attempts: 0, breaker, gate };
        let retryIndex = 0;
        let didRetry = false;
        for (;;) {
            try {
                const result = await this.executeRequest(method, path, data, false, attemptState);
                if (didRetry) {
                    try { getDoctoraliaMetricsService()?.recordTransientRetryOutcome('succeeded'); } catch (_e) { /* fail-safe */ }
                }
                return result;
            } catch (err: any) {
                const decision = decideRetry({
                    error: err,
                    retryEligible,
                    attemptsUsed: attemptState.attempts,
                    retryIndex,
                });
                if (decision.retry === false) {
                    if (decision.exhausted) {
                        try { getDoctoraliaMetricsService()?.recordTransientRetryOutcome('exhausted'); } catch (_e) { /* fail-safe */ }
                    }
                    throw err;
                }
                didRetry = true;
                try {
                    getDoctoraliaMetricsService()?.recordTransientRetry(
                        decision.classification,
                        decision.usedRetryAfter ? decision.delayMs : undefined,
                    );
                } catch (_e) { /* fail-safe */ }
                this.logger.warn(
                    `[RETRY] ${method} ${path} (${operation}) falhou (${decision.classification}) — ` +
                    `tentativa ${attemptState.attempts}/${MAX_HTTP_ATTEMPTS} consumida; aguardando ` +
                    `${Math.round(decision.delayMs)}ms antes de repetir${decision.usedRetryAfter ? ' (Retry-After honrado)' : ''}.`,
                );
                await DocplannerClient.sleep(decision.delayMs);
                // Task 162 — Gate NÃO-ADMISSIONAL antes de cada nova tentativa HTTP:
                // se o breaker abriu (OPEN/HALF_OPEN) DEPOIS que esta operação foi
                // admitida, o retry pendente NÃO dispara novo HTTP — falha imediata
                // com DoctoraliaCircuitOpenError, sem consumir slot/budget, sem
                // entrar na fila, sem alimentar o breaker e sem virar probe.
                // A probe autorizada (gate.isProbe) é isenta: ela É o caminho de
                // admissão do HALF_OPEN e mantém seus retries normais.
                if (breaker && !gate?.isProbe) {
                    breaker.assertRetryAllowed();
                }
                retryIndex++;
            }
        }
    }

    /**
     * Task 162 — Gate não-admissional no PONTO DE DISPATCH de uma NOVA tentativa
     * de operação já admitida (retry WP-07 ou repetição pós-401). A primeira
     * tentativa (attempts === 0) nunca é bloqueada (admissão já ocorreu em
     * beginRequest); a probe autorizada (gate.isProbe) é isenta. Lança
     * DoctoraliaCircuitOpenError — ignorado por recordFailure (não alimenta o
     * breaker).
     */
    /**
     * Task 162 — Devolve por IDENTIDADE as reservas de um grant não utilizado
     * (tentativa bloqueada pelo gate após a concessão do slot). Remove uma
     * ocorrência do timestamp exato do grant em cada janela; sob concorrência,
     * remover qualquer ocorrência de valor idêntico é contabilmente equivalente
     * e nunca toca reservas com timestamps distintos de outras requisições.
     */
    private static releaseRateSlotGrant(grant: RateSlotGrant | undefined): void {
        if (!grant) return;
        if (typeof grant.aggTs === 'number') {
            const i = DocplannerClient.rateTimestamps.indexOf(grant.aggTs);
            if (i >= 0) DocplannerClient.rateTimestamps.splice(i, 1);
        }
        if (typeof grant.writeTs === 'number') {
            const i = DocplannerClient.writeTimestamps.indexOf(grant.writeTs);
            if (i >= 0) DocplannerClient.writeTimestamps.splice(i, 1);
        }
    }

    private static guardRetryDispatch(attemptState: RetryAttemptState): void {
        if (!attemptState.breaker) return;
        if (attemptState.gate?.isProbe) return;
        if (attemptState.attempts === 0) return; // 1ª tentativa: admissão normal
        attemptState.breaker.assertRetryAllowed();
    }

    private async executeRequest(
        method: string,
        path: string,
        data?: any,
        isRetry = false,
        // WP-07: orçamento COMPARTILHADO de tentativas HTTP (inclui repetição de 401).
        attemptState: RetryAttemptState = { attempts: 0 },
    ): Promise<any> {
        // Task 162: bloqueia a nova tentativa ANTES de token/fila (sem custo).
        DocplannerClient.guardRetryDispatch(attemptState);
        if (this.clientId) {
            // Sempre passa pelo cache: pega token válido, renova se expirado, e re-tenta
            // autenticar mesmo que a autenticação inicial (fire-and-forget do createClient)
            // tenha falhado por um erro transitório — falha de auth não é cacheada.
            await this.getToken(false);
        } else if (this.authPromise) {
            await this.authPromise;
        }
        const domain = this.getBaseUrl().replace(/^https?:\/\//, '');
        const url = `https://${domain}${path}`;

        // WP-01: captura contexto e prepara instrumentação
        const ctx = getDoctoraliaContext();
        const doctoraliaRequestId = randomUUID();
        // WP-12C: correlação API↔mock no harness de carga. Inerte fora do harness
        // (header só é enviado quando o env do harness habilita explicitamente).
        const sendCorrelationHeader = process.env.LOADTEST_CORRELATION_HEADER === 'true';
        const enqueuedAt = Date.now();

        // Adquire o slot ANTES de armar o timeout de 30s — a espera na fila de vazão
        // não pode consumir o tempo da requisição em si. Classifica como GET ou WRITE
        // para que cada tentativa (retry transitório ou pós-401) consuma o budget correto.
        const methodClass: 'GET' | 'WRITE' = method === 'GET' ? 'GET' : 'WRITE';
        // Task 162: re-checa após os awaits de token (o breaker pode ter aberto
        // enquanto esta tentativa esperava) — ainda sem consumir slot.
        DocplannerClient.guardRetryDispatch(attemptState);
        const slotGrant = await DocplannerClient.acquireRateSlot(this.logger, methodClass);
        // Task 162: última checagem IMEDIATAMENTE antes do fetch — se o breaker
        // abriu durante a espera na fila, a tentativa NÃO dispara HTTP e as
        // reservas EXATAS deste grant são devolvidas por identidade (nunca as
        // de outra requisição concorrente).
        try {
            DocplannerClient.guardRetryDispatch(attemptState);
        } catch (blocked) {
            DocplannerClient.releaseRateSlotGrant(slotGrant);
            throw blocked;
        }
        attemptState.attempts++;
        const releasedAt = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        let httpStatus: number | 'TIMEOUT' | 'NETWORK' | 'OTHER' | undefined;
        const sentAt = Date.now();

        try {
            const headers: any = {
                'Authorization': `Bearer ${this.accessToken}`,
                'User-Agent': 'Orquestrador/1.0 (VisMed integration)',
            };
            // WP-12C: header custom só no harness (env LOADTEST_CORRELATION_HEADER=true).
            if (sendCorrelationHeader) headers['x-loadtest-correlation-id'] = doctoraliaRequestId;

            const options: RequestInit = {
                method,
                headers,
                signal: controller.signal,
            };

            if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
                headers['Content-Type'] = 'application/json';
                options.body = JSON.stringify(data);
            }

            this.logger.verbose(`Calling Docplanner API: ${method} ${url}`);
            const response = await fetch(url, options);
            httpStatus = response.status;

            if (method === 'PUT' || method === 'PATCH') {
                this.logger.log(`API Response: ${method} ${path} → status=${response.status}, content-type=${response.headers.get('content-type')}`);
            }

            if (!response.ok) {
                // Token do cache pode ter sido revogado/expirado no servidor.
                // Sempre renova o token para que a próxima chamada use um token válido,
                // mas só repete a operação se ela for comprovadamente idempotente.
                if (response.status === 401 && this.clientId) {
                    await response.text().catch(() => undefined);
                    const operation401 = this.inferOperation(method, path);
                    // WP-07: o retry de 401 também respeita o orçamento total de
                    // tentativas — impede loop entre retry transitório e retry de 401.
                    const canRetry = !isRetry
                        && this.isRetryableOperation(method, operation401)
                        && attemptState.attempts < MAX_HTTP_ATTEMPTS;
                    // Renovação SEMPRE ocorre — independente de repetir ou não.
                    await this.getToken(true);
                    if (canRetry) {
                        this.logger.warn(`401 em ${method} ${path} (${operation401}) — token renovado, repetindo a chamada.`);
                        // WP-05: retry direto em executeRequest — permanece DENTRO do voo
                        // único do dedup (não cria nem se junta a outra entrada do mapa).
                        return this.executeRequest(method, path, data, true, attemptState);
                    }
                    const reason = isRetry
                        ? 'já é retry'
                        : `operação ${operation401} não é idempotente`;
                    this.logger.warn(`401 em ${method} ${path} (${operation401}) — token renovado mas NÃO repetindo (${reason}).`);
                    const err401 = new Error(`Docplanner API Error: 401 Unauthorized`);
                    (err401 as any).status = 401;
                    throw err401;
                }
                const errorText = await response.text();
                this.logger.error(`Docplanner API Error: ${response.status} ${errorText} URL: ${url}`);
                const error = new Error(`Docplanner API Error: ${response.status} ${errorText}`);
                (error as any).status = response.status;
                (error as any).details = errorText;
                // WP-07: preserva o Retry-After para a política de retry (429).
                (error as any).retryAfter = response.headers.get('retry-after');
                throw error;
            }

            if (response.status === 204) {
                return null;
            }

            if (response.status === 201) {
                const location = response.headers.get('Location') || response.headers.get('location');
                let body = null;
                const text = await response.text();
                if (text && text.trim()) {
                    try { body = JSON.parse(text); } catch {}
                }
                return { ...(body || {}), _location: location, _status: 201 };
            }

            const text = await response.text();
            if (!text || !text.trim()) return null;
            try { return JSON.parse(text); } catch { return null; }
        } catch (err: any) {
            // Classifica o tipo de erro para métricas
            if (!httpStatus) {
                const isAbort = err?.name === 'AbortError';
                httpStatus = isAbort ? 'TIMEOUT' : 'NETWORK';
            }
            throw err;
        } finally {
            clearTimeout(timeout);
            // WP-01: registra evento de forma fail-safe
            const respondedAt = Date.now();
            try {
                const metrics = getDoctoraliaMetricsService();
                if (metrics) {
                    // WP-01: extrair IDs reais DO PATH antes de sanitizar (para resourceKey de assinatura)
                    const rawIdMatches = path.split('?')[0].match(/\/(\d+)/g);
                    const resourceKey = rawIdMatches ? rawIdMatches.map(s => s.slice(1)).join('|') : '';
                    // Sanitizar IDs no path mas PRESERVAR query params para assinatura de duplicatas
                    const [pathPart, queryPart] = path.split('?', 2);
                    const sanitized = pathPart.replace(/\/\d+/g, '/:id') + (queryPart ? '?' + queryPart : '');
                    const operation = this.inferOperation(method, path);
                    metrics.record({
                        doctoraliaRequestId,
                        origin: ctx?.origin ?? 'OTHER',
                        clinicId: ctx?.clinicId,
                        operation,
                        endpoint: sanitized,
                        resourceKey,
                        method,
                        httpStatus: httpStatus ?? 'OTHER',
                        isRetry: isRetry || attemptState.attempts > 1,
                        retryNumber: Math.max(0, attemptState.attempts - 1),
                        isOAuth: false,
                        enqueuedAt,
                        releasedAt,
                        sentAt,
                        respondedAt,
                        waitMs: releasedAt - enqueuedAt,
                        execMs: respondedAt - sentAt,
                        requestId: ctx?.requestId,
                        pollExecutionId: ctx?.pollExecutionId,
                    });
                }
            } catch (_e) { /* fail-safe: metrics never propagate */ }
        }
    }

    /**
     * Determina se uma operação pode ser repetida automaticamente após 401.
     *
     * Apenas operações **IDEMPOTENTE_COMPROVADA** recebem retry automático:
     * - Todos os GETs (leitura pura — repetiçao nunca altera estado)
     * - REPLACE_SLOTS via PUT (substituição total do calendário; mesmo payload → mesmo estado)
     *
     * Classificação completa de todas as operações Doctoralia:
     *
     * | Operação                          | HTTP   | Classificação           | Justificativa                                          |
     * |-----------------------------------|--------|-------------------------|--------------------------------------------------------|
     * | GET_FACILITIES                    | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_DOCTORS                       | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_ADDRESSES                     | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_SERVICES                      | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_CALENDAR                      | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_INSURANCES                    | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_INSURANCE_PROVIDERS           | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_INSURANCE_PLANS               | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_ADDRESS_INSURANCE_PROVIDERS   | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_FACILITY_SERVICES             | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_FACILITY_SERVICES_CATALOG     | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_SERVICES_DICTIONARY           | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_BOOKINGS                      | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_SLOTS                         | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_BREAKS                        | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_NOTIFICATIONS                 | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | REPLACE_SLOTS                     | PUT    | IDEMPOTENTE_COMPROVADA  | Substituição total; mesmo payload → mesmo estado final |
     * | PUT_ADDRESS_INSURANCE_PROVIDER    | PUT    | DESCONHECIDA            | Semântica não confirmada pelo contrato; conservador    |
     * | ADD_ADDRESS_SERVICE               | POST   | NÃO_IDEMPOTENTE         | Cria recurso; segundo POST cria duplicata              |
     * | ADD_ADDRESS_INSURANCE_PROVIDER    | POST   | NÃO_IDEMPOTENTE         | Cria vínculo; segundo POST pode criar duplicata        |
     * | BOOK_SLOT                         | POST   | NÃO_IDEMPOTENTE         | Cria booking; segundo POST cria booking duplicado      |
     * | ENABLE_CALENDAR                   | POST   | NÃO_IDEMPOTENTE         | Dispara ação                                           |
     * | DISABLE_CALENDAR                  | POST   | NÃO_IDEMPOTENTE         | Dispara ação                                           |
     * | RELEASE_NOTIFICATIONS             | POST   | NÃO_IDEMPOTENTE         | Consome/libera notificações                            |
     * | MOVE_BOOKING                      | POST   | NÃO_IDEMPOTENTE         | Move booking; segundo POST pode mover novamente        |
     * | ADD_BREAK                         | POST   | NÃO_IDEMPOTENTE         | Cria break; segundo POST cria break duplicado          |
     * | PATCH_ADDRESSES                   | PATCH  | NÃO_IDEMPOTENTE         | Atualização parcial; contrato não garante idempotência |
     * | PATCH_SERVICES                    | PATCH  | NÃO_IDEMPOTENTE         | Atualização parcial                                    |
     * | MOVE_BREAK                        | PATCH  | NÃO_IDEMPOTENTE         | Move break; segundo PATCH pode mover novamente         |
     * | DELETE_SLOTS                      | DELETE | NÃO_IDEMPOTENTE         | Segundo DELETE pode retornar 404 ou erro               |
     * | DELETE_SERVICES                   | DELETE | NÃO_IDEMPOTENTE         | Segundo DELETE pode retornar 404                       |
     * | DELETE_ADDRESS_INSURANCE_PROVIDER | DELETE | NÃO_IDEMPOTENTE         | Segundo DELETE pode retornar 404                       |
     * | DELETE_BREAK                      | DELETE | NÃO_IDEMPOTENTE         | Segundo DELETE pode retornar 404                       |
     * | CANCEL_BOOKING                    | DELETE | NÃO_IDEMPOTENTE         | Segundo DELETE pode retornar 404 ou efeito colateral   |
     */
    private isRetryableOperation(method: string, operation: string): boolean {
        // Todos os GETs são leitura pura — sempre idempotentes.
        if (method === 'GET') return true;
        // REPLACE_SLOTS é substituição total (PUT): mesmo payload → mesmo estado final.
        if (method === 'PUT' && operation === 'REPLACE_SLOTS') return true;
        // Tudo o mais (POST, DELETE, PATCH e outros PUTs) não tem idempotência comprovada.
        return false;
    }

    /** Infere nome de operação legível a partir do método HTTP e caminho. */
    private inferOperation(method: string, path: string): string {
        const p = path.toLowerCase();
        if (p.includes('/bookings') && method === 'GET') return 'GET_BOOKINGS';
        if (p.includes('/bookings') && method === 'DELETE') return 'CANCEL_BOOKING';
        if (p.includes('/bookings') && method === 'POST' && p.includes('/move')) return 'MOVE_BOOKING';
        if (p.includes('/bookings')) return `${method}_BOOKING`;
        if (p.includes('/slots') && p.includes('/book')) return 'BOOK_SLOT';
        if (p.includes('/slots') && method === 'PUT') return 'REPLACE_SLOTS';
        if (p.includes('/slots') && method === 'DELETE') return 'DELETE_SLOTS';
        if (p.includes('/slots') && method === 'GET') return 'GET_SLOTS';
        if (p.includes('/breaks') && method === 'GET') return 'GET_BREAKS';
        if (p.includes('/breaks') && method === 'POST') return 'ADD_BREAK';
        if (p.includes('/breaks') && method === 'DELETE') return 'DELETE_BREAK';
        if (p.includes('/breaks') && method === 'PATCH') return 'MOVE_BREAK';
        if (p.includes('/calendar/enable')) return 'ENABLE_CALENDAR';
        if (p.includes('/calendar/disable')) return 'DISABLE_CALENDAR';
        if (p.includes('/calendar')) return 'GET_CALENDAR';
        if (p.includes('/notifications/release')) return 'RELEASE_NOTIFICATIONS';
        if (p.includes('/notifications')) return 'GET_NOTIFICATIONS';
        if (p.includes('/addresses')) return `${method}_ADDRESSES`;
        if (p.includes('/doctors')) return `${method}_DOCTORS`;
        if (p.includes('/facilities')) return `${method}_FACILITIES`;
        if (p.includes('/services')) return `${method}_SERVICES`;
        if (p.includes('/insurance')) return `${method}_INSURANCE`;
        return `${method}_OTHER`;
    }

    async getFacilities(): Promise<any> {
        return this.request('GET', '/api/v3/integration/facilities');
    }

    async getDoctors(facilityId: string): Promise<any> {
        // Task 141: extensão doctor.license_numbers traz o registro profissional
        // (ex.: "CRM/SP 12345") na MESMA requisição, sem custo extra de rate limit.
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors?with[]=doctor.license_numbers`);
    }

    async getAddresses(facilityId: string, doctorId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses`);
    }

    async getServices(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/services`);
    }

    async getCalendarStatus(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/calendar`);
    }

    async getInsurances(facilityId: string): Promise<any> {
        try {
            return await this.request('GET', `/api/v3/integration/facilities/${facilityId}/insurances`);
        } catch (e) {
            return { _items: [] };
        }
    }

    async getInsuranceProviders(): Promise<any> {
        return this.request('GET', '/api/v3/integration/insurance-providers');
    }

    async getInsurancePlans(insuranceProviderId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/insurance-providers/${insuranceProviderId}/plans`);
    }

    async getAddressInsuranceProviders(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/insurance-providers`);
    }

    async addAddressInsuranceProvider(facilityId: string, doctorId: string, addressId: string, insuranceProviderId: string, insurancePlans?: { insurance_plan_id: string }[]): Promise<any> {
        const payload: any = { insurance_provider_id: String(insuranceProviderId) };
        if (insurancePlans && insurancePlans.length > 0) {
            payload.insurance_plans = insurancePlans;
        }
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/insurance-providers`, payload);
    }

    async putAddressInsuranceProvider(facilityId: string, doctorId: string, addressId: string, insuranceProviderId: string, insurancePlans?: { insurance_plan_id: string }[]): Promise<any> {
        const payload: any = { insurance_provider_id: String(insuranceProviderId) };
        if (insurancePlans && insurancePlans.length > 0) {
            payload.insurance_plans = insurancePlans;
        }
        return this.request('PUT', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/insurance-providers`, payload);
    }

    async deleteAddressInsuranceProvider(facilityId: string, doctorId: string, addressId: string, insuranceProviderId: string): Promise<any> {
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/insurance-providers/${insuranceProviderId}`);
    }

    async getFacilityServices(facilityId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/services`);
    }

    async getFacilityServicesCatalog(facilityId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/services/catalog`);
    }

    async getServicesDictionary(): Promise<any> {
        return this.request('GET', '/api/v3/integration/services');
    }

    async getBookings(facilityId: string, doctorId: string, addressId: string, start: string, end: string): Promise<any> {
        const s = start.includes('T') ? start : `${start}T00:00:00-03:00`;
        const e = end.includes('T') ? end : `${end}T23:59:59-03:00`;
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/bookings?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`);
    }

    async getBooking(facilityId: string, doctorId: string, addressId: string, bookingId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/bookings/${bookingId}`);
    }

    async getSlots(facilityId: string, doctorId: string, addressId: string, start: string, end: string): Promise<any> {
        const s = start.includes('T') ? start : `${start}T00:00:00-03:00`;
        const e = end.includes('T') ? end : `${end}T23:59:59-03:00`;
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`);
    }

    async replaceSlots(facilityId: string, doctorId: string, addressId: string, payload: any): Promise<any> {
        const slotCount = payload?.slots?.length || 0;
        this.logger.log(`replaceSlots: sending ${slotCount} slots for doctor ${doctorId}, address ${addressId}`);
        const result = await this.request('PUT', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots`, payload);
        this.logger.log(`replaceSlots: response=${JSON.stringify(result)}`);
        return result;
    }

    async bookSlot(facilityId: string, doctorId: string, addressId: string, slotStart: string, payload: any): Promise<any> {
        const encodedStart = encodeURIComponent(slotStart);
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots/${encodedStart}/book`, payload);
    }

    async deleteSlots(facilityId: string, doctorId: string, addressId: string, date: string): Promise<any> {
        const dateOnly = date.includes('T') ? date.split('T')[0] : date;
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots/${dateOnly}`);
    }

    async updateAddress(facilityId: string, doctorId: string, addressId: string, payload: any): Promise<any> {
        return this.request('PATCH', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}`, payload);
    }

    async addAddressService(facilityId: string, doctorId: string, addressId: string, payload: any): Promise<any> {
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/services`, payload);
    }

    async updateAddressService(facilityId: string, doctorId: string, addressId: string, serviceId: string, payload: any): Promise<any> {
        return this.request('PATCH', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/services/${serviceId}`, payload);
    }

    async deleteAddressService(facilityId: string, doctorId: string, addressId: string, serviceId: string): Promise<any> {
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/services/${serviceId}`);
    }

    async enableCalendar(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        this.logger.log(`enableCalendar: POST .../addresses/${addressId}/calendar/enable`);
        const result = await this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/calendar/enable`);
        this.logger.log(`enableCalendar: response=${JSON.stringify(result)}`);
        return result;
    }

    async disableCalendar(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        this.logger.log(`disableCalendar: POST .../addresses/${addressId}/calendar/disable`);
        const result = await this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/calendar/disable`);
        this.logger.log(`disableCalendar: response=${JSON.stringify(result)}`);
        return result;
    }

    async getCalendar(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/calendar`);
    }

    async getCalendarBreaks(facilityId: string, doctorId: string, addressId: string, since?: string, till?: string): Promise<any> {
        let path = `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks`;
        const params: string[] = [];
        if (since) params.push(`since=${encodeURIComponent(since)}`);
        if (till) params.push(`till=${encodeURIComponent(till)}`);
        if (params.length) path += `?${params.join('&')}`;
        return this.request('GET', path);
    }

    async addCalendarBreak(facilityId: string, doctorId: string, addressId: string, payload: { since: string; till: string }): Promise<any> {
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks`, payload);
    }

    async getCalendarBreak(facilityId: string, doctorId: string, addressId: string, breakId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks/${breakId}`);
    }

    async moveCalendarBreak(facilityId: string, doctorId: string, addressId: string, breakId: string, payload: { since: string; till: string }): Promise<any> {
        return this.request('PATCH', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks/${breakId}`, payload);
    }

    async deleteCalendarBreak(facilityId: string, doctorId: string, addressId: string, breakId: string): Promise<any> {
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks/${breakId}`);
    }

    async cancelBooking(facilityId: string, doctorId: string, addressId: string, bookingId: string, reason?: string): Promise<any> {
        this.logger.log(`cancelBooking: DELETE booking ${bookingId} for doctor ${doctorId}`);
        const body = reason ? { reason } : undefined;
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/bookings/${bookingId}`, body);
    }

    async moveBooking(facilityId: string, doctorId: string, addressId: string, bookingId: string, payload: {
        address_service_id: number;
        duration: number;
        start: string;
        address_id?: number;
    }): Promise<any> {
        this.logger.log(`moveBooking: POST move booking ${bookingId} to ${payload.start}`);
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/bookings/${bookingId}/move`, payload);
    }

    async getNotifications(limit: number = 100): Promise<any> {
        return this.request('GET', `/api/v3/integration/notifications/multiple?limit=${limit}`);
    }

    async releaseFailedNotifications(): Promise<any> {
        this.logger.log('releaseFailedNotifications: triggering re-queue of failed notifications');
        return this.request('POST', '/api/v3/integration/notifications/release');
    }
}

@Injectable()
export class DocplannerService implements OnModuleDestroy {
    /**
     * WP-08B: os DocplannerClient são criados manualmente (createClient), então
     * o Nest não invoca o onModuleDestroy deles. Este provider gerenciado é o
     * dono do lifecycle: encerra o coordinator estático compartilhado.
     */
    onModuleDestroy(): void {
        DocplannerClient.shutdownRateQueue();
    }

    constructor(
        private configService: ConfigService,
        private prisma: PrismaService,
    ) { }

    createClient(domain: string, clientId: string, clientSecret: string): DocplannerClient {
        const client = new DocplannerClient(this.configService);
        client.setBaseUrl(domain);
        // Persistência do token no banco (sobrevive a restarts; token Doctoralia vale ~24h).
        client.setPersistence(
            async () => {
                const conn = await this.prisma.integrationConnection.findFirst({
                    where: { provider: 'doctoralia', clientId },
                    select: { cachedToken: true, tokenExpiresAt: true },
                });
                if (!conn?.cachedToken || !conn.tokenExpiresAt) return null;
                return { token: conn.cachedToken, expiresAt: conn.tokenExpiresAt.getTime() };
            },
            async (t) => {
                await this.prisma.integrationConnection.updateMany({
                    where: { provider: 'doctoralia', clientId },
                    data: { cachedToken: t.token, tokenExpiresAt: new Date(t.expiresAt) },
                });
            },
        );
        // We start authentication but don't await here to match existing sync usage pattern.
        // In a real scenario, the first call to the client would await this or authenticate would be called explicitly.
        client.authenticate(clientId, clientSecret).catch(err => {
            console.error('Docplanner background authentication failed:', err.message);
        });
        return client;
    }
}
