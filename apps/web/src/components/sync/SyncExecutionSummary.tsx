import { ExecutionRun, summarizeExecutions } from './execution-summary';
import { SyncStatusHelp } from './SyncStatusHelp';

export function SyncExecutionSummary({ runs }: { runs: readonly ExecutionRun[] | null }) {
    const summary = runs === null ? null : summarizeExecutions(runs);
    const rows = summary ? [
        ['Sem pendências', summary.completed, 'text-emerald-700'],
        ['Com pendências', summary.warnings, 'text-amber-700'],
        ['Falhas', summary.failed, 'text-rose-700'],
        ['Em andamento', summary.running, 'text-sky-700'],
    ] as const : [];

    return (
        <section aria-label="Resultados da sincronização" className="relative z-10 hover:z-30 focus-within:z-30 bg-white/70 backdrop-blur-xl rounded-[32px] p-6 shadow-sm border border-slate-100/60 h-40 flex flex-col justify-between">
            <h3 className="text-[10px] font-black uppercase leading-tight tracking-widest text-slate-400">Execuções recentes</h3>
            {summary === null ? (
                <p className="mt-4 text-xs text-slate-500">Resumo indisponível</p>
            ) : summary.sampled === 0 ? (
                <p className="mt-4 text-xs text-slate-500">Nenhuma execução registrada</p>
            ) : (
                <div>
                    <p className="text-4xl font-black tracking-tighter text-slate-900 tabular-nums">{summary.sampled}<span className="sr-only"> execuções na amostra</span></p>
                    <details className="group">
                    <summary className="mt-1 flex cursor-pointer list-none items-center gap-1 text-[10px] font-bold text-slate-500 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 [&::-webkit-details-marker]:hidden">Ver resultados <span aria-hidden="true" className="transition-transform group-open:rotate-180">⌄</span></summary>
                    <div className="absolute left-0 top-full z-40 mt-2 w-72 max-w-[calc(100vw-3rem)] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
                    <p className="text-xs font-bold text-slate-900">Últimas {summary.sampled} execuções</p>
                    <p className="mt-1 text-[11px] text-slate-500">VISSMED e Doctoralia</p>
                    <dl className="mt-3 space-y-2 text-xs">
                        {rows.map(([label, count, color]) => (
                            <div key={label} className="flex items-center justify-between gap-2">
                                <dt className="flex items-center gap-1 text-slate-600"><span>{label}</span><SyncStatusHelp label={label} /></dt>
                                <dd className={`font-bold tabular-nums ${color}`}>{count}</dd>
                            </div>
                        ))}
                    </dl>
                    {summary.skipped > 0 && <p className="mt-2 text-[10px] text-slate-500">{summary.skipped} pulada(s), sem execução</p>}
                    {summary.other > 0 && <p className="mt-2 text-[10px] text-slate-500">{summary.other} com outro status</p>}
                    {summary.warnings > 0 && <a href="/sync#motivos-pendencias" className="mt-3 inline-block text-[11px] font-semibold text-amber-800 underline">Entender pendências</a>}
                    </div>
                    </details>
                </div>
            )}
        </section>
    );
}
