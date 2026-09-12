'use client';

import { useId, useState } from 'react';

export const statusConcepts: Record<string, string> = {
    'Sem pendências': 'A execução terminou sem registrar falhas ou avisos. Isso não garante, por si só, que todos os cadastros estejam corretos.',
    'Com pendências': 'A execução terminou, mas algum item precisa de conferência. Consulte o motivo; isso não significa que todos os agendamentos falharam.',
    'Falhas': 'A execução terminou com falha. Algumas etapas podem ter sido realizadas antes do erro. Consulte o histórico para saber o que aconteceu.',
    'Em andamento': 'A execução ainda está sendo processada. O resultado será informado quando ela terminar.',
};

export function SyncStatusHelp({ label }: { label: string }) {
    const id = useId();
    const [open, setOpen] = useState(false);
    return <span className="relative inline-flex shrink-0" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
        <button type="button" aria-label={`Entenda: ${label}`} aria-expanded={open} aria-describedby={open ? id : undefined}
            onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}
            onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}
            className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 text-[10px] font-bold text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600">
            <span aria-hidden="true">i</span>
        </button>
        {open && <span id={id} role="tooltip" className="absolute left-0 top-full z-50 w-56 max-w-[70vw] rounded-lg bg-slate-900 p-3 text-xs font-normal leading-relaxed text-white shadow-lg">
            {statusConcepts[label]}
        </span>}
    </span>;
}
