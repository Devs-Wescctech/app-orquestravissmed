/**
 * Task 223 — PostgreSQL integration tests for BookingClaimService.
 *
 * Requires a real PostgreSQL database.  Gated behind two env vars so that CI
 * without a DB skips the entire suite:
 *
 *   BOOKING_CLAIM_PG_TESTS=true
 *   DATABASE_URL=postgresql://user:pass@host:port/db
 *
 * Run focused:
 *   BOOKING_CLAIM_PG_TESTS=true DATABASE_URL=... \
 *     npx jest --testPathPatterns booking-claim.postgres
 *
 * The external pool used for cross-client assertions also passes the URL
 * unchanged so that SSL is preserved from the URL (matching the service's
 * own poolConfig which does not set cfg.ssl).
 */

import { Pool, PoolClient, PoolConfig } from 'pg';
import { BookingClaimService, ClaimDeferError, computeLockKey } from './booking-claim.service';

const ENABLED =
    !!process.env.DATABASE_URL && process.env.BOOKING_CLAIM_PG_TESTS === 'true';

const describeIfEnabled = ENABLED ? describe : describe.skip;

// ─── External pool helper (no explicit ssl — URL carries it) ──────────────────

function buildExternalPool(): Pool {
    // Pass the URL unchanged; pg parses sslmode from the connection string.
    // We do NOT set cfg.ssl to stay consistent with the service's own config.
    const cfg: PoolConfig = {
        connectionString: process.env.DATABASE_URL!,
        max: 3,
        idleTimeoutMillis: 5_000,
        connectionTimeoutMillis: 3_000,
    };
    return new Pool(cfg);
}

/**
 * Attempts pg_try_advisory_lock on a fresh client from an external pool.
 * Returns true if the lock was successfully acquired (meaning nobody else
 * holds it), false if the lock is already taken.
 * Immediately releases the lock if acquired so it does not linger.
 */
async function tryLockExternal(pool: Pool, lockKey: bigint): Promise<boolean> {
    const client = await pool.connect();
    try {
        const res = await client.query<{ acquired: boolean }>(
            'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
            [lockKey.toString()],
        );
        const acquired = res.rows[0]?.acquired === true;
        if (acquired) {
            await client.query(
                'SELECT pg_advisory_unlock($1::bigint)',
                [lockKey.toString()],
            );
        }
        return acquired;
    } finally {
        client.release();
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describeIfEnabled('BookingClaimService (PostgreSQL integration)', () => {
    let service: BookingClaimService;
    let externalPool: Pool;

    beforeAll(() => {
        externalPool = buildExternalPool();
    });

    afterAll(async () => {
        await externalPool.end();
    });

    beforeEach(() => {
        service = new BookingClaimService();
    });

    afterEach(async () => {
        await service.onApplicationShutdown('test').catch(() => {});
        service._resetDraining();
    });

    // ── Lock key integrity ────────────────────────────────────────────────────

    it('lockKey decimal is accepted by pg_try_advisory_lock without overflow', async () => {
        const lockKey = computeLockKey('pg-keycheck-clinic', 'pg-keycheck-booking');
        const client = await externalPool.connect();
        try {
            const res = await client.query<{ acquired: boolean; parsed_key: string }>(
                'SELECT pg_try_advisory_lock($1::bigint) AS acquired, $1::bigint AS parsed_key',
                [lockKey.toString()],
            );
            const parsedKey = res.rows[0]?.parsed_key;
            const acquired = res.rows[0]?.acquired === true;
            // Postgres must echo back the same decimal string
            expect(parsedKey).toBe(lockKey.toString());
            if (acquired) {
                await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey.toString()]);
            }
        } finally {
            client.release();
        }
    });

    // ── Lock is visible cross-client while held ───────────────────────────────

    it('holds advisory lock visible to an external client during callback, releases after', async () => {
        const clinicId = `pg-hold-clinic-${Date.now()}`;
        const bookingId = `pg-hold-booking-${Date.now()}`;
        const lockKey = computeLockKey(clinicId, bookingId);

        let couldLockDuring = true;
        let couldLockAfter = false;

        await service.withClaim(clinicId, bookingId, async () => {
            // External session must NOT be able to acquire the same lock
            couldLockDuring = await tryLockExternal(externalPool, lockKey);
            return 'held';
        });

        // After callback: lock must be released
        couldLockAfter = await tryLockExternal(externalPool, lockKey);

        expect(couldLockDuring).toBe(false); // held by service
        expect(couldLockAfter).toBe(true);   // released after callback
    });

    // ── lock_occupied from external holder ────────────────────────────────────

    it('returns lock_occupied when another pg session holds the lock', async () => {
        const clinicId = `pg-occ-clinic-${Date.now()}`;
        const bookingId = `pg-occ-booking-${Date.now()}`;
        const lockKey = computeLockKey(clinicId, bookingId);

        // Use blocking (not try) advisory lock on the external client so it is
        // guaranteed to be held before withClaim is called.
        const externalClient: PoolClient = await externalPool.connect();
        try {
            await externalClient.query(
                'SELECT pg_advisory_lock($1::bigint)',
                [lockKey.toString()],
            );

            await expect(
                service.withClaim(clinicId, bookingId, async () => 'should not run'),
            ).rejects.toMatchObject({ name: 'ClaimDeferError', reason: 'lock_occupied' });
        } finally {
            await externalClient.query(
                'SELECT pg_advisory_unlock($1::bigint)',
                [lockKey.toString()],
            ).catch(() => {});
            externalClient.release();
        }
    });

    // ── Worker mode retries lock_occupied and eventually acquires ─────────────

    it('worker mode retries lock_occupied and acquires once external session releases', async () => {
        const clinicId = `pg-worker-clinic-${Date.now()}`;
        const bookingId = `pg-worker-booking-${Date.now()}`;
        const lockKey = computeLockKey(clinicId, bookingId);

        // Hold the lock externally for a brief period then release it
        const externalClient: PoolClient = await externalPool.connect();
        await externalClient.query('SELECT pg_advisory_lock($1::bigint)', [lockKey.toString()]);
        let externalReleased = false;

        // Release external lock after 300ms
        const releaseDone = new Promise<void>((resolve) => {
            setTimeout(async () => {
                try {
                    await externalClient.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey.toString()]);
                } finally {
                    externalClient.release();
                    externalReleased = true;
                    resolve();
                }
            }, 300);
        });

        try {
            const result = await service.withClaim(
                clinicId, bookingId, async () => 'acquired',
                { mode: 'worker', maxWaitMs: 5_000 },
            );
            expect(result).toBe('acquired');
            await releaseDone;
        } finally {
            if (!externalReleased) {
                await releaseDone;
            }
        }
    }, 10_000);

    // ── Concurrent different keys do not interfere ────────────────────────────

    it('two concurrent claims on different keys succeed independently', async () => {
        const results: string[] = [];

        await Promise.all([
            service.withClaim(`pg-concurrent-A-${Date.now()}`, `pg-bk-A-${Date.now()}`, async () => {
                await new Promise(r => setTimeout(r, 20));
                results.push('A');
                return 'A';
            }),
            service.withClaim(`pg-concurrent-B-${Date.now()}`, `pg-bk-B-${Date.now()}`, async () => {
                await new Promise(r => setTimeout(r, 10));
                results.push('B');
                return 'B';
            }),
        ]);

        expect(results).toContain('A');
        expect(results).toContain('B');
    });

    // ── Sequential claims on same key ─────────────────────────────────────────

    it('second claim on the same key succeeds after the first is released', async () => {
        const clinicId = `pg-seq-clinic-${Date.now()}`;
        const bookingId = `pg-seq-booking-${Date.now()}`;

        const r1 = await service.withClaim(clinicId, bookingId, async () => 'first');
        const r2 = await service.withClaim(clinicId, bookingId, async () => 'second');

        expect(r1).toBe('first');
        expect(r2).toBe('second');
    });

    // ── Callback error releases lock ──────────────────────────────────────────

    it('releases advisory lock even when callback throws', async () => {
        const clinicId = `pg-throw-clinic-${Date.now()}`;
        const bookingId = `pg-throw-booking-${Date.now()}`;
        const lockKey = computeLockKey(clinicId, bookingId);

        try {
            await service.withClaim(clinicId, bookingId, async () => {
                throw new Error('intentional callback error');
            });
        } catch { /* expected */ }

        // After the throw the lock must be released
        const canAcquire = await tryLockExternal(externalPool, lockKey);
        expect(canAcquire).toBe(true);
    });

    // ── application_name is set on pool connections ───────────────────────────

    it('connections carry application_name vismed-booking-claims', async () => {
        let appName: string | null = null;
        const externalClient = await externalPool.connect();
        try {
            await service.withClaim(
                `pg-appname-clinic-${Date.now()}`,
                `pg-appname-booking-${Date.now()}`,
                async () => {
                    // Query pg_stat_activity from the external connection
                    const res = await externalClient.query<{ application_name: string }>(`
                        SELECT application_name
                        FROM pg_stat_activity
                        WHERE application_name = 'vismed-booking-claims'
                        LIMIT 1
                    `);
                    appName = res.rows[0]?.application_name ?? null;
                    return 'checked';
                },
            );
        } finally {
            externalClient.release();
        }

        expect(appName).toBe('vismed-booking-claims');
    });

    // ── Draining ──────────────────────────────────────────────────────────────

    it('refuses new claims when draining', async () => {
        (service as any)._draining = true;

        await expect(
            service.withClaim('pg-drain-clinic', 'pg-drain-booking', async () => 'x'),
        ).rejects.toMatchObject({ reason: 'draining' });
    });

    // ── onApplicationShutdown ─────────────────────────────────────────────────

    it('onApplicationShutdown waits for active callbacks then refuses new ones', async () => {
        let releaseCallback!: () => void;

        const claimDone = service.withClaim(
            `pg-shutdown-clinic-${Date.now()}`,
            `pg-shutdown-booking-${Date.now()}`,
            async () => {
                await new Promise<void>(r => { releaseCallback = r; });
                return 'done';
            },
        );

        // Give callback time to start
        await new Promise(r => setTimeout(r, 50));
        expect(service.draining).toBe(false);

        const shutdownPromise = service.onApplicationShutdown('SIGTERM');
        expect(service.draining).toBe(true);

        // Finish the callback
        releaseCallback();
        await claimDone;
        await shutdownPromise;

        // New claims must now be refused
        await expect(
            service.withClaim('pg-post-shutdown', 'pg-post-booking', async () => 'x'),
        ).rejects.toMatchObject({ reason: 'draining' });
    }, 10_000);
});
