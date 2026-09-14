import { conflictExplanation, type ConflictDetails } from '@/lib/booking-conflict-details';

export function BookingConflictDetails({ data }: { data?: ConflictDetails }) {
    const related = data ? Array.from(new Map([...data.overlaps.flatMap(b => b.relatedBookings), ...data.sameNameBookings].map(b => [b.id, b])).values()) : [];
    return <div className="space-y-2 text-xs" aria-live="polite">
        {conflictExplanation(data).map(line => <p key={line}>{line}</p>)}
        {data && <p className="text-[10px] text-amber-700">Consulta em {new Date(data.checkedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (Brasília).</p>}
        {related.length > 0 && <details className="rounded-xl border border-amber-200 bg-white/70 p-3">
            <summary className="cursor-pointer font-bold">Ver agendamentos relacionados ({related.length})</summary>
            <ul className="mt-2 max-h-48 overflow-y-auto space-y-2">
                {related.map(b => <li key={b.id} className="border-t border-amber-100 pt-2">
                    <p className="font-semibold">{b.patientName || 'Paciente não informado'}</p>
                    <p>{new Date(b.startAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} — {new Date(b.endAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}</p>
                    <p>{b.status === 'CANCELLED' ? 'Cancelado' : b.synchronized ? 'Sincronização confirmada' : 'Sem confirmação de sincronização'}</p>
                </li>)}
            </ul>
        </details>}
        <p>Confira as associações antes de liberar ou movimentar horários. Esta consulta não altera agendamentos.</p>
    </div>;
}
