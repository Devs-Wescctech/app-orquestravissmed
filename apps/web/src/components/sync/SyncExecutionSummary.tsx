import { ExecutionRun, summarizeExecutions } from './execution-summary';

export function SyncExecutionSummary({ runs }: { runs: readonly ExecutionRun[] | null }) {
    const summary = runs === null ? null : summarizeExecutions(runs);
    const rows = summary ? [
        ['Sem pendências', summary.completed, 'text-emerald-700'],
        ['Com pendências', summary.warnings, 'text-amber-700'],
        ['Falhas', summary.failed, 'text-rose-700'],
        ['Em andamento', summary.running, 'text-sky-700'],
    ] as const : [];

    return (
        <section aria-label="Resultados da sincronização" className="bg-white/70 backdrop-blur-xl rounded-[32px] p-4 shadow-sm border border-slate-100/60 min-h-40">
            <h3 className="text-xs font-bold text-slate-900">Execuções recentes</h3>
            {summary === null ? (
                <p className="mt-4 text-xs text-slate-500">Resumo indisponível</p>
            ) : summary.sampled === 0 ? (
                <p className="mt-4 text-xs text-slate-500">Nenhuma execução registrada</p>
            ) : (
                <>
                    <p className="mt-1 text-[10px] text-slate-500">Últimas {summary.sampled} · VISSMED e Doctoralia</p>
                    <dl className="mt-3 space-y-1 text-[11px]">
                        {rows.map(([label, count, color]) => (
                            <div key={label} className="flex items-center justify-between gap-2">
                                <dt className="text-slate-600">{label}</dt>
                                <dd className={`font-bold tabular-nums ${color}`}>{count}</dd>
                            </div>
                        ))}
                    </dl>
                    {summary.skipped > 0 && <p className="mt-2 text-[10px] text-slate-500">{summary.skipped} pulada(s), sem execução</p>}
                    {summary.other > 0 && <p className="mt-2 text-[10px] text-slate-500">{summary.other} com outro status</p>}
                </>
            )}
        </section>
    );
}
