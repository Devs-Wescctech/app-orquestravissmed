import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const WORKER_ID = `worker-${process.pid}-${Date.now()}`;
// LEASE_TIMEOUT: um job RUNNING cujo lockedAt não é renovado há mais que isto
// é considerado abandonado (dono morto/travado). Todo worker vivo renova o
// lease a cada HEARTBEAT_INTERVAL_MS, então lease vencido implica dono morto.
const LEASE_TIMEOUT_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const POLL_INTERVAL_MS = 1000;
const MAX_CONCURRENT = 10;

/**
 * ── Limitações residuais aceitas (desenho aprovado da task P1) ──────────────
 * 1. O lease protege o ESTADO do SyncJob (writes terminais condicionais por
 *    ownership), mas NÃO cerca efeitos externos VisMed de um handler que
 *    perdeu o lease: não há AbortSignal nos handlers nem no cliente VisMed e
 *    não há re-checagem de ownership imediatamente antes das chamadas
 *    externas. Na janela rara de um worker A vivo sem lease (≥5min de
 *    renovações sem sucesso com A ainda progredindo), A e B podem ambos
 *    executar POST na VisMed — mitigado apenas pelo lookup pré-create do
 *    caminho de retry. Classificação: POSSÍVEL MAS CONTROLADO.
 * 2. O cliente HTTP VisMed não tem timeout: um handler pendurado num HTTP
 *    mantém o heartbeat vivo e bloqueia a dedupKey indefinidamente. Follow-up
 *    recomendado: timeout no cliente VisMed (fora do escopo desta task).
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(QueueService.name);
    private workerInterval: NodeJS.Timeout | null = null;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private activeJobs = 0;
    private isShuttingDown = false;

    constructor(private prisma: PrismaService) {}

    onModuleInit() {
        this.startWorker();
        this.startStaleLockCleanup();
    }

    onModuleDestroy() {
        this.isShuttingDown = true;
        if (this.workerInterval) {
            clearInterval(this.workerInterval);
            this.workerInterval = null;
        }
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    private handlers = new Map<string, (payload: any, clinicId: string) => Promise<void>>();
    private deadLetterHandlers = new Map<string, (payload: any, clinicId: string, error: string) => Promise<void>>();

    registerHandler(type: string, handler: (payload: any, clinicId: string) => Promise<void>) {
        this.handlers.set(type, handler);
        this.logger.log(`Registered handler for job type: ${type}`);
    }

    registerDeadLetterHandler(type: string, handler: (payload: any, clinicId: string, error: string) => Promise<void>) {
        this.deadLetterHandlers.set(type, handler);
        this.logger.log(`Registered dead-letter handler for job type: ${type}`);
    }

    /**
     * Enfileira um job. Deduplicação é ATÔMICA: confia no índice único parcial
     * "SyncJob_dedupKey_active_key" (dedupKey único enquanto o job está ativo:
     * PENDING, RUNNING ou FAILED com retries restantes). Em conflito, devolve
     * o job ativo existente — sem janela check-then-create.
     */
    async enqueue(clinicId: string, type: string, payload: any, options?: {
        priority?: number;
        maxAttempts?: number;
        delayMs?: number;
        dedupKey?: string;
    }) {
        const nextRunAt = options?.delayMs
            ? new Date(Date.now() + options.delayMs)
            : new Date();

        try {
            return await this.prisma.syncJob.create({
                data: {
                    clinicId,
                    type,
                    payload,
                    priority: options?.priority || 0,
                    maxAttempts: options?.maxAttempts || 5,
                    nextRunAt,
                    dedupKey: options?.dedupKey || null,
                },
            });
        } catch (err: any) {
            if (options?.dedupKey && this.isUniqueViolation(err)) {
                this.logger.debug(`[DEDUP] Skipping duplicate job: ${options.dedupKey}`);
                const existing = await this.findActiveByDedupKey(options.dedupKey);
                if (existing) return existing;
                // Corrida rara: o job ativo terminou entre o conflito e o SELECT.
                // Tentar inserir mais uma vez; se conflitar de novo, devolver o ativo.
                try {
                    return await this.prisma.syncJob.create({
                        data: {
                            clinicId,
                            type,
                            payload,
                            priority: options?.priority || 0,
                            maxAttempts: options?.maxAttempts || 5,
                            nextRunAt,
                            dedupKey: options.dedupKey,
                        },
                    });
                } catch (err2: any) {
                    if (this.isUniqueViolation(err2)) {
                        return this.findActiveByDedupKey(options.dedupKey);
                    }
                    throw err2;
                }
            }
            throw err;
        }
    }

    /**
     * Enfileira um lote. Deduplica chaves repetidas DENTRO do lote e insere com
     * `INSERT ... ON CONFLICT DO NOTHING` (sem alvo, cobre o índice único
     * parcial — createMany({skipDuplicates}) do Prisma emite ON CONFLICT com o
     * mesmo efeito, mas usamos SQL explícito para não depender desse detalhe).
     */
    async enqueueBatch(jobs: Array<{
        clinicId: string;
        type: string;
        payload: any;
        priority?: number;
        maxAttempts?: number;
        dedupKey?: string;
    }>) {
        if (jobs.length === 0) return;

        // Dedup intra-lote: mantém a primeira ocorrência de cada dedupKey.
        const seen = new Set<string>();
        const unique = jobs.filter(j => {
            if (!j.dedupKey) return true;
            if (seen.has(j.dedupKey)) return false;
            seen.add(j.dedupKey);
            return true;
        });
        if (unique.length === 0) return;

        let count = 0;
        for (const j of unique) {
            const inserted = await this.prisma.$executeRaw`
                INSERT INTO "SyncJob"
                    (id, "clinicId", type, payload, priority, "maxAttempts",
                     "nextRunAt", "dedupKey", "createdAt", "updatedAt")
                VALUES
                    (gen_random_uuid(), ${j.clinicId}, ${j.type}, ${JSON.stringify(j.payload)}::jsonb,
                     ${j.priority || 0}, ${j.maxAttempts || 5},
                     (now() AT TIME ZONE 'utc'), ${j.dedupKey || null},
                     (now() AT TIME ZONE 'utc'), (now() AT TIME ZONE 'utc'))
                ON CONFLICT DO NOTHING
            `;
            count += inserted;
        }
        return { count };
    }

    private isUniqueViolation(err: any): boolean {
        return err?.code === 'P2002' || `${err?.message}`.includes('23505')
            || `${err?.message}`.includes('SyncJob_dedupKey_active_key');
    }

    private findActiveByDedupKey(dedupKey: string) {
        // Mesmo predicado do índice parcial (attempts < maxAttempts exige SQL cru).
        return this.prisma.$queryRaw<any[]>`
            SELECT * FROM "SyncJob"
            WHERE "dedupKey" = ${dedupKey}
              AND (status IN ('PENDING', 'RUNNING')
                   OR (status = 'FAILED' AND attempts < "maxAttempts"))
            LIMIT 1
        `.then(rows => rows.length > 0 ? rows[0] : null);
    }

    private async claimJob() {
        // IMPORTANTE: usar (now() AT TIME ZONE 'utc') em vez de passar um Date do Node.
        // As colunas são "timestamp without time zone" e o Prisma grava instantes em UTC;
        // um parâmetro Date em $queryRaw chega como timestamptz e o Postgres o converte
        // para o fuso do SERVIDOR na comparação. Em produção (banco em America/Sao_Paulo,
        // UTC-3) isso fazia cada job só se tornar elegível 3 HORAS depois de criado.
        //
        // O claim seta APENAS status/lockedBy/lockedAt/attempts — nunca toca em
        // "dedupKey": a chave precisa sobreviver ao claim para o índice parcial
        // continuar bloqueando duplicatas enquanto o job está RUNNING.
        const jobs = await this.prisma.$queryRaw<any[]>`
            UPDATE "SyncJob"
            SET status = 'RUNNING',
                "lockedAt" = (now() AT TIME ZONE 'utc'),
                "lockedBy" = ${WORKER_ID},
                attempts = attempts + 1,
                "updatedAt" = (now() AT TIME ZONE 'utc')
            WHERE id = (
                SELECT id FROM "SyncJob"
                WHERE status IN ('PENDING', 'FAILED')
                AND "nextRunAt" <= (now() AT TIME ZONE 'utc')
                AND (status != 'FAILED' OR attempts < "maxAttempts")
                ORDER BY priority DESC, "nextRunAt" ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            RETURNING *
        `;

        return jobs.length > 0 ? jobs[0] : null;
    }

    /**
     * Write terminal condicional por ownership: só o worker dono (lockedBy =
     * WORKER_ID) com o job ainda RUNNING pode completar. count === 0 → warn e
     * no-op (o cleanup recuperou ou outro worker assumiu); nunca lança.
     */
    private async completeJob(jobId: string, dedupKey?: string | null) {
        const result = await this.prisma.syncJob.updateMany({
            where: { id: jobId, status: 'RUNNING', lockedBy: WORKER_ID },
            data: {
                status: 'COMPLETED',
                completedAt: new Date(),
                lockedAt: null,
                lockedBy: null,
            },
        });
        if (result.count === 0) {
            this.logger.warn(`[OWNERSHIP] completeJob ignorado: job ${jobId} (dedupKey=${dedupKey ?? '-'}) não pertence mais a ${WORKER_ID}`);
        }
    }

    /**
     * Mesma cláusula condicional de ownership. attempts >= maxAttempts → DEAD
     * (dead-letter); senão FAILED com backoff exponencial.
     */
    private async failJob(jobId: string, error: string, attempts: number, maxAttempts: number, dedupKey?: string | null) {
        const isDead = attempts >= maxAttempts;
        const backoffMs = Math.min(Math.pow(2, attempts) * 1000, 300000);

        const result = await this.prisma.syncJob.updateMany({
            where: { id: jobId, status: 'RUNNING', lockedBy: WORKER_ID },
            data: {
                status: isDead ? 'DEAD' : 'FAILED',
                lastError: error.substring(0, 1000),
                nextRunAt: isDead ? undefined : new Date(Date.now() + backoffMs),
                lockedAt: null,
                lockedBy: null,
            },
        });

        if (result.count === 0) {
            this.logger.warn(`[OWNERSHIP] failJob ignorado: job ${jobId} (dedupKey=${dedupKey ?? '-'}) não pertence mais a ${WORKER_ID}`);
            return;
        }

        if (isDead) {
            this.logger.error(`[DEAD-LETTER] Job ${jobId} exceeded max attempts (${maxAttempts})`);
        } else {
            this.logger.warn(`[RETRY] Job ${jobId} failed (attempt ${attempts}/${maxAttempts}), retry in ${backoffMs / 1000}s`);
        }
    }

    private startWorker() {
        this.workerInterval = setInterval(async () => {
            if (this.isShuttingDown) return;

            try {
                while (this.activeJobs < MAX_CONCURRENT && !this.isShuttingDown) {
                    const job = await this.claimJob();
                    if (!job) break;

                    this.activeJobs++;
                    this.processJob(job).finally(() => {
                        this.activeJobs--;
                    });
                }
            } catch (err: any) {
                this.logger.error(`[WORKER] Claim error: ${err.message}`);
            }
        }, POLL_INTERVAL_MS);
    }

    /**
     * Heartbeat: renova lockedAt a cada 60s enquanto o handler roda.
     * - count === 0 (evidência definitiva de perda do lease: cleanup recuperou
     *   ou outro worker assumiu) → marca lease-lost e para de renovar.
     * - EXCEÇÃO/erro transitório de banco → NÃO marca lease-lost; loga e tenta
     *   no próximo tick (com heartbeat 60s e lease 5min, toleram-se ~4 falhas
     *   transitórias consecutivas antes de o lease expirar de fato).
     */
    private startHeartbeat(job: any, state: { leaseLost: boolean }): NodeJS.Timeout {
        return setInterval(() => this.heartbeatTick(job, state), HEARTBEAT_INTERVAL_MS);
    }

    // Extraído para permitir teste direto (um "tick" do heartbeat).
    private async heartbeatTick(job: any, state: { leaseLost: boolean }) {
        if (state.leaseLost) return;
        try {
            const result = await this.prisma.syncJob.updateMany({
                where: { id: job.id, status: 'RUNNING', lockedBy: WORKER_ID },
                data: { lockedAt: new Date() },
            });
            if (result.count === 0) {
                state.leaseLost = true;
                this.logger.warn(`[HEARTBEAT] Lease perdido para job ${job.id} (dedupKey=${job.dedupKey ?? '-'}): cleanup recuperou ou outro worker assumiu`);
            }
        } catch (err: any) {
            // Erro transitório: não é evidência de perda do lease.
            this.logger.warn(`[HEARTBEAT] Falha transitória ao renovar lease do job ${job.id}: ${err.message}`);
        }
    }

    private async processJob(job: any) {
        const handler = this.handlers.get(job.type);
        if (!handler) {
            this.logger.warn(`[WORKER] No handler for job type: ${job.type}`);
            await this.failJob(job.id, `No handler for type: ${job.type}`, job.attempts, job.maxAttempts, job.dedupKey);
            return;
        }

        const leaseState = { leaseLost: false };
        const heartbeat = this.startHeartbeat(job, leaseState);

        try {
            await handler(job.payload, job.clinicId);
            if (leaseState.leaseLost) {
                // Perdeu o lease no meio: descartar o resultado (não completar).
                this.logger.warn(`[LEASE-LOST] Resultado descartado para job ${job.id} (dedupKey=${job.dedupKey ?? '-'}): outro worker é o dono`);
                return;
            }
            await this.completeJob(job.id, job.dedupKey);
        } catch (err: any) {
            if (leaseState.leaseLost) {
                this.logger.warn(`[LEASE-LOST] Falha descartada para job ${job.id} (dedupKey=${job.dedupKey ?? '-'}): outro worker é o dono`);
                return;
            }
            await this.failJob(job.id, err.message, job.attempts, job.maxAttempts, job.dedupKey);

            const isDead = job.attempts >= job.maxAttempts;
            if (isDead) {
                const deadHandler = this.deadLetterHandlers.get(job.type);
                if (deadHandler) {
                    try {
                        await deadHandler(job.payload, job.clinicId, err.message || 'unknown error');
                    } catch (dlErr: any) {
                        this.logger.error(`[DEAD-LETTER] Handler error for job ${job.id}: ${dlErr.message}`);
                    }
                }
            }
        } finally {
            clearInterval(heartbeat);
        }
    }

    /**
     * Cleanup de jobs abandonados: RUNNING com lease vencido (lockedAt < now -
     * LEASE_TIMEOUT). Como todo worker vivo renova a cada 60s, lease vencido
     * implica dono morto/travado. Recuperados voltam FAILED com nextRunAt de
     * backoff explícito (não retry imediato) OU vão direto a DEAD quando os
     * attempts já esgotaram (eliminando o zumbi FAILED/attempts>=maxAttempts).
     * dedupKey é PRESERVADO em ambos os casos.
     */
    private startStaleLockCleanup() {
        this.cleanupInterval = setInterval(async () => {
            if (this.isShuttingDown) return;
            try {
                const results = await this.runStaleLockCleanup();
                if (results.recovered > 0 || results.dead > 0) {
                    this.logger.warn(`[CLEANUP] Recuperados ${results.recovered} job(s) abandonado(s) para retry, ${results.dead} movido(s) para DEAD`);
                }
            } catch (err: any) {
                this.logger.error(`[CLEANUP] Error: ${err.message}`);
            }
        }, 60000);
    }

    // Extraído para permitir teste direto. Mantém o padrão now() AT TIME ZONE 'utc'.
    private async runStaleLockCleanup() {
        const dead = await this.prisma.$executeRaw`
            UPDATE "SyncJob"
            SET status = 'DEAD',
                "lockedAt" = NULL,
                "lockedBy" = NULL,
                "lastError" = 'Stale lock timeout - max attempts exhausted',
                "updatedAt" = (now() AT TIME ZONE 'utc')
            WHERE status = 'RUNNING'
              AND "lockedAt" < (now() AT TIME ZONE 'utc') - make_interval(secs => ${LEASE_TIMEOUT_MS / 1000})
              AND attempts >= "maxAttempts"
        `;
        // Backoff explícito para o retry (60s): sem isso o retry seria imediato.
        const recovered = await this.prisma.$executeRaw`
            UPDATE "SyncJob"
            SET status = 'FAILED',
                "lockedAt" = NULL,
                "lockedBy" = NULL,
                "lastError" = 'Stale lock timeout - job will be retried',
                "nextRunAt" = (now() AT TIME ZONE 'utc') + interval '60 seconds',
                "updatedAt" = (now() AT TIME ZONE 'utc')
            WHERE status = 'RUNNING'
              AND "lockedAt" < (now() AT TIME ZONE 'utc') - make_interval(secs => ${LEASE_TIMEOUT_MS / 1000})
              AND attempts < "maxAttempts"
        `;
        return { recovered, dead };
    }

    async getMetrics() {
        const [counts, deadLetters, oldestPending] = await Promise.all([
            this.prisma.syncJob.groupBy({
                by: ['status'],
                _count: true,
            }),
            this.prisma.syncJob.count({ where: { status: 'DEAD' } }),
            this.prisma.syncJob.findFirst({
                where: { status: 'PENDING' },
                orderBy: { createdAt: 'asc' },
                select: { createdAt: true },
            }),
        ]);

        const statusCounts: Record<string, number> = {};
        counts.forEach(c => { statusCounts[c.status] = c._count; });

        return {
            workerId: WORKER_ID,
            activeJobs: this.activeJobs,
            maxConcurrent: MAX_CONCURRENT,
            queue: statusCounts,
            deadLetters,
            oldestPendingAge: oldestPending
                ? Date.now() - oldestPending.createdAt.getTime()
                : null,
        };
    }

    async getClinicMetrics(clinicId: string) {
        const counts = await this.prisma.syncJob.groupBy({
            by: ['status'],
            where: { clinicId },
            _count: true,
        });

        const last24h = new Date(Date.now() - 86400000);
        const throughput = await this.prisma.syncJob.count({
            where: { clinicId, status: 'COMPLETED', completedAt: { gte: last24h } },
        });

        const statusCounts: Record<string, number> = {};
        counts.forEach(c => { statusCounts[c.status] = c._count; });

        return { clinicId, queue: statusCounts, throughput24h: throughput };
    }

    /**
     * Ressuscita dead-letters (DEAD → PENDING). Tolera conflito com o índice
     * parcial: se já existir job ativo com a mesma dedupKey, o DEAD é pulado
     * (reportado em skippedCount) em vez de quebrar.
     */
    async retryDeadLetters(clinicId: string) {
        const retried = await this.prisma.$executeRaw`
            UPDATE "SyncJob" d
            SET status = 'PENDING',
                attempts = 0,
                "nextRunAt" = (now() AT TIME ZONE 'utc'),
                "lastError" = NULL,
                "lockedAt" = NULL,
                "lockedBy" = NULL,
                "updatedAt" = (now() AT TIME ZONE 'utc')
            WHERE d.status = 'DEAD'
              AND d."clinicId" = ${clinicId}
              AND (d."dedupKey" IS NULL OR NOT EXISTS (
                    SELECT 1 FROM "SyncJob" a
                    WHERE a."dedupKey" = d."dedupKey"
                      AND a.id != d.id
                      AND (a.status IN ('PENDING', 'RUNNING')
                           OR (a.status = 'FAILED' AND a.attempts < a."maxAttempts"))
              ))
        `;
        const remaining = await this.prisma.syncJob.count({ where: { status: 'DEAD', clinicId } });
        return { retriedCount: retried, skippedCount: remaining };
    }
}
