'use strict';
/**
 * Coletores do harness:
 *  - snapshots periódicos do GET /metrics/doctoralia-baseline (via HTTP autenticado)
 *  - RSS do processo da API via /proc/<pid>/status (o heap/event-loop lag vem do
 *    sidecar preload — ver preload-lag.js)
 *  - estatísticas do Postgres de teste (pg_stat_activity/pg_stat_database e,
 *    quando disponível, pg_stat_statements)
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

class Collector {
    constructor({ apiBase, token, apiPid, dbUrl, lagFile, intervalMs = 5000 }) {
        this.apiBase = apiBase;
        this.token = token;
        this.apiPid = apiPid;
        this.dbUrl = dbUrl;
        this.lagFile = lagFile;
        this.intervalMs = intervalMs;
        this.baselineSnapshots = [];
        this.processSamples = [];
        this.pgSamples = [];
        this.errors = [];
        this._timer = null;
        this._prevXact = null;
    }

    start() {
        this._timer = setInterval(() => { this.sampleOnce().catch(e => this.errors.push(String(e.message))); }, this.intervalMs);
    }

    async stop() {
        if (this._timer) clearInterval(this._timer);
        await this.sampleOnce().catch(e => this.errors.push(String(e.message)));
    }

    async sampleOnce() {
        const ts = Date.now();
        const [baseline, proc, pg] = await Promise.all([
            this.fetchBaseline().catch(e => ({ error: String(e.message) })),
            Promise.resolve(this.sampleProcess()),
            this.samplePg().catch(e => ({ error: String(e.message) })),
        ]);
        this.baselineSnapshots.push({ ts, baseline });
        this.processSamples.push({ ts, ...proc });
        this.pgSamples.push({ ts, ...pg });
    }

    async fetchBaseline() {
        const res = await fetch(`${this.apiBase}/metrics/doctoralia-baseline`, {
            headers: { authorization: `Bearer ${this.token}` },
        });
        if (!res.ok) throw new Error(`baseline HTTP ${res.status}`);
        return res.json();
    }

    sampleProcess() {
        try {
            const status = fs.readFileSync(`/proc/${this.apiPid}/status`, 'utf8');
            const rssKb = Number(status.match(/^VmRSS:\s+(\d+)\skB/m)?.[1] ?? 0);
            return { rssBytes: rssKb * 1024 };
        } catch (e) {
            return { rssBytes: null, procError: String(e.message) };
        }
    }

    async samplePg() {
        const client = new Client({ connectionString: this.dbUrl });
        await client.connect();
        try {
            const act = await client.query(
                `SELECT count(*)::int AS total,
                        count(*) FILTER (WHERE state = 'active')::int AS active,
                        count(*) FILTER (WHERE wait_event_type IS NOT NULL AND state='active')::int AS waiting
                 FROM pg_stat_activity WHERE datname = current_database()`);
            const db = await client.query(
                `SELECT xact_commit + xact_rollback AS xacts, blks_hit, blks_read
                 FROM pg_stat_database WHERE datname = current_database()`);
            const xacts = Number(db.rows[0].xacts);
            let qps = null;
            if (this._prevXact !== null) {
                qps = Math.max(0, (xacts - this._prevXact.xacts) / ((Date.now() - this._prevXact.ts) / 1000));
            }
            this._prevXact = { xacts, ts: Date.now() };
            let slowQueries = null;
            try {
                const slow = await client.query(
                    `SELECT left(query, 120) AS query, calls, round(mean_exec_time::numeric, 2) AS mean_ms,
                            round(max_exec_time::numeric, 2) AS max_ms
                     FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 5`);
                slowQueries = slow.rows;
            } catch { /* extensão indisponível — limitação registrada no relatório */ }
            return {
                connections: act.rows[0],
                qps: qps === null ? null : Math.round(qps * 10) / 10,
                slowQueries,
            };
        } finally {
            await client.end();
        }
    }

    readLagSamples() {
        try {
            return fs.readFileSync(this.lagFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
        } catch { return []; }
    }
}

module.exports = { Collector };
