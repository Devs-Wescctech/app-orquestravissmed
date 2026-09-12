export interface ExecutionRun { status: string }

/** Same sample on both dashboards; the API returns newest runs first. */
export function summarizeExecutions(runs: readonly ExecutionRun[]) {
    const sample = runs.slice(0, 10);
    const counts = { completed: 0, warnings: 0, failed: 0, running: 0, skipped: 0, other: 0 };
    for (const run of sample) {
        switch (run.status) {
            case 'completed': case 'success': counts.completed++; break;
            case 'completed_with_warnings': case 'partially': case 'warning': counts.warnings++; break;
            case 'failed': case 'error': counts.failed++; break;
            case 'running': counts.running++; break;
            case 'skipped': counts.skipped++; break;
            default: counts.other++;
        }
    }
    return { sampled: sample.length, ...counts };
}
