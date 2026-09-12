'use client';

import { useState } from 'react';
import { explainPendingReasons, PendingEvent } from './pending-reasons';

export function SyncPendingDetails({ startedAt, source, loadEvents }: {
    startedAt: string; source: string; loadEvents: () => Promise<PendingEvent[]>;
}) {
    const [events, setEvents] = useState<PendingEvent[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const reasons = events ? explainPendingReasons(events) : [];
    async function load() {
        setLoading(true); setError(false);
        try { setEvents(await loadEvents()); } catch { setError(true); }
        finally { setLoading(false); }
    }
    return <section id="motivos-pendencias" aria-label="Motivos das pendências" className="rounded-3xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-950 scroll-mt-6">
        <h2 className="font-bold">Por que houve pendências?</h2>
        <p className="mt-1">Execução mais recente com pendências na amostra: {source}, {new Date(startedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (Brasília).</p>
        <p className="mt-1 text-xs">Os motivos pertencem a essa execução e podem já ter sido resolvidos depois. Avisos não representam uma contagem de agendamentos com erro.</p>
        {events === null && <button type="button" onClick={load} disabled={loading} className="mt-3 rounded-lg border border-amber-500 px-3 py-2 font-semibold disabled:opacity-60">
            {loading ? 'Consultando motivos…' : error ? 'Tentar novamente' : 'Ver motivos e próximos passos'}
        </button>}
        {error && <p role="alert" className="mt-2">Não foi possível recuperar os eventos dessa execução. Tente novamente ou consulte o histórico.</p>}
        {events !== null && <div className="mt-4 space-y-4">
            {reasons.map(reason => <article key={reason.title} className="rounded-xl bg-white p-4">
                <h3 className="font-bold">{reason.title}</h3>
                <p className="mt-1">{reason.meaning}</p>
                <p className="mt-2"><strong>Próximo passo:</strong> {reason.next}</p>
                <details className="mt-3 text-xs"><summary className="cursor-pointer">Eventos relacionados ({reason.events.length} avisos, podem incluir repetições)</summary>
                    <ul className="mt-2 max-h-52 space-y-2 overflow-auto break-words">{reason.events.map((event, index) => <li key={index}>{event.message || 'Evento sem mensagem detalhada.'}</li>)}</ul>
                </details>
            </article>)}
            {reasons.length === 0 && <p>Essa execução tem pendências, mas os eventos disponíveis não permitem explicar o motivo com segurança. Solicite a análise do histórico à equipe responsável.</p>}
            <p className="text-xs">Outros avisos podem aparecer no histórico detalhado da execução.</p>
        </div>}
    </section>;
}
