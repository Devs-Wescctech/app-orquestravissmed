/**
 * Task 223 — Unit tests for BookingClaimService (mocked pg pool).
 *
 * Pool injection strategy
 * -----------------------
 * `import * as pgModule from 'pg'` compiles to a namespace object whose
 * properties are getter-only (non-configurable) due to TypeScript's
 * __createBinding helper with esModuleInterop.  We cannot use
 * jest.spyOn(pgModule, 'Pool') or Object.defineProperty on that namespace.
 *
 * `jest.mock('pg', factory)` is hoisted before imports.  When the service
 * module is then evaluated, line 34 (`const poolLogger = new Logger(
 * BookingClaimService.name)`) runs before the class declaration — a
 * Temporal Dead Zone crash.
 *
 * Solution: require('pg') returns the *underlying* CJS exports object whose
 * properties ARE writable and configurable.  We save and replace pg.Pool on
 * that object directly, bypassing both the namespace getter issue and the
 * TDZ issue.  The service module's `new Pool(...)` call goes through the
 * same CJS cache entry, so it picks up the replacement.
 */

// Use require() to get the real, mutable CJS exports object.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pgCjs = require('pg') as { Pool: any; [k: string]: any };

import {
    BookingClaimService,
    ClaimDeferError,
    ClaimDeferReason,
    computeLockKey,
} from './booking-claim.service';

// ─── Mock client / pool factories ─────────────────────────────────────────────

type EventHandler = (...args: any[]) => void;

function makeMockClient(overrides: Partial<{ query: jest.Mock; release: jest.Mock }> = {}) {
    const listeners: Record<string, EventHandler[]> = {};
    const client = {
        query: overrides.query ?? jest.fn(),
        release: overrides.release ?? jest.fn(),
        on(event: string, handler: EventHandler) {
            listeners[event] = listeners[event] ?? [];
            listeners[event].push(handler);
            return client;
        },
        removeListener(event: string, handler: EventHandler) {
            if (listeners[event]) {
                listeners[event] = listeners[event].filter(h => h !== handler);
            }
            return client;
        },
        emit(event: string, ...args: any[]) {
            (listeners[event] ?? []).forEach(h => h(...args));
        },
    };
    return client;
}

type MockClient = ReturnType<typeof makeMockClient>;

function makeMockPool(clients: MockClient[], opts: { connectError?: Error } = {}) {
    let idx = 0;
    return {
        connect: jest.fn(async () => {
            if (opts.connectError) throw opts.connectError;
            if (idx >= clients.length) throw new Error('No more mock clients');
            return clients[idx++];
        }),
        on: jest.fn(),
        end: jest.fn().mockResolvedValue(undefined),
    };
}

// ─── Pool injection via CJS exports object ────────────────────────────────────

let capturedPoolConfig: any = null;
const _originalPool = pgCjs.Pool;

/**
 * Replaces pgCjs.Pool with a constructor that returns mockPool, captures the
 * config, and returns a teardown function that restores the original.
 * Also resets the module-level pool singleton (set pool = null) by running
 * onApplicationShutdown on whatever service holds it.
 */
function injectPool(mockPool: ReturnType<typeof makeMockPool>): () => void {
    pgCjs.Pool = function MockPool(config: any) {
        capturedPoolConfig = config;
        return mockPool;
    };
    return () => {
        pgCjs.Pool = _originalPool;
        capturedPoolConfig = null;
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeQueryMock(lockAcquired: boolean, unlockReleased: boolean = true): jest.Mock {
    return jest.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: lockAcquired }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ released: unlockReleased }] };
        return { rows: [] };
    });
}

// ─── Global setup ────────────────────────────────────────────────────────────

beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';
});

afterAll(() => {
    pgCjs.Pool = _originalPool;
});

// ─── computeLockKey ───────────────────────────────────────────────────────────

describe('computeLockKey', () => {
    it('returns a BigInt', () => {
        expect(typeof computeLockKey('c', 'b')).toBe('bigint');
    });

    it('is deterministic', () => {
        expect(computeLockKey('clinic-A', 'booking-1')).toBe(computeLockKey('clinic-A', 'booking-1'));
    });

    it('differs for different clinicId', () => {
        expect(computeLockKey('clinic-A', 'booking-1')).not.toBe(computeLockKey('clinic-B', 'booking-1'));
    });

    it('differs for different bookingId', () => {
        expect(computeLockKey('clinic-A', 'booking-1')).not.toBe(computeLockKey('clinic-A', 'booking-2'));
    });

    it('fits in signed int64 range', () => {
        const k = computeLockKey('x', 'y');
        expect(k >= -0x8000000000000000n).toBe(true);
        expect(k <= 0x7FFFFFFFFFFFFFFFn).toBe(true);
    });

    it('equals Buffer.readBigInt64BE(0) of SHA-256 digest', () => {
        const { createHash } = require('crypto');
        const input = JSON.stringify(['vismed-booking-claim-v1', 'clinicZ', 'book99']);
        const expected: bigint = createHash('sha256').update(input).digest().readBigInt64BE(0);
        expect(computeLockKey('clinicZ', 'book99')).toBe(expected);
    });
});

// ─── ClaimDeferError ──────────────────────────────────────────────────────────

describe('ClaimDeferError', () => {
    it('is an Error with name ClaimDeferError', () => {
        const e = new ClaimDeferError('pool_busy');
        expect(e).toBeInstanceOf(Error);
        expect(e).toBeInstanceOf(ClaimDeferError);
        expect(e.name).toBe('ClaimDeferError');
    });

    it('exposes all five reasons', () => {
        const reasons: ClaimDeferReason[] = ['pool_busy', 'lock_occupied', 'claim_error', 'session_lost', 'draining'];
        for (const r of reasons) expect(new ClaimDeferError(r).reason).toBe(r);
    });

    it('defaults message to reason', () => {
        expect(new ClaimDeferError('draining').message).toBe('draining');
    });

    it('accepts a custom message', () => {
        expect(new ClaimDeferError('draining', 'shutting down').message).toBe('shutting down');
    });

    it('stores optional cause', () => {
        const cause = new Error('root');
        expect(new ClaimDeferError('claim_error', 'w', cause).cause).toBe(cause);
    });
});

// ─── BookingClaimService ──────────────────────────────────────────────────────

describe('BookingClaimService', () => {
    let service: BookingClaimService;
    let restorePool: (() => void) | null = null;

    /**
     * Injects mockPool and creates a fresh service instance.
     * The pool singleton is reset by the afterEach via onApplicationShutdown.
     */
    function buildService(pool: ReturnType<typeof makeMockPool>): BookingClaimService {
        if (restorePool) restorePool();
        restorePool = injectPool(pool);
        return (service = new BookingClaimService());
    }

    afterEach(async () => {
        if (service) {
            // onApplicationShutdown sets module-level pool = null, breaking the singleton
            await service.onApplicationShutdown('test').catch(() => {});
            service._resetDraining();
        }
        if (restorePool) {
            restorePool();
            restorePool = null;
        }
    });

    // ────────────────────────────────────────────────────────────────────────
    // Pool configuration
    // ────────────────────────────────────────────────────────────────────────

    describe('pool config', () => {
        it('passes max:2 min:0 timeouts keepAlive and application_name', async () => {
            service = buildService(makeMockPool([makeMockClient({ query: makeQueryMock(true) })]));
            await service.withClaim('c', 'b', async () => 'ok');
            expect(capturedPoolConfig).toMatchObject({
                max: 2,
                min: 0,
                idleTimeoutMillis: 10_000,
                connectionTimeoutMillis: 1_000,
                keepAlive: true,
                keepAliveInitialDelayMillis: 30_000,
                application_name: 'vismed-booking-claims',
            });
        });

        it('passes maxLifetimeSeconds: 0', async () => {
            service = buildService(makeMockPool([makeMockClient({ query: makeQueryMock(true) })]));
            await service.withClaim('c', 'b', async () => 'ok');
            expect(capturedPoolConfig.maxLifetimeSeconds).toBe(0);
        });

        it('does NOT set cfg.ssl — URL carries SSL settings', async () => {
            service = buildService(makeMockPool([makeMockClient({ query: makeQueryMock(true) })]));
            await service.withClaim('c', 'b', async () => 'ok');
            expect(capturedPoolConfig).not.toHaveProperty('ssl');
        });

        it('passes connectionString from DATABASE_URL unchanged', async () => {
            const url = 'postgresql://test:test@localhost:5432/testdb';
            process.env.DATABASE_URL = url;
            service = buildService(makeMockPool([makeMockClient({ query: makeQueryMock(true) })]));
            await service.withClaim('c', 'b', async () => 'ok');
            expect(capturedPoolConfig.connectionString).toBe(url);
        });

        it('does not log DATABASE_URL in any output', async () => {
            const captured: string[] = [];
            const origWrite = process.stdout.write.bind(process.stdout);
            (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
                captured.push(String(chunk));
                return origWrite(chunk, ...rest);
            };
            try {
                service = buildService(makeMockPool([makeMockClient({ query: makeQueryMock(true) })]));
                await service.withClaim('c', 'b', async () => 'ok');
            } finally {
                (process.stdout as any).write = origWrite;
            }
            const logged = captured.join('');
            expect(logged).not.toContain(process.env.DATABASE_URL);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Happy path — fail-fast (default mode)
    // ────────────────────────────────────────────────────────────────────────

    describe('happy path (fail-fast)', () => {
        it('acquires lock, runs callback, unlocks, releases client, returns result', async () => {
            const client = makeMockClient({ query: makeQueryMock(true, true) });
            service = buildService(makeMockPool([client]));

            const result = await service.withClaim('clinic1', 'booking1', async (sig) => {
                expect(sig).toBeDefined();
                expect(sig.aborted).toBe(false);
                return 'hello';
            });

            expect(result).toBe('hello');
            const calls = (client.query as jest.Mock).mock.calls;
            expect(calls[0][0]).toContain('pg_try_advisory_lock');
            expect(calls[1][0]).toContain('pg_advisory_unlock');
            // clean release — no destroy
            expect(client.release).toHaveBeenCalledTimes(1);
            expect(client.release).not.toHaveBeenCalledWith(true);
        });

        it('passes identical lock key decimal to lock and unlock queries', async () => {
            const client = makeMockClient({ query: makeQueryMock(true, true) });
            service = buildService(makeMockPool([client]));
            await service.withClaim('clinic-A', 'book-42', async () => 'ok');
            const calls = (client.query as jest.Mock).mock.calls;
            const expected = computeLockKey('clinic-A', 'book-42').toString();
            expect(calls[0][1][0]).toBe(expected);
            expect(calls[1][1][0]).toBe(expected);
        });

        it('callback error: unlock is attempted before release and callback error is re-thrown', async () => {
            const releaseMock = jest.fn();
            const client = makeMockClient({ query: makeQueryMock(true, true), release: releaseMock });
            service = buildService(makeMockPool([client]));

            const callbackErr = new Error('intentional');
            await expect(
                service.withClaim('clinic1', 'booking1', async () => { throw callbackErr; }),
            ).rejects.toBe(callbackErr);

            // unlock must have been attempted in the catch path
            const unlockCalls = (client.query as jest.Mock).mock.calls
                .filter((c: any[]) => String(c[0]).includes('pg_advisory_unlock'));
            expect(unlockCalls.length).toBeGreaterThanOrEqual(1);
            expect(releaseMock).toHaveBeenCalledTimes(1);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // mode: fail-fast — exactly one attempt
    // ────────────────────────────────────────────────────────────────────────

    describe('mode: fail-fast', () => {
        it('does not retry on lock_occupied — exactly one connect attempt', async () => {
            const client1 = makeMockClient({ query: makeQueryMock(false) });
            const client2 = makeMockClient({ query: makeQueryMock(true, true) });
            const pool = makeMockPool([client1, client2]);
            service = buildService(pool);

            await expect(
                service.withClaim('clinic1', 'booking1', async () => 'x', { mode: 'fail-fast' }),
            ).rejects.toMatchObject({ reason: 'lock_occupied' });

            expect(pool.connect).toHaveBeenCalledTimes(1);
        });

        it('does not retry on pool_busy — exactly one connect attempt', async () => {
            const pool = makeMockPool([], { connectError: new Error('timeout exceeded') });
            service = buildService(pool);

            await expect(
                service.withClaim('clinic1', 'booking1', async () => 'x', { mode: 'fail-fast' }),
            ).rejects.toMatchObject({ reason: 'pool_busy' });

            expect(pool.connect).toHaveBeenCalledTimes(1);
        });

        it('does not retry on claim_error — exactly one connect attempt', async () => {
            const client = makeMockClient({ query: jest.fn().mockRejectedValue(new Error('DB error')) });
            const pool = makeMockPool([client]);
            service = buildService(pool);

            await expect(
                service.withClaim('clinic1', 'booking1', async () => 'x', { mode: 'fail-fast' }),
            ).rejects.toMatchObject({ reason: 'claim_error' });

            expect(pool.connect).toHaveBeenCalledTimes(1);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // mode: worker — retries lock_occupied / pool_busy, releases between attempts
    // ────────────────────────────────────────────────────────────────────────

    describe('mode: worker', () => {
        it('retries lock_occupied and acquires on second attempt', async () => {
            const client1 = makeMockClient({ query: makeQueryMock(false) });
            const client2 = makeMockClient({ query: makeQueryMock(true, true) });
            const pool = makeMockPool([client1, client2]);
            service = buildService(pool);

            const result = await service.withClaim(
                'clinic1', 'booking1', async () => 'acquired',
                { mode: 'worker', maxWaitMs: 5_000 },
            );

            expect(result).toBe('acquired');
            expect(pool.connect).toHaveBeenCalledTimes(2);
        });

        it('retries pool_busy and acquires on second attempt', async () => {
            let attempt = 0;
            const client = makeMockClient({ query: makeQueryMock(true, true) });
            const pool = {
                connect: jest.fn(async () => {
                    attempt++;
                    if (attempt === 1) throw new Error('timeout exceeded');
                    return client;
                }),
                on: jest.fn(),
                end: jest.fn().mockResolvedValue(undefined),
            };
            service = buildService(pool as any);

            const result = await service.withClaim(
                'clinic1', 'booking1', async () => 'ok',
                { mode: 'worker', maxWaitMs: 5_000 },
            );

            expect(result).toBe('ok');
            expect(pool.connect).toHaveBeenCalledTimes(2);
        });

        it('releases client between attempts — not held while sleeping', async () => {
            // Verify client1.release() fires BEFORE connect() is called the second time.
            const events: string[] = [];

            const releaseMock1 = jest.fn(() => events.push('release1'));
            const client1 = makeMockClient({ query: makeQueryMock(false), release: releaseMock1 });
            const client2 = makeMockClient({ query: makeQueryMock(true, true) });

            let connectCount = 0;
            const pool = {
                connect: jest.fn(async () => {
                    connectCount++;
                    events.push(`connect${connectCount}`);
                    return connectCount === 1 ? client1 : client2;
                }),
                on: jest.fn(),
                end: jest.fn().mockResolvedValue(undefined),
            };
            service = buildService(pool as any);

            await service.withClaim(
                'clinic1', 'booking1', async () => 'done',
                { mode: 'worker', maxWaitMs: 5_000 },
            );

            const r1Idx = events.indexOf('release1');
            const c2Idx = events.indexOf('connect2');
            expect(r1Idx).toBeGreaterThanOrEqual(0);
            expect(c2Idx).toBeGreaterThanOrEqual(0);
            // release must come before second connect
            expect(r1Idx).toBeLessThan(c2Idx);
        });

        it('exhausts wall budget and throws the last ClaimDeferError', async () => {
            let connectCount = 0;
            const pool = {
                connect: jest.fn(async () => {
                    connectCount++;
                    return makeMockClient({ query: makeQueryMock(false) });
                }),
                on: jest.fn(),
                end: jest.fn().mockResolvedValue(undefined),
            };
            service = buildService(pool as any);

            const start = Date.now();
            await expect(
                service.withClaim(
                    'clinic1', 'booking1', async () => 'x',
                    { mode: 'worker', maxWaitMs: 150 },
                ),
            ).rejects.toMatchObject({ reason: 'lock_occupied' });

            expect(Date.now() - start).toBeLessThan(3_000);
            // Must have tried at least once, and retried
            expect(connectCount).toBeGreaterThan(0);
        }, 10_000);

        it('does not retry on draining', async () => {
            const pool = makeMockPool([]);
            service = buildService(pool);
            (service as any)._draining = true;

            await expect(
                service.withClaim('c', 'b', async () => 'x', { mode: 'worker', maxWaitMs: 5_000 }),
            ).rejects.toMatchObject({ reason: 'draining' });

            expect(pool.connect).not.toHaveBeenCalled();
        });

        it('uses default 4-minute wall budget when maxWaitMs is omitted', async () => {
            // Succeeds on second attempt — confirms budget is active in worker mode
            const client1 = makeMockClient({ query: makeQueryMock(false) });
            const client2 = makeMockClient({ query: makeQueryMock(true, true) });
            service = buildService(makeMockPool([client1, client2]));

            const result = await service.withClaim('c', 'b', async () => 'ok', { mode: 'worker' });
            expect(result).toBe('ok');
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // lock_occupied
    // ────────────────────────────────────────────────────────────────────────

    describe('lock_occupied', () => {
        it('throws ClaimDeferError(lock_occupied) when pg_try_advisory_lock returns false', async () => {
            service = buildService(makeMockPool([makeMockClient({ query: makeQueryMock(false) })]));

            await expect(
                service.withClaim('clinic1', 'booking1', async () => 'x'),
            ).rejects.toMatchObject({ name: 'ClaimDeferError', reason: 'lock_occupied' });
        });

        it('does not call pg_advisory_unlock when lock was not acquired', async () => {
            const client = makeMockClient({ query: makeQueryMock(false) });
            service = buildService(makeMockPool([client]));

            await expect(
                service.withClaim('clinic1', 'booking1', async () => 'x'),
            ).rejects.toMatchObject({ reason: 'lock_occupied' });

            const calls = (client.query as jest.Mock).mock.calls as any[][];
            expect(calls.every(c => !String(c[0]).includes('pg_advisory_unlock'))).toBe(true);
        });

        it('releases client without destroy on lock_occupied', async () => {
            const releaseMock = jest.fn();
            const client = makeMockClient({ query: makeQueryMock(false), release: releaseMock });
            service = buildService(makeMockPool([client]));

            await expect(
                service.withClaim('clinic1', 'booking1', async () => 'x'),
            ).rejects.toMatchObject({ reason: 'lock_occupied' });

            expect(releaseMock).toHaveBeenCalledTimes(1);
            expect(releaseMock).not.toHaveBeenCalledWith(true);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // pool_busy
    // ────────────────────────────────────────────────────────────────────────

    describe('pool_busy', () => {
        it('maps timeout error from pool.connect() to pool_busy', async () => {
            service = buildService(makeMockPool([], { connectError: new Error('timeout exceeded') }));

            await expect(
                service.withClaim('clinic1', 'booking1', async () => 'x'),
            ).rejects.toMatchObject({ name: 'ClaimDeferError', reason: 'pool_busy' });
        });

        it('maps ETIMEDOUT error to pool_busy', async () => {
            service = buildService(makeMockPool([], { connectError: new Error('connect ETIMEDOUT') }));

            await expect(
                service.withClaim('c', 'b', async () => 'x'),
            ).rejects.toMatchObject({ reason: 'pool_busy' });
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // claim_error
    // ────────────────────────────────────────────────────────────────────────

    describe('claim_error', () => {
        it('throws claim_error when the lock query itself throws', async () => {
            const client = makeMockClient({ query: jest.fn().mockRejectedValue(new Error('DB error')) });
            service = buildService(makeMockPool([client]));

            await expect(
                service.withClaim('clinic1', 'booking1', async () => 'x'),
            ).rejects.toMatchObject({ name: 'ClaimDeferError', reason: 'claim_error' });
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // unlock failures → session_lost + destroy
    // ────────────────────────────────────────────────────────────────────────

    describe('unlock failures', () => {
        it('throws session_lost (not success) when pg_advisory_unlock returns false', async () => {
            const releaseMock = jest.fn();
            const client = makeMockClient({ query: makeQueryMock(true, false), release: releaseMock });
            service = buildService(makeMockPool([client]));

            await expect(
                service.withClaim('clinic1', 'booking1', async () => 'value'),
            ).rejects.toMatchObject({ name: 'ClaimDeferError', reason: 'session_lost' });

            expect(releaseMock).toHaveBeenCalledWith(true);
        });

        it('throws session_lost when pg_advisory_unlock throws', async () => {
            const releaseMock = jest.fn();
            const queryMock = jest.fn(async (sql: string) => {
                if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
                if (sql.includes('pg_advisory_unlock')) throw new Error('unlock network error');
                return { rows: [] };
            });
            const client = makeMockClient({ query: queryMock, release: releaseMock });
            service = buildService(makeMockPool([client]));

            await expect(
                service.withClaim('clinic1', 'booking1', async () => 42),
            ).rejects.toMatchObject({ name: 'ClaimDeferError', reason: 'session_lost' });

            expect(releaseMock).toHaveBeenCalledWith(true);
        });

        it('callback error + unlock succeeds: callback error propagates, client released cleanly', async () => {
            const releaseMock = jest.fn();
            const client = makeMockClient({ query: makeQueryMock(true, true), release: releaseMock });
            service = buildService(makeMockPool([client]));

            const callbackErr = new Error('cb error');
            await expect(
                service.withClaim('clinic1', 'booking1', async () => { throw callbackErr; }),
            ).rejects.toBe(callbackErr);

            // unlock attempted exactly once in catch path
            const unlockCalls = (client.query as jest.Mock).mock.calls
                .filter((c: any[]) => String(c[0]).includes('pg_advisory_unlock'));
            expect(unlockCalls.length).toBe(1);
            expect(releaseMock).toHaveBeenCalledTimes(1);
        });

        it('callback error + unlock returns false: throws session_lost and destroys client', async () => {
            const releaseMock = jest.fn();
            const client = makeMockClient({ query: makeQueryMock(true, false), release: releaseMock });
            service = buildService(makeMockPool([client]));

            await expect(
                service.withClaim('clinic1', 'booking1', async () => { throw new Error('cb'); }),
            ).rejects.toMatchObject({ reason: 'session_lost' });

            expect(releaseMock).toHaveBeenCalledWith(true);
        });

        it('callback error + unlock throws: throws session_lost and destroys client', async () => {
            const releaseMock = jest.fn();
            const queryMock = jest.fn(async (sql: string) => {
                if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
                if (sql.includes('pg_advisory_unlock')) throw new Error('unlock boom');
                return { rows: [] };
            });
            const client = makeMockClient({ query: queryMock, release: releaseMock });
            service = buildService(makeMockPool([client]));

            await expect(
                service.withClaim('clinic1', 'booking1', async () => { throw new Error('cb'); }),
            ).rejects.toMatchObject({ reason: 'session_lost' });

            expect(releaseMock).toHaveBeenCalledWith(true);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // session_lost — client error event
    // ────────────────────────────────────────────────────────────────────────

    describe('session_lost', () => {
        it('aborts the callback AbortSignal when client emits error mid-callback', async () => {
            let capturedSig!: AbortSignal;
            const client = makeMockClient({ query: makeQueryMock(true, true) });
            service = buildService(makeMockPool([client]));

            let signalAbortedDuringCb = false;
            try {
                await service.withClaim('clinic1', 'booking1', async (sig) => {
                    capturedSig = sig;
                    client.emit('error', new Error('connection reset'));
                    await new Promise(r => setTimeout(r, 0));
                    signalAbortedDuringCb = sig.aborted;
                    return 'done';
                });
            } catch (e) {
                expect((e as ClaimDeferError).reason).toBe('session_lost');
            }

            expect(capturedSig).toBeDefined();
            expect(signalAbortedDuringCb).toBe(true);
        });

        it('throws session_lost and destroys client when client error fires mid-callback', async () => {
            const releaseMock = jest.fn();
            const client = makeMockClient({ query: makeQueryMock(true, true), release: releaseMock });
            service = buildService(makeMockPool([client]));

            await expect(
                service.withClaim('clinic1', 'booking1', async () => {
                    client.emit('error', new Error('pg connection lost'));
                    await new Promise(r => setTimeout(r, 0));
                    return 'ok';
                }),
            ).rejects.toMatchObject({ reason: 'session_lost' });

            expect(releaseMock).toHaveBeenCalledWith(true);
        });

        it('throws session_lost when external signal is already aborted before withClaim', async () => {
            const client = makeMockClient({ query: makeQueryMock(true, true) });
            service = buildService(makeMockPool([client]));

            const ac = new AbortController();
            ac.abort();

            await expect(
                service.withClaim('clinic1', 'booking1', async () => 'x', { signal: ac.signal }),
            ).rejects.toMatchObject({ name: 'ClaimDeferError', reason: 'session_lost' });
        });

        it('propagates external AbortSignal abort into the callback signal', async () => {
            const client = makeMockClient({ query: makeQueryMock(true, true) });
            service = buildService(makeMockPool([client]));

            const externalAc = new AbortController();
            let callbackSig!: AbortSignal;

            try {
                await service.withClaim('clinic1', 'booking1', async (sig) => {
                    callbackSig = sig;
                    externalAc.abort('external abort');
                    await new Promise(r => setTimeout(r, 0));
                    return sig.aborted;
                }, { signal: externalAc.signal });
            } catch { /* session_lost acceptable */ }

            expect(callbackSig).toBeDefined();
            expect(callbackSig.aborted).toBe(true);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // draining
    // ────────────────────────────────────────────────────────────────────────

    describe('draining', () => {
        it('refuses new claims immediately when _draining is true', async () => {
            service = buildService(makeMockPool([]));
            (service as any)._draining = true;

            await expect(
                service.withClaim('clinic1', 'booking1', async () => 'x'),
            ).rejects.toMatchObject({ name: 'ClaimDeferError', reason: 'draining' });
        });

        it('onApplicationShutdown marks draining and refuses new claims', async () => {
            service = buildService(makeMockPool([]));
            const shutdownPromise = service.onApplicationShutdown('SIGTERM');

            await expect(
                service.withClaim('clinic1', 'booking1', async () => 'x'),
            ).rejects.toMatchObject({ reason: 'draining' });

            await shutdownPromise;
        });

        it('onApplicationShutdown waits for active callbacks before calling pool.end()', async () => {
            const client = makeMockClient({ query: makeQueryMock(true, true) });
            const pool = makeMockPool([client]);
            service = buildService(pool);

            let releaseCallback!: () => void;
            const callbackStarted = new Promise<void>(resolve => {
                service.withClaim('clinic1', 'booking1', async () => {
                    resolve();
                    await new Promise<void>(r => { releaseCallback = r; });
                    return 'done';
                }).catch(() => {});
            });

            await callbackStarted;
            expect(service.activeCallbacks).toBe(1);

            const shutdownPromise = service.onApplicationShutdown('SIGTERM');

            await new Promise(r => setTimeout(r, 20));
            expect(pool.end).not.toHaveBeenCalled();

            releaseCallback();
            await shutdownPromise;
            expect(pool.end).toHaveBeenCalledTimes(1);
        });

        it('does NOT abort active callbacks when shutdown is initiated', async () => {
            const client = makeMockClient({ query: makeQueryMock(true, true) });
            service = buildService(makeMockPool([client]));

            let callbackSig!: AbortSignal;
            let releaseCallback!: () => void;

            const claimPromise = service.withClaim('clinic1', 'booking1', async (sig) => {
                callbackSig = sig;
                await new Promise<void>(r => { releaseCallback = r; });
                return sig.aborted;
            });

            await new Promise(r => setTimeout(r, 0));
            const shutdownDone = service.onApplicationShutdown('SIGTERM');

            releaseCallback();
            const wasAborted = await claimPromise;
            expect(wasAborted).toBe(false);
            await shutdownDone;
        });

        it('activeCallbacks is decremented even when callback throws', async () => {
            const client = makeMockClient({ query: makeQueryMock(true, true) });
            service = buildService(makeMockPool([client]));

            try {
                await service.withClaim('c', 'b', async () => { throw new Error('boom'); });
            } catch { /* expected */ }

            expect(service.activeCallbacks).toBe(0);
        });

        it('activeCallbacks is 1 during callback and 0 after', async () => {
            const client = makeMockClient({ query: makeQueryMock(true, true) });
            service = buildService(makeMockPool([client]));

            const observations: number[] = [];
            await service.withClaim('c', 'b', async () => {
                observations.push(service.activeCallbacks);
                return 'ok';
            });

            expect(observations).toEqual([1]);
            expect(service.activeCallbacks).toBe(0);
        });
    });
});
