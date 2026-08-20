import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { createHash } from 'crypto';
import { Pool, PoolClient, PoolConfig } from 'pg';

export type ClaimDeferReason =
    | 'pool_busy'
    | 'lock_occupied'
    | 'claim_error'
    | 'session_lost'
    | 'draining';

export class ClaimDeferError extends Error {
    constructor(
        public readonly reason: ClaimDeferReason,
        message: string = reason,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'ClaimDeferError';
    }
}

export interface WithClaimOptions {
    mode?: 'fail-fast' | 'worker';
    signal?: AbortSignal;
    maxWaitMs?: number;
}

const CLAIM_NAMESPACE = 'vismed-booking-claim-v1';
const WORKER_WAIT_BUDGET_MS = 4 * 60 * 1000;
const APPLICATION_NAME = 'vismed-booking-claims';

let pool: Pool | null = null;
const poolLogger = new Logger('BookingClaimService');

function poolConfig(): PoolConfig {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');

    return {
        // Passing the URL through unchanged preserves its sslmode/SSL settings.
        connectionString,
        max: 2,
        min: 0,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 1_000,
        maxLifetimeSeconds: 0,
        keepAlive: true,
        keepAliveInitialDelayMillis: 30_000,
        application_name: APPLICATION_NAME,
    };
}

function getPool(): Pool {
    if (!pool) {
        pool = new Pool(poolConfig());
        pool.on('error', (error: NodeJS.ErrnoException) => {
            poolLogger.error(
                `[BOOKING-CLAIM] background pool error code=${error.code || 'UNKNOWN'}`,
            );
        });
    }
    return pool;
}

export function computeLockKey(clinicId: string, doctoraliaBookingId: string): bigint {
    const canonical = JSON.stringify([
        CLAIM_NAMESPACE,
        clinicId,
        doctoraliaBookingId,
    ]);
    return createHash('sha256').update(canonical).digest().readBigInt64BE(0);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(new ClaimDeferError('session_lost', 'Claim wait aborted'));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(new ClaimDeferError('session_lost', 'Claim wait aborted'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

@Injectable()
export class BookingClaimService implements OnApplicationShutdown {
    private readonly logger = new Logger(BookingClaimService.name);
    private _draining = false;
    private _activeCallbacks = 0;
    private drainResolve: (() => void) | null = null;

    get activeCallbacks(): number {
        return this._activeCallbacks;
    }

    get draining(): boolean {
        return this._draining;
    }

    async withClaim<T>(
        clinicId: string,
        doctoraliaBookingId: string,
        callback: (signal: AbortSignal) => Promise<T>,
        options: WithClaimOptions = {},
    ): Promise<T> {
        if (this._draining) {
            throw new ClaimDeferError('draining', 'Booking claim service is draining');
        }

        this._activeCallbacks++;
        try {
            const mode = options.mode ?? 'fail-fast';
            const deadline = Date.now() + (options.maxWaitMs ?? WORKER_WAIT_BUDGET_MS);
            let attempt = 0;

            while (true) {
                if (this._draining) {
                    throw new ClaimDeferError('draining', 'Booking claim service is draining');
                }
                if (options.signal?.aborted) {
                    throw new ClaimDeferError('session_lost', 'Claim request aborted');
                }

                try {
                    return await this.withClaimOnce(
                        clinicId,
                        doctoraliaBookingId,
                        callback,
                        options.signal,
                    );
                } catch (error) {
                    const retryable = error instanceof ClaimDeferError
                        && error.reason !== 'draining';
                    if (mode !== 'worker' || !retryable || Date.now() >= deadline) {
                        throw error;
                    }

                    attempt++;
                    const waitMs = Math.min(2_000, 100 * (2 ** Math.min(attempt, 4)))
                        + Math.floor(Math.random() * 200);
                    this.logger.debug(
                        `[BOOKING-CLAIM] deferred clinicId=${clinicId} reason=${error.reason} attempt=${attempt}`,
                    );
                    await delay(Math.min(waitMs, Math.max(0, deadline - Date.now())), options.signal);
                }
            }
        } finally {
            this._activeCallbacks--;
            if (this._draining && this._activeCallbacks === 0) {
                this.drainResolve?.();
            }
        }
    }

    private async withClaimOnce<T>(
        clinicId: string,
        doctoraliaBookingId: string,
        callback: (signal: AbortSignal) => Promise<T>,
        externalSignal?: AbortSignal,
    ): Promise<T> {
        let client: PoolClient;
        try {
            client = await getPool().connect();
        } catch (error: any) {
            const timeout = /timeout|ETIMEDOUT/i.test(String(error?.message || ''));
            throw new ClaimDeferError(
                timeout ? 'pool_busy' : 'claim_error',
                timeout ? 'Booking claim pool has no capacity' : 'Booking claim checkout failed',
                error,
            );
        }

        const lockKey = computeLockKey(clinicId, doctoraliaBookingId);
        const controller = new AbortController();
        let sessionLost = false;
        let lockAcquired = false;
        let released = false;

        const release = (destroy: boolean) => {
            if (released) return;
            released = true;
            client.release(destroy || undefined);
        };
        const onSessionError = (error: NodeJS.ErrnoException) => {
            sessionLost = true;
            this.logger.warn(
                `[BOOKING-CLAIM] session lost clinicId=${clinicId} code=${error.code || 'UNKNOWN'}`,
            );
            controller.abort(new ClaimDeferError('session_lost', 'Booking claim session lost'));
        };
        const onExternalAbort = () => controller.abort(
            new ClaimDeferError('session_lost', 'Claim request aborted'),
        );

        client.on('error', onSessionError);
        externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
        if (externalSignal?.aborted) onExternalAbort();

        let callbackResult!: T;
        let callbackError: unknown;
        try {
            let result;
            try {
                result = await client.query<{ acquired: boolean }>(
                    'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
                    [lockKey.toString()],
                );
            } catch (error) {
                throw new ClaimDeferError(
                    'claim_error',
                    'Booking advisory claim query failed',
                    error,
                );
            }

            if (result.rows[0]?.acquired !== true) {
                throw new ClaimDeferError(
                    'lock_occupied',
                    'Booking advisory claim is held by another executor',
                );
            }
            lockAcquired = true;
            this.logger.debug(`[BOOKING-CLAIM] acquired clinicId=${clinicId}`);

            try {
                callbackResult = await callback(controller.signal);
            } catch (error) {
                callbackError = error;
            }

            if (sessionLost || controller.signal.aborted) {
                throw new ClaimDeferError(
                    'session_lost',
                    'Booking claim session became uncertain during the protected section',
                    callbackError,
                );
            }

            let unlock;
            try {
                unlock = await client.query<{ released: boolean }>(
                    'SELECT pg_advisory_unlock($1::bigint) AS released',
                    [lockKey.toString()],
                );
            } catch (error) {
                release(true);
                throw new ClaimDeferError(
                    'session_lost',
                    'Booking advisory unlock was ambiguous',
                    error,
                );
            }
            if (unlock.rows[0]?.released !== true) {
                release(true);
                throw new ClaimDeferError(
                    'session_lost',
                    'Booking advisory unlock was not confirmed',
                );
            }

            lockAcquired = false;
            release(false);
            if (callbackError) throw callbackError;
            return callbackResult;
        } catch (error) {
            if (!released) {
                if (lockAcquired && !sessionLost) {
                    try {
                        const unlock = await client.query<{ released: boolean }>(
                            'SELECT pg_advisory_unlock($1::bigint) AS released',
                            [lockKey.toString()],
                        );
                        release(unlock.rows[0]?.released !== true);
                    } catch {
                        release(true);
                    }
                } else {
                    release(sessionLost);
                }
            }
            throw error;
        } finally {
            client.removeListener('error', onSessionError);
            externalSignal?.removeEventListener('abort', onExternalAbort);
        }
    }

    async onApplicationShutdown(signal?: string): Promise<void> {
        this._draining = true;
        this.logger.log(
            `[BOOKING-CLAIM] draining signal=${signal || 'unknown'} active=${this._activeCallbacks}`,
        );
        if (this._activeCallbacks > 0) {
            await new Promise<void>((resolve) => {
                this.drainResolve = resolve;
            });
        }
        if (pool) {
            const activePool = pool;
            pool = null;
            await activePool.end();
        }
    }

    _resetDraining(): void {
        this._draining = false;
        this.drainResolve = null;
    }
}