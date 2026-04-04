import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const WORKER_ID = `worker-${process.pid}-${Date.now()}`;
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;
const MAX_CONCURRENT = 10;

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

    registerHandler(type: string, handler: (payload: any, clinicId: string) => Promise<void>) {
        this.handlers.set(type, handler);
        this.logger.log(`Registered handler for job type: ${type}`);
    }

    async enqueue(clinicId: string, type: string, payload: any, options?: {
        priority?: number;
        maxAttempts?: number;
        delayMs?: number;
        dedupKey?: string;
    }) {
        if (options?.dedupKey) {
            const existing = await this.prisma.syncJob.findFirst({
                where: {
                    clinicId,
                    type,
                    lockedBy: options.dedupKey,
                    status: { in: ['PENDING', 'RUNNING'] },
                },
            });
            if (existing) {
                this.logger.debug(`[DEDUP] Skipping duplicate job: ${options.dedupKey}`);
                return existing;
            }
        }

        const nextRunAt = options?.delayMs
            ? new Date(Date.now() + options.delayMs)
            : new Date();

        return this.prisma.syncJob.create({
            data: {
                clinicId,
                type,
                payload,
                priority: options?.priority || 0,
                maxAttempts: options?.maxAttempts || 5,
                nextRunAt,
                lockedBy: options?.dedupKey || null,
            },
        });
    }

    async enqueueBatch(jobs: Array<{
        clinicId: string;
        type: string;
        payload: any;
        priority?: number;
        maxAttempts?: number;
        dedupKey?: string;
    }>) {
        if (jobs.length === 0) return;

        const dedupKeys = jobs.filter(j => j.dedupKey).map(j => j.dedupKey!);
        let existingKeys = new Set<string>();

        if (dedupKeys.length > 0) {
            const existing = await this.prisma.syncJob.findMany({
                where: {
                    lockedBy: { in: dedupKeys },
                    status: { in: ['PENDING', 'RUNNING'] },
                },
                select: { lockedBy: true },
            });
            existingKeys = new Set(existing.map(e => e.lockedBy!));
        }

        const filtered = jobs.filter(j => !j.dedupKey || !existingKeys.has(j.dedupKey));
        if (filtered.length === 0) return;

        const data = filtered.map(j => ({
            clinicId: j.clinicId,
            type: j.type,
            payload: j.payload,
            priority: j.priority || 0,
            maxAttempts: j.maxAttempts || 5,
            nextRunAt: new Date(),
            lockedBy: j.dedupKey || null,
        }));

        return this.prisma.syncJob.createMany({ data });
    }

    private async claimJob() {
        const now = new Date();

        const jobs = await this.prisma.$queryRaw<any[]>`
            UPDATE "SyncJob"
            SET status = 'RUNNING',
                "lockedAt" = ${now},
                "lockedBy" = ${WORKER_ID},
                attempts = attempts + 1,
                "updatedAt" = ${now}
            WHERE id = (
                SELECT id FROM "SyncJob"
                WHERE status IN ('PENDING', 'FAILED')
                AND "nextRunAt" <= ${now}
                AND (status != 'FAILED' OR attempts < "maxAttempts")
                ORDER BY priority DESC, "nextRunAt" ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            RETURNING *
        `;

        return jobs.length > 0 ? jobs[0] : null;
    }

    private async completeJob(jobId: string) {
        await this.prisma.syncJob.update({
            where: { id: jobId },
            data: {
                status: 'COMPLETED',
                completedAt: new Date(),
                lockedAt: null,
                lockedBy: null,
            },
        });
    }

    private async failJob(jobId: string, error: string, attempts: number, maxAttempts: number) {
        const isDead = attempts >= maxAttempts;
        const backoffMs = Math.min(Math.pow(2, attempts) * 1000, 300000);

        await this.prisma.syncJob.update({
            where: { id: jobId },
            data: {
                status: isDead ? 'DEAD' : 'FAILED',
                lastError: error.substring(0, 1000),
                nextRunAt: isDead ? undefined : new Date(Date.now() + backoffMs),
                lockedAt: null,
                lockedBy: null,
            },
        });

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

    private async processJob(job: any) {
        const handler = this.handlers.get(job.type);
        if (!handler) {
            this.logger.warn(`[WORKER] No handler for job type: ${job.type}`);
            await this.failJob(job.id, `No handler for type: ${job.type}`, job.attempts, job.maxAttempts);
            return;
        }

        try {
            await handler(job.payload, job.clinicId);
            await this.completeJob(job.id);
        } catch (err: any) {
            await this.failJob(job.id, err.message, job.attempts, job.maxAttempts);
        }
    }

    private startStaleLockCleanup() {
        this.cleanupInterval = setInterval(async () => {
            if (this.isShuttingDown) return;
            try {
                const staleThreshold = new Date(Date.now() - LOCK_TIMEOUT_MS);
                const result = await this.prisma.syncJob.updateMany({
                    where: {
                        status: 'RUNNING',
                        lockedAt: { lt: staleThreshold },
                    },
                    data: {
                        status: 'FAILED',
                        lockedAt: null,
                        lockedBy: null,
                        lastError: 'Stale lock timeout - job will be retried',
                    },
                });
                if (result.count > 0) {
                    this.logger.warn(`[CLEANUP] Released ${result.count} stale job locks`);
                }
            } catch (err: any) {
                this.logger.error(`[CLEANUP] Error: ${err.message}`);
            }
        }, 60000);
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

    async retryDeadLetters(clinicId: string) {
        const result = await this.prisma.syncJob.updateMany({
            where: { status: 'DEAD', clinicId },
            data: {
                status: 'PENDING',
                attempts: 0,
                nextRunAt: new Date(),
                lastError: null,
                lockedAt: null,
                lockedBy: null,
            },
        });

        return { retriedCount: result.count };
    }
}
