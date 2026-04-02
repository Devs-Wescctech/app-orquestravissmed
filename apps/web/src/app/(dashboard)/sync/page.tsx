'use client';
import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, CheckCircle2, XCircle, Clock, AlertTriangle, Activity, Loader2, Shield, Link2, Unlink, Eye, ChevronDown, ChevronUp, FileJson, X, Wifi, WifiOff } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { useClinic } from '@/lib/clinic-store';

interface SyncStatus {
    health: 'healthy' | 'warning' | 'error' | 'never_synced';
    isRunning: boolean;
    lastSync: {
        id: string;
        startedAt: string;
        endedAt: string | null;
        totalRecords: number;
    } | null;
    lastError: {
        id: string;
        startedAt: string;
        message: string;
    } | null;
    doctors: { mapped: number };
    insurance: { linked: number; pending: number; unlinked: number; total: number };
    recentRuns: Array<{
        id: string;
        type: string;
        status: string;
        startedAt: string;
        endedAt: string | null;
        totalRecords: number;
    }>;
}

export default function SyncStatusPage() {
    const [status, setStatus] = useState<SyncStatus | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSyncing, setIsSyncing] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [showJsonModal, setShowJsonModal] = useState(false);
    const [selectedRunData, setSelectedRunData] = useState<any>(null);
    const { user } = useAuthStore();
    const { activeClinic } = useClinic();

    const fetchStatus = useCallback(async () => {
        if (!user || !activeClinic) return;
        try {
            const res = await api.get(`/sync/${activeClinic.id}/status?t=${Date.now()}`);
            setStatus(res.data);
            if (res.data.isRunning) setIsSyncing(true);
            else setIsSyncing(false);
        } catch (error) {
            console.error('Error fetching sync status:', error);
        } finally {
            setIsLoading(false);
        }
    }, [user, activeClinic]);

    useEffect(() => {
        fetchStatus();
    }, [fetchStatus]);

    useEffect(() => {
        const interval = setInterval(fetchStatus, isSyncing ? 3000 : 15000);
        return () => clearInterval(interval);
    }, [fetchStatus, isSyncing]);

    const handleSync = async () => {
        if (!activeClinic || isSyncing) return;
        setIsSyncing(true);
        try {
            await api.post(`/sync/${activeClinic.id}/global`);
            setTimeout(fetchStatus, 2000);
        } catch (error) {
            console.error('Failed to trigger sync', error);
            setIsSyncing(false);
        }
    };

    const handleOpenRunDetail = async (runId: string) => {
        if (!activeClinic) return;
        try {
            const res = await api.get(`/sync/${activeClinic.id}/history?t=${Date.now()}`);
            const run = res.data.find((r: any) => r.id === runId);
            if (run) {
                setSelectedRunData(run);
                setShowJsonModal(true);
            }
        } catch (e) {
            console.error(e);
        }
    };

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    };

    const formatDuration = (start: string, end: string | null) => {
        if (!end) return 'Em andamento...';
        const ms = new Date(end).getTime() - new Date(start).getTime();
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
        return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    };

    const getTimeSince = (dateStr: string) => {
        const ms = Date.now() - new Date(dateStr).getTime();
        const mins = Math.floor(ms / 60000);
        if (mins < 1) return 'agora';
        if (mins < 60) return `${mins}min atrás`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h atrás`;
        return `${Math.floor(hours / 24)}d atrás`;
    };

    const healthConfig = {
        healthy: { color: 'emerald', icon: CheckCircle2, label: 'Operacional', desc: 'Todas as integrações sincronizadas' },
        warning: { color: 'amber', icon: AlertTriangle, label: 'Atenção Necessária', desc: 'Existem convênios pendentes de revisão' },
        error: { color: 'rose', icon: XCircle, label: 'Falha Detectada', desc: 'A última sincronização apresentou erros' },
        never_synced: { color: 'slate', icon: WifiOff, label: 'Nunca Sincronizado', desc: 'Execute a primeira sincronização' },
    };

    if (isLoading) {
        return (
            <div className="max-w-5xl mx-auto flex flex-col items-center justify-center py-32">
                <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
                <p className="text-sm text-slate-400 font-bold uppercase tracking-widest">Verificando status...</p>
            </div>
        );
    }

    const health = status ? healthConfig[status.health] : healthConfig.never_synced;
    const HealthIcon = health.icon;

    return (
        <div className="max-w-5xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div className="flex items-center gap-5">
                    <div className={`h-16 w-16 rounded-[24px] flex items-center justify-center shadow-lg border border-white/20 ${
                        status?.health === 'healthy' ? 'bg-gradient-to-br from-emerald-500 to-emerald-600' :
                        status?.health === 'warning' ? 'bg-gradient-to-br from-amber-400 to-amber-500' :
                        status?.health === 'error' ? 'bg-gradient-to-br from-rose-500 to-rose-600' :
                        'bg-gradient-to-br from-slate-400 to-slate-500'
                    }`}>
                        {isSyncing ? (
                            <Loader2 className="h-8 w-8 text-white animate-spin" />
                        ) : (
                            <HealthIcon className="h-8 w-8 text-white" />
                        )}
                    </div>
                    <div>
                        <h1 className="text-3xl font-black text-slate-900 tracking-tighter uppercase leading-none mb-2">
                            {isSyncing ? 'Sincronizando...' : health.label}
                        </h1>
                        <p className="text-sm text-slate-500 font-bold uppercase tracking-wide">
                            {isSyncing ? 'Processamento em andamento' : health.desc}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <div className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold ${
                        isSyncing ? 'bg-primary/10 text-primary' : 'bg-slate-100 text-slate-500'
                    }`}>
                        <div className={`h-2 w-2 rounded-full ${isSyncing ? 'bg-primary animate-pulse' : 'bg-slate-300'}`} />
                        {isSyncing ? 'Em sincronização' : 'Monitorando'}
                    </div>
                    <button
                        onClick={handleSync}
                        disabled={isSyncing}
                        className="flex items-center gap-2 bg-slate-900 hover:bg-black text-white px-5 py-2.5 rounded-xl text-xs font-bold shadow-lg transition-all hover:-translate-y-0.5 active:scale-95 disabled:opacity-50"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                        {isSyncing ? 'Sincronizando' : 'Sincronizar Agora'}
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="h-10 w-10 bg-primary/10 rounded-xl flex items-center justify-center">
                            <Wifi className="h-5 w-5 text-primary" />
                        </div>
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Última Sync</span>
                    </div>
                    {status?.lastSync ? (
                        <div>
                            <div className="text-lg font-black text-slate-900">{getTimeSince(status.lastSync.endedAt || status.lastSync.startedAt)}</div>
                            <div className="text-xs text-slate-400 mt-1">{formatDate(status.lastSync.startedAt)}</div>
                            <div className="text-xs text-slate-500 mt-0.5">{status.lastSync.totalRecords} registros</div>
                        </div>
                    ) : (
                        <div className="text-sm text-slate-400">Nunca executada</div>
                    )}
                </div>

                <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="h-10 w-10 bg-blue-50 rounded-xl flex items-center justify-center">
                            <Activity className="h-5 w-5 text-blue-500" />
                        </div>
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Médicos</span>
                    </div>
                    <div className="text-lg font-black text-slate-900">{status?.doctors.mapped || 0}</div>
                    <div className="text-xs text-slate-400 mt-1">mapeados e ativos</div>
                </div>

                <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="h-10 w-10 bg-emerald-50 rounded-xl flex items-center justify-center">
                            <Link2 className="h-5 w-5 text-emerald-500" />
                        </div>
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Convênios Vinculados</span>
                    </div>
                    <div className="text-lg font-black text-emerald-600">{status?.insurance.linked || 0}</div>
                    <div className="text-xs text-slate-400 mt-1">de {status?.insurance.total || 0} total</div>
                </div>

                <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
                    <div className="flex items-center gap-3 mb-3">
                        <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${
                            (status?.insurance.pending || 0) > 0 ? 'bg-amber-50' : 'bg-slate-50'
                        }`}>
                            {(status?.insurance.pending || 0) > 0 ? (
                                <Eye className="h-5 w-5 text-amber-500" />
                            ) : (
                                <Shield className="h-5 w-5 text-slate-400" />
                            )}
                        </div>
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Pendentes</span>
                    </div>
                    <div className={`text-lg font-black ${(status?.insurance.pending || 0) > 0 ? 'text-amber-600' : 'text-slate-900'}`}>
                        {status?.insurance.pending || 0}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">
                        {(status?.insurance.pending || 0) > 0 ? 'requer aprovação manual' : 'nenhum pendente'}
                    </div>
                </div>
            </div>

            {(status?.insurance.pending || 0) > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 flex items-start gap-4">
                    <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
                    <div>
                        <p className="text-sm font-bold text-amber-800">
                            {status?.insurance.pending} convênio(s) aguardando confirmação manual
                        </p>
                        <p className="text-xs text-amber-600 mt-1">
                            Acesse a seção de Mapeamento para revisar e aprovar os matches sugeridos.
                            Somente convênios com 100% de correspondência são vinculados automaticamente.
                        </p>
                    </div>
                </div>
            )}

            {status?.lastError && (
                <div className="bg-rose-50 border border-rose-200 rounded-2xl p-5 flex items-start gap-4">
                    <XCircle className="h-5 w-5 text-rose-500 mt-0.5 shrink-0" />
                    <div>
                        <p className="text-sm font-bold text-rose-800">Erro na última sincronização</p>
                        <p className="text-xs text-rose-600 mt-1">{status.lastError.message}</p>
                        <p className="text-xs text-rose-400 mt-1">{formatDate(status.lastError.startedAt)}</p>
                    </div>
                </div>
            )}

            {(status?.insurance.unlinked || 0) > 0 && (
                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 flex items-start gap-4">
                    <Unlink className="h-5 w-5 text-slate-400 mt-0.5 shrink-0" />
                    <div>
                        <p className="text-sm font-bold text-slate-700">
                            {status?.insurance.unlinked} convênio(s) sem correspondência
                        </p>
                        <p className="text-xs text-slate-500 mt-1">
                            Esses convênios não encontraram equivalente na Doctoralia. Vincule manualmente na seção de Mapeamento se necessário.
                        </p>
                    </div>
                </div>
            )}

            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                <button
                    onClick={() => setShowHistory(!showHistory)}
                    className="w-full flex items-center justify-between p-5 hover:bg-slate-50 transition-colors"
                >
                    <div className="flex items-center gap-3">
                        <Clock className="h-5 w-5 text-slate-400" />
                        <span className="text-sm font-bold text-slate-700">Histórico de Sincronizações</span>
                        <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-bold">
                            {status?.recentRuns.length || 0}
                        </span>
                    </div>
                    {showHistory ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                </button>

                {showHistory && (
                    <div className="border-t border-slate-100">
                        {(status?.recentRuns || []).length === 0 ? (
                            <div className="p-8 text-center text-sm text-slate-400">Nenhuma sincronização registrada</div>
                        ) : (
                            <div className="divide-y divide-slate-50">
                                {status?.recentRuns.map(run => (
                                    <div key={run.id} className="flex items-center justify-between px-5 py-4 hover:bg-slate-50 transition-colors">
                                        <div className="flex items-center gap-4">
                                            <div className={`h-8 w-8 rounded-lg flex items-center justify-center ${
                                                run.status === 'completed' ? 'bg-emerald-50 text-emerald-500' :
                                                run.status === 'running' ? 'bg-primary/10 text-primary' :
                                                'bg-rose-50 text-rose-500'
                                            }`}>
                                                {run.status === 'running' ? (
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                ) : run.status === 'completed' ? (
                                                    <CheckCircle2 className="h-4 w-4" />
                                                ) : (
                                                    <XCircle className="h-4 w-4" />
                                                )}
                                            </div>
                                            <div>
                                                <div className="text-sm font-bold text-slate-800">
                                                    {run.type === 'full' ? 'Doctoralia' : run.type === 'vismed-full' ? 'VisMed' : run.type}
                                                </div>
                                                <div className="text-xs text-slate-400">{formatDate(run.startedAt)}</div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-4">
                                            <div className="text-right">
                                                <div className="text-xs font-bold text-slate-600">{run.totalRecords} registros</div>
                                                <div className="text-xs text-slate-400">{formatDuration(run.startedAt, run.endedAt)}</div>
                                            </div>
                                            <div className={`px-3 py-1 rounded-lg text-xs font-bold ${
                                                run.status === 'completed' ? 'bg-emerald-50 text-emerald-600' :
                                                run.status === 'running' ? 'bg-primary/10 text-primary' :
                                                'bg-rose-50 text-rose-600'
                                            }`}>
                                                {run.status === 'completed' ? 'OK' : run.status === 'running' ? 'Executando' : 'Falha'}
                                            </div>
                                            <button
                                                onClick={() => handleOpenRunDetail(run.id)}
                                                className="text-slate-400 hover:text-primary transition-colors"
                                                title="Ver detalhes"
                                            >
                                                <FileJson className="h-4 w-4" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {showJsonModal && selectedRunData && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300">
                    <div className="bg-[#1e1e1e] rounded-3xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden border border-white/10">
                        <div className="p-6 border-b border-white/5 flex justify-between items-center bg-[#252525]">
                            <div className="flex items-center gap-4">
                                <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                                    <FileJson className="h-5 w-5" />
                                </div>
                                <div>
                                    <h3 className="text-lg font-bold text-white">Detalhes da Sincronização</h3>
                                    <p className="text-xs text-slate-400">{selectedRunData.id}</p>
                                </div>
                            </div>
                            <button
                                onClick={() => setShowJsonModal(false)}
                                className="h-10 w-10 flex items-center justify-center rounded-xl bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition-all"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-auto p-6 bg-[#161616]">
                            <pre className="text-primary font-mono text-sm leading-relaxed overflow-x-auto p-4 rounded-2xl bg-black/40 border border-white/5">
                                {JSON.stringify(selectedRunData, null, 4)}
                            </pre>
                        </div>
                        <div className="p-4 border-t border-white/5 bg-[#1e1e1e] flex justify-end">
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(JSON.stringify(selectedRunData, null, 4));
                                }}
                                className="bg-white/5 hover:bg-white/10 text-white px-5 py-2 rounded-xl text-xs font-bold transition-all"
                            >
                                Copiar JSON
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="pt-6 text-center">
                <p className="text-xs text-slate-300 font-bold uppercase tracking-widest">Sincronização automática ativa — monitoramento contínuo</p>
            </div>
        </div>
    );
}
