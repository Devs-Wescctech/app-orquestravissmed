'use client';

import { useState } from 'react';

export interface SyncReport {
    version: number;
    categories: Record<string, { verified: number; created: number; updated: number; unchanged: number; errors: number }>;
    stages: Array<{ name: string; durationMs: number }>;
    agendas: Record<string, number>;
    errors: number;
    warnings: number;
}

const labels: Record<string, string> = {
    facilities: 'Estabelecimentos', doctors: 'Profissionais', services: 'Serviços da clínica',
    insurances: 'Convênios da clínica', address_services: 'Serviços por endereço',
    catalog_services: 'Catálogo global de serviços', catalog_insurances: 'Catálogo global de convênios',
    initializing: 'Preparação', syncing_facilities: 'Estabelecimentos', syncing_doctors_services: 'Profissionais e endereços',
    running_matching_engine: 'Correspondências', push_to_doctoralia: 'Atualização de agendas e vínculos',
};

type AgendaEvent = { action?: string; entityType?: string; message?: string };

export function SyncRunReport({ report, events, loadEvents }: { report?: SyncReport; events?: AgendaEvent[]; loadEvents?: () => Promise<AgendaEvent[]> }) {
    const [loadedEvents, setLoadedEvents] = useState<AgendaEvent[] | null>(events ?? null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState(false);
    async function load() {
        if (!loadEvents || loading) return;
        setLoading(true); setLoadError(false);
        try { setLoadedEvents(await loadEvents()); }
        catch { setLoadError(true); }
        finally { setLoading(false); }
    }
    if (!report || report.version !== 2) return <p className="mt-2 text-xs text-slate-500">Contagem anterior: não distingue alterações reais.</p>;
    const emptyEvents = (loadedEvents || []).filter(e => e.entityType === 'SLOT_SYNC' && e.action === 'skipped_empty');
    return <details className="mt-3 text-xs text-slate-600 max-w-3xl">
        <summary className="cursor-pointer font-semibold">Ver composição, etapas e pendências</summary>
        <div className="overflow-x-auto mt-3">
            <table className="w-full text-left border-collapse">
                <caption className="text-left mb-2">Registros por categoria. Agendas são apresentadas separadamente.</caption>
                <thead><tr>{['Categoria', 'Verificados', 'Criados', 'Alterados', 'Inalterados', 'Erros'].map(label => <th className="p-2 border-b" key={label}>{label}</th>)}</tr></thead>
                <tbody>{Object.entries(report.categories).map(([name, c]) => <tr key={name}>
                    <th scope="row" className="p-2">{labels[name] || name}</th>
                    {[c.verified, c.created, c.updated, c.unchanged, c.errors].map((v, i) => <td className="p-2" key={i}>{v}</td>)}
                </tr>)}</tbody>
            </table>
        </div>
        {!report.categories.catalog_services && !report.categories.catalog_insurances && <p className="mt-2">Catálogos globais: sem itens processados neste ciclo. Consulte as etapas e pendências para distinguir dispensa por prazo de falha de consulta.</p>}
        <p className="mt-2">Agendas: {report.agendas.created || 0} com envio; {report.agendas.cleared || 0} com limpeza; {report.agendas.unchanged || 0} inalteradas; {report.agendas.skipped_empty || 0} sem disponibilidade identificada; {report.agendas.error || 0} com erro.</p>
        {(report.agendas.skipped_empty || 0) > 0 && <div className="mt-2 rounded-lg bg-slate-50 p-3">
            <p>Contagem por profissional e endereço. Nesses casos, nenhum horário foi enviado ou removido da Doctoralia. A ausência na consulta não comprova que a agenda interna esteja sem horários.</p>
            <details className="mt-2">
                <summary className="cursor-pointer font-semibold">Ver agendas sem disponibilidade identificada ({report.agendas.skipped_empty})</summary>
                {loadedEvents === null && loadEvents && <button type="button" onClick={load} disabled={loading} className="mt-2 rounded-lg border border-slate-300 px-3 py-2 font-semibold disabled:opacity-60">{loading ? 'Consultando agendas…' : loadError ? 'Tentar novamente' : 'Consultar detalhes desta execução'}</button>}
                {loadError && <p role="alert" className="mt-2">Não foi possível consultar os detalhes. Tente novamente.</p>}
                <ul className="mt-2 max-h-60 overflow-auto space-y-2 break-words">{emptyEvents.map((event, index) => <li key={index}>{event.message?.replace(/^Doctor (.+) address (\d+): nenhuma faixa livre e sem estado prévio gerenciado.*$/, 'Profissional $1, endereço $2: nenhuma faixa identificada. Esta execução antiga não registrou o motivo detalhado; não houve envio nem remoção de horários.') || 'Evento sem descrição disponível.'}</li>)}</ul>
                {(loadedEvents !== null || !loadEvents) && emptyEvents.length < (report.agendas.skipped_empty || 0) && <p className="mt-2">Os detalhes disponíveis não cobrem todas as agendas desta contagem.</p>}
            </details>
        </div>}
        <p className="mt-2">Agendas pendentes: {(report.agendas.managed_scope_pending || 0) + (report.agendas.professional_cleanup_pending || 0) + (report.agendas.mapping_pending || 0) + (report.agendas.skipped_incomplete || 0)} por falta de vínculo, origem incompleta ou limpeza ainda não confirmada.</p>
        <p className="mt-2">Ocorrências: {report.errors} erros e {report.warnings} pendências/avisos. Os detalhes estão nos eventos da execução.</p>
        <ul className="mt-2">{report.stages.map((stage, i) => <li key={i}>{labels[stage.name] || stage.name}: {(stage.durationMs / 1000).toFixed(1)} s</li>)}</ul>
    </details>;
}
