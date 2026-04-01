'use client';
import { useState, useEffect } from 'react';
import { RefreshCw, CheckCircle2, XCircle, Clock, AlertTriangle, Search, Calendar, ChevronRight, Activity, Loader2, Database, Terminal, FileJson, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { useClinic } from '@/lib/clinic-store';

interface SyncEvent {
    id: string;
    entityType: string;
    action: string;
    message: string | null;
    timestamp: string;
}

interface SyncRun {
    id: string;
    clinicId: string;
    status: string; // running, completed, failed
    type: string; // full, doctors, services
    startedAt: string;
    endedAt: string | null;
    totalRecords: number;
    events: SyncEvent[];
}

interface MappedLog {
    id: string;
    fullId: string;
    clinic: string;
    type: string;
    status: 'success' | 'warning' | 'failed' | 'pending';
    startedAt: string;
    duration: string;
    records: string;
    details: string;
    rawEvents: SyncEvent[];
    rawRun: SyncRun;
}

export default function SyncLogsPage() {
    const [searchTerm, setSearchTerm] = useState('');
    const [logs, setLogs] = useState<MappedLog[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSyncing, setIsSyncing] = useState(false);
    const { user } = useAuthStore();
    const { activeClinic } = useClinic();

    // Modal State
    const [showJsonModal, setShowJsonModal] = useState(false);
    const [selectedRawData, setSelectedRawData] = useState<any>(null);

    const fetchLogs = async () => {
        if (!user || !activeClinic) return;
        try {
            const clinicId = activeClinic.id;
            const clinicName = activeClinic.name;

            const response = await api.get(`/sync/${clinicId}/history?t=${Date.now()}`);
            const data: SyncRun[] = response.data;

            // Filtro para mitigar logs "fantasmas" ou duplicados (se houver dois rodando ao mesmo tempo para o mesmo tipo)
            // No entanto, conforme solicitado, vamos focar em garantir que o status reflita a realidade.
            const mappedData: MappedLog[] = data.map(run => {
                let mappedStatus: 'success' | 'warning' | 'failed' | 'pending' = 'pending';
                if (run.status === 'completed') mappedStatus = 'success';
                else if (run.status === 'running') mappedStatus = 'pending';
                else if (run.status === 'failed') mappedStatus = 'failed';

                const startDate = new Date(run.startedAt);
                const formattedDate = startDate.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

                let durationStr = '-';
                if (run.endedAt) {
                    const ms = new Date(run.endedAt).getTime() - startDate.getTime();
                    if (ms < 1000) durationStr = `${ms}ms`;
                    else if (ms < 60000) durationStr = `${Math.floor(ms / 1000)}s`;
                    else durationStr = `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
                }

                // Ajuste de mensagem: se está rodando, não dizer que concluiu com êxito
                let details = run.status === 'running' ? 'Processamento em segundo plano iniciado...' : 'Sincronização concluída com êxito.';
                if (run.events?.length > 0) {
                    const errEvent = run.events.find(e => e.action === 'error');
                    if (errEvent && errEvent.message) details = errEvent.message;
                    else if (run.events[0].message) details = run.events[0].message;
                }

                return {
                    id: run.id.substring(0, 8),
                    fullId: run.id,
                    clinic: clinicName,
                    type: run.type === 'full' ? 'Doctoralia (Completa)' : run.type === 'vismed-full' ? 'VisMed (Completa)' : 'Parcial',
                    status: mappedStatus,
                    startedAt: formattedDate,
                    duration: durationStr,
                    records: `${run.totalRecords} Processados`,
                    details: details,
                    rawEvents: run.events || [],
                    rawRun: run
                };
            });

            setLogs(mappedData);
        } catch (error) {
            console.error('Error fetching sync logs:', error);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchLogs();
    }, [user, activeClinic]);

    // Polling inteligente para logs em execução
    useEffect(() => {
        let interval: NodeJS.Timeout;

        const hasRunningLogs = logs.some(log => log.status === 'pending');

        if (hasRunningLogs) {
            interval = setInterval(() => {
                fetchLogs();
            }, 3000);
        }

        return () => {
            if (interval) clearInterval(interval);
        };
    }, [logs]);

    const handleSync = async () => {
        if (!activeClinic) return;
        setIsSyncing(true);
        try {
            const clinicId = activeClinic.id;
            await api.post(`/sync/${clinicId}/global`);

            setTimeout(async () => {
                await fetchLogs();
                setIsSyncing(false);
            }, 2000);
        } catch (error) {
            console.error('Failed to trigger sync', error);
            setIsSyncing(false);
        }
    };

    const handleOpenJson = (log: MappedLog) => {
        setSelectedRawData(log.rawRun);
        setShowJsonModal(true);
    };

    const filteredLogs = logs.filter(log =>
        log.clinic.toLowerCase().includes(searchTerm.toLowerCase()) ||
        log.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        log.type.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="max-w-7xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Header Moderno */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div className="flex items-center gap-5">
                    <div className="h-16 w-16 rounded-[24px] bg-gradient-to-br from-primary to-emerald-600 flex items-center justify-center shadow-[0_12px_24px_-8px_rgba(31,181,122,0.4)] border border-white/20 transform rotate-1 transition-transform hover:rotate-0">
                        <Terminal className="h-8 w-8 text-white" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-black text-slate-900 tracking-tighter uppercase leading-none mb-2">Logs de Sincronização</h1>
                        <p className="text-sm text-slate-500 font-bold uppercase tracking-wide">Monitoramento em tempo real de transações e integridade</p>
                    </div>
                </div>
                <button
                    onClick={handleSync}
                    disabled={isSyncing}
                    className="flex items-center gap-2 bg-slate-900 hover:bg-black text-white px-7 py-3.5 rounded-2xl text-[10px] font-black uppercase tracking-[2px] shadow-xl transition-all hover:-translate-y-1 active:scale-95 disabled:opacity-50"
                >
                    <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
                    {isSyncing ? 'Agendando Sincronismo' : 'Forçar Sincronização Global'}
                </button>
            </div>

            {/* Metrics Mini-Bar Glass */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <div className="bg-white/60 backdrop-blur-md rounded-[28px] p-6 border border-slate-100/60 flex items-center gap-4 shadow-sm">
                    <div className="h-12 w-12 bg-emerald-50 rounded-2xl flex items-center justify-center text-primary border border-emerald-100/60">
                        <CheckCircle2 className="h-6 w-6" />
                    </div>
                    <div>
                        <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Taxa de Sucesso</div>
                        <div className="text-2xl font-black text-slate-900">{logs.length > 0 ? Math.round((logs.filter(l => l.status === 'success' || l.status === 'pending').length / logs.length) * 100) : 0}%</div>
                    </div>
                </div>
                <div className="bg-white/60 backdrop-blur-md rounded-[28px] p-6 border border-slate-100/60 flex items-center gap-4 shadow-sm">
                    <div className="h-12 w-12 bg-primary/10 rounded-2xl flex items-center justify-center text-primary border border-primary/10">
                        <Database className="h-6 w-6" />
                    </div>
                    <div>
                        <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Total Processado (Sessões)</div>
                        <div className="text-2xl font-black text-slate-900">{logs.length}</div>
                    </div>
                </div>
                <div className="bg-white/60 backdrop-blur-md rounded-[28px] p-6 border border-slate-100/60 flex items-center gap-4 shadow-sm">
                    <div className="h-12 w-12 bg-slate-900 rounded-2xl flex items-center justify-center text-white border border-slate-800">
                        <Clock className="h-6 w-6" />
                    </div>
                    <div>
                        <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Janela de Histórico</div>
                        <div className="text-2xl font-black text-slate-900">7 Dias Ativos</div>
                    </div>
                </div>
            </div>

            {/* Main List & Filters Container */}
            <div className="bg-white/70 backdrop-blur-xl rounded-[40px] shadow-sm border border-slate-100/80 overflow-hidden flex flex-col min-h-[500px]">
                <div className="p-8 border-b border-slate-100/60 bg-white/40 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6">
                    <div className="relative w-full lg:max-w-md">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400" />
                        <input
                            type="text"
                            placeholder="Pesquisar por Sessão, Entidade ou Status..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full h-14 pl-12 pr-6 bg-white rounded-[20px] border-2 border-slate-50 text-[14px] font-black tracking-tight focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/5 transition-all placeholder:font-normal placeholder:text-slate-400 shadow-inner"
                        />
                    </div>
                    <div className="flex flex-wrap gap-4 w-full lg:w-auto">
                        <div className="flex flex-1 lg:flex-none items-center border-2 border-slate-50 bg-white px-5 rounded-[20px] h-14 shadow-sm gap-3">
                            <Calendar className="h-5 w-5 text-primary/40" />
                            <span className="text-[11px] text-slate-700 font-black uppercase tracking-widest">Temporalidade Recente</span>
                        </div>
                        <select className="flex-1 lg:flex-none h-14 rounded-[20px] border-2 border-slate-50 bg-white px-5 text-[11px] font-black uppercase tracking-[2px] shadow-sm focus:outline-none focus:border-primary text-slate-700 cursor-pointer transition-all">
                            <option value="">Status da Operação</option>
                            <option value="success">Arquivados / Sucesso</option>
                            <option value="pending">Processamento Ativo</option>
                            <option value="failed">Anomalias / Falhas</option>
                        </select>
                    </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left border-separate border-spacing-0">
                        <thead className="bg-slate-50/50 text-[10px] text-slate-400 uppercase font-black tracking-[3px] border-b border-slate-100">
                            <tr>
                                <th className="px-10 py-6 font-black">Cluster de Integração</th>
                                <th className="px-10 py-6 font-black">Diagnóstico da Carga</th>
                                <th className="px-10 py-6 font-black">Timeline</th>
                                <th className="px-10 py-6 text-center font-black">Integritade Final</th>
                                <th className="px-10 py-6 text-right font-black">Metadata</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50/80">
                            {isLoading ? (
                                <tr>
                                    <td colSpan={5} className="px-10 py-24 text-center">
                                        <div className="flex flex-col items-center gap-4">
                                            <Loader2 className="h-12 w-12 animate-spin text-primary" />
                                            <p className="text-[10px] font-black text-slate-300 uppercase tracking-[4px]">Escaneando blocos de dados...</p>
                                        </div>
                                    </td>
                                </tr>
                            ) : filteredLogs.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="px-10 py-24 text-center">
                                        <div className="max-w-sm mx-auto opacity-30">
                                            <Terminal className="h-16 w-16 text-slate-200 mx-auto mb-6" />
                                            <h4 className="text-[12px] font-black text-slate-900 uppercase tracking-[2px] mb-2">Nenhuma ocorrência</h4>
                                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] leading-relaxed">Cluster de sincronização sem eventos registrados nesta janela temporal.</p>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                filteredLogs.map((log) => (
                                    <tr key={log.id} className="hover:bg-emerald-50/20 transition-all duration-500 group">
                                        <td className="px-10 py-6">
                                            <div className="flex items-center gap-5">
                                                <div className={`h-12 w-12 rounded-[18px] flex items-center justify-center shrink-0 border-2 transition-transform group-hover:scale-110 group-hover:-rotate-2 ${log.status === 'success' ? 'bg-emerald-50 text-primary border-emerald-100' :
                                                    log.status === 'failed' ? 'bg-rose-50 text-rose-600 border-rose-100' :
                                                        log.status === 'pending' ? 'bg-primary/5 text-primary border-primary/10 shadow-lg shadow-primary/10' :
                                                            'bg-orange-50 text-orange-500 border-orange-100'
                                                    }`}>
                                                    {log.status === 'pending' ? <RefreshCw className="h-6 w-6 animate-spin" /> : <Database className="h-6 w-6" />}
                                                </div>
                                                <div>
                                                    <div className="font-black text-base text-slate-900 leading-none group-hover:text-primary transition-colors tracking-tight">{log.clinic}</div>
                                                    <div className="text-[10px] text-slate-400 font-black uppercase tracking-[2px] mt-2 font-mono flex items-center gap-2">
                                                        <span className="opacity-40">SessionID</span> {log.id}
                                                    </div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-10 py-6">
                                            <div className="flex flex-col gap-2">
                                                <div className="font-black text-[13px] text-slate-800 flex items-center gap-2 group-hover:text-primary transition-colors">
                                                    {log.type}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <div className="h-1 w-1 rounded-full bg-primary/40"></div>
                                                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{log.records}</span>
                                                </div>
                                                <div className={`text-[11px] mt-1 font-bold leading-relaxed max-w-[320px] ${log.status === 'failed' ? 'text-rose-600' : log.status === 'pending' ? 'text-primary/70 italic' : 'text-slate-500/80'}`}>
                                                    {log.details}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-10 py-6">
                                            <div className="flex flex-col gap-2">
                                                <div className="flex items-center gap-2 text-[14px] text-slate-900 font-black tracking-tight leading-none mb-0.5">
                                                    <Calendar className="h-4 w-4 text-primary/40" />
                                                    {log.startedAt}
                                                </div>
                                                <div className="flex items-center gap-2 text-[10px] font-black text-slate-400 uppercase tracking-[2px]">
                                                    <Clock className="h-3.5 w-3.5" />
                                                    Duração {log.duration}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-10 py-6 text-center">
                                            {log.status === 'success' ? (
                                                <span className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-[2px] border border-emerald-100 bg-emerald-50 text-primary shadow-sm">
                                                    <CheckCircle2 className="h-4 w-4" />
                                                    Concluído
                                                </span>
                                            ) : log.status === 'failed' ? (
                                                <span className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-[2px] border border-rose-200 bg-rose-50 text-rose-700 shadow-sm animate-pulse">
                                                    <XCircle className="h-4 w-4" />
                                                    Falha Critica
                                                </span>
                                            ) : log.status === 'pending' ? (
                                                <span className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-[2px] border border-primary/20 bg-primary/5 text-primary shadow-lg shadow-primary/5">
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                    Em Fluxo
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-[2px] border border-orange-200 bg-orange-50 text-orange-700">
                                                    <AlertTriangle className="h-4 w-4" />
                                                    Atenção
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-10 py-6 text-right">
                                            <button
                                                onClick={() => handleOpenJson(log)}
                                                className="inline-flex items-center justify-end w-full gap-2 text-[11px] font-black text-primary uppercase tracking-[2px] hover:text-emerald-700 transition-all group/btn"
                                            >
                                                Exibir JSON
                                                <ChevronRight className="h-5 w-5 transition-transform group-hover/btn:translate-x-1" />
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                <div className="p-8 border-t border-slate-100/60 bg-slate-50/30 flex flex-col sm:flex-row justify-between items-center gap-6 text-[10px] font-black uppercase tracking-[4px]">
                    <div className="text-slate-400">
                        Infra <span className="text-slate-900">{filteredLogs.length}</span> Ocorrências Ativas
                    </div>
                    <div className="flex gap-2 items-center">
                        <button className="h-10 w-10 bg-white border border-slate-100 rounded-xl flex items-center justify-center hover:bg-slate-50 hover:border-slate-200 transition-all shadow-sm disabled:opacity-30">&lt;</button>
                        <button className="h-10 px-4 bg-primary text-white rounded-xl flex items-center justify-center font-black shadow-lg shadow-primary/20 scale-105">1</button>
                        <button className="h-10 px-4 bg-white border border-slate-100 text-slate-400 rounded-xl flex items-center justify-center hover:bg-slate-50 transition-all">2</button>
                        <button className="h-10 w-10 bg-white border border-slate-100 rounded-xl flex items-center justify-center hover:bg-slate-50 transition-all shadow-sm">&gt;</button>
                    </div>
                </div>
            </div>

            {/* JSON Source Modal */}
            {showJsonModal && selectedRawData && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[100] flex items-center justify-center p-6 animate-in fade-in duration-500">
                    <div className="bg-[#1e1e1e] rounded-[40px] shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden border border-white/10 animate-in zoom-in-95 duration-300">
                        <div className="p-8 border-b border-white/5 flex justify-between items-center bg-[#252525]">
                            <div className="flex items-center gap-5">
                                <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary border border-primary/20 shadow-lg">
                                    <FileJson className="h-6 w-6" />
                                </div>
                                <div>
                                    <h3 className="text-xl font-black text-white tracking-tight uppercase leading-none mb-1.5">JSON Source Event</h3>
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-[2px]">{selectedRawData.type} • {selectedRawData.clinic}</p>
                                </div>
                            </div>
                            <button
                                onClick={() => setShowJsonModal(false)}
                                className="h-12 w-12 flex items-center justify-center rounded-2xl bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition-all text-2xl font-light"
                            >
                                <X className="h-6 w-6" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-auto p-8 custom-scrollbar bg-[#161616]">
                            <pre className="text-primary font-mono text-[13px] leading-relaxed overflow-x-auto p-6 rounded-3xl bg-black/40 border border-white/5">
                                {JSON.stringify(selectedRawData, null, 4)}
                            </pre>
                        </div>
                        <div className="p-8 border-t border-white/5 bg-[#1e1e1e] flex justify-between items-center">
                            <span className="text-[10px] font-black text-slate-500 uppercase tracking-[3px]">Encryption Standard • VisMed Secure Logs</span>
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(JSON.stringify(selectedRawData, null, 4));
                                    alert('JSON copiado para o clipboard!');
                                }}
                                className="bg-white/5 hover:bg-white/10 text-white px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-[2px] transition-all"
                            >
                                Copiar Objeto
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="pt-10 border-t border-slate-100/40 text-center">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[5px] opacity-30">Transaction Integrity Matrix • VisMed Node Sync v2.0</p>
            </div>

            <style jsx global>{`
                .custom-scrollbar::-webkit-scrollbar {
                    width: 6px;
                }
                .custom-scrollbar::-webkit-scrollbar-track {
                    background: transparent;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: rgba(31, 181, 122, 0.1);
                    border-radius: 10px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: rgba(31, 181, 122, 0.3);
                }
            `}</style>
        </div>
    );
}
