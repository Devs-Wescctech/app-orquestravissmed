'use strict';
/**
 * Sidecar de observabilidade injetado via NODE_OPTIONS="--require ..." no
 * processo da API sob teste (SEM tocar código de produção).
 * Amostra event-loop lag (perf_hooks.monitorEventLoopDelay) + heap/RSS a cada
 * LOADTEST_LAG_INTERVAL_MS (default 5000ms) e grava JSON-lines em LOADTEST_LAG_FILE.
 */
const { monitorEventLoopDelay } = require('node:perf_hooks');
const fs = require('node:fs');

const file = process.env.LOADTEST_LAG_FILE;
if (file) {
    const intervalMs = Number(process.env.LOADTEST_LAG_INTERVAL_MS || 5000);
    const h = monitorEventLoopDelay({ resolution: 20 });
    h.enable();
    const timer = setInterval(() => {
        const mem = process.memoryUsage();
        const line = JSON.stringify({
            ts: Date.now(),
            elDelayMeanMs: h.mean / 1e6,
            elDelayP95Ms: h.percentile(95) / 1e6,
            elDelayMaxMs: h.max / 1e6,
            rssBytes: mem.rss,
            heapUsedBytes: mem.heapUsed,
            heapTotalBytes: mem.heapTotal,
        });
        h.reset();
        fs.appendFile(file, line + '\n', () => {});
    }, intervalMs);
    timer.unref();
}
