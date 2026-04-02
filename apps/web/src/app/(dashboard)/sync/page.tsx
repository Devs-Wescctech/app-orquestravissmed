'use client';
import { useState, useEffect, useCallback } from 'react';
import {
    RefreshCw, CheckCircle2, XCircle, Clock, AlertTriangle, Activity, Loader2,
    Shield, Link2, Unlink, Eye, ChevronDown, ChevronUp, FileJson, X,
    ShieldCheck, UserSquare2, Stethoscope, Building2, CalendarDays,
    ToggleLeft, ToggleRight, ArrowUpRight, Database, Wifi, WifiOff, Zap
} from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { useClinic } from '@/lib/clinic-store';
import { toast } from 'sonner';

interface SyncStatus {
    health: 'healthy' | 'warning' | 'error' | 'never_synced';
    isRunning: boolean;
    queueEnabled: boolean;
    successRate: number;
    lastSync: { id: string; startedAt: string; endedAt: string | null; totalRecords: number } | null;
    lastError: { id: string; startedAt: string; message: string } | null;
    doctors: { mapped: number };
    insurance: { linked: number; pending: number; unlinked: number; total: number };
    vismed: {
        connected: boolean;
        stats: { units: number; doctors: number; specialties: number; insurances: number };
        lastSync: { startedAt: string; endedAt: string | null; status: string; totalRecords: number } | null;
    };
    doctoralia: {
        connected: boolean;
        lastSync: { startedAt: string; endedAt: string | null; status: string; totalRecords: number } | null;
    };
    recentRuns: Array<{
        id: string; type: string; status: string;
        startedAt: string; endedAt: string | null; totalRecords: number;
    }>;
}

export default function SyncDashboardPage() {
    const [status, setStatus] = useState<SyncStatus | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSyncing, setIsSyncing] = useState(false);
    const [isTogglingQueue, setIsTogglingQueue] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [showJsonModal, setShowJsonModal] = useState(false);
    const [selectedRunData, setSelectedRunData] = useState<any>(null);
    const [fetchError, setFetchError] = useState(false);
    const { user } = useAuthStore();
    const { activeClinic } = useClinic();

    const fetchStatus = useCallback(async () => {
        if (!user || !activeClinic) return;
        try {
            const res = await api.get(`/sync/${activeClinic.id}/status?t=${Date.now()}`);
            setStatus(res.data);
            setFetchError(false);
            if (res.data.isRunning) setIsSyncing(true);
            else setIsSyncing(false);
        } catch (error) {
            console.error('Error fetching sync status:', error);
            setFetchError(true);
        } finally {
            setIsLoading(false);
        }
    }, [user, activeClinic]);

    useEffect(() => { fetchStatus(); }, [fetchStatus]);

    useEffect(() => {
        const interval = setInterval(fetchStatus, isSyncing ? 3000 : 15000);
        return () => clearInterval(interval);
    }, [fetchStatus, isSyncing]);

    const handleSync = async () => {
        if (!activeClinic || isSyncing) return;
        setIsSyncing(true);
        try {
            await api.post(`/sync/${activeClinic.id}/global`);
            toast.success('Sincronização iniciada');
            setTimeout(fetchStatus, 2000);
        } catch (error) {
            console.error('Failed to trigger sync', error);
            toast.error('Falha ao iniciar sincronização');
            setIsSyncing(false);
        }
    };

    const handleToggleQueue = async () => {
        if (!activeClinic || !status) return;
        setIsTogglingQueue(true);
        try {
            const newEnabled = !status.queueEnabled;
            await api.post(`/sync/${activeClinic.id}/queue/toggle`, { enabled: newEnabled });
            toast.success(newEnabled ? 'Fila de sincronização ativada' : 'Fila de sincronização pausada');
            await fetchStatus();
        } catch (error) {
            console.error('Failed to toggle queue', error);
            toast.error('Falha ao alterar fila');
        } finally {
            setIsTogglingQueue(false);
        }
    };

    const handleOpenRunDetail = async (runId: string) => {
        if (!activeClinic) return;
        try {
            const res = await api.get(`/sync/${activeClinic.id}/history?t=${Date.now()}`);
            const run = res.data.find((r: any) => r.id === runId);
            if (run) { setSelectedRunData(run); setShowJsonModal(true); }
        } catch (e) { console.error(e); }
    };

    const formatDate = (dateStr: string) =>
        new Date(dateStr).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

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

    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] animate-in fade-in duration-700">
                <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
                <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-[4px]">Carregando Status</h2>
            </div>
        );
    }

    const healthColors = {
        healthy: { bg: 'bg-primary', text: 'text-primary', light: 'bg-emerald-50' },
        warning: { bg: 'bg-amber-500', text: 'text-amber-500', light: 'bg-amber-50' },
        error: { bg: 'bg-rose-500', text: 'text-rose-500', light: 'bg-rose-50' },
        never_synced: { bg: 'bg-slate-400', text: 'text-slate-400', light: 'bg-slate-50' },
    };
    const hc = status ? healthColors[status.health] : healthColors.never_synced;

    return (
        <div className="max-w-7xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">

            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                <div className="flex items-center gap-5">
                    <div className={`h-16 w-16 rounded-[24px] ${hc.bg} flex items-center justify-center shadow-[0_12px_24px_-8px_rgba(31,181,122,0.4)] border border-white/20 transform rotate-1 transition-transform hover:rotate-0 duration-500`}>
                        {isSyncing ? <Loader2 className="h-8 w-8 text-white animate-spin" /> : <Activity className="h-8 w-8 text-white" />}
                    </div>
                    <div>
                        <div className="flex items-center gap-3 mb-1">
                            <h1 className="text-3xl font-black text-slate-900 tracking-tighter">Central de Sincronização</h1>
                            {isSyncing && (
                                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-emerald-50 text-emerald-700 border border-emerald-100 shadow-sm animate-pulse">
                                    <Activity className="h-3 w-3" /> Sincronizando
                                </span>
                            )}
                        </div>
                        <p className="text-sm text-slate-500 font-bold uppercase tracking-wide">Monitoramento de integrações e fluxo de dados</p>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <button
                        onClick={handleToggleQueue}
                        disabled={isTogglingQueue}
                        className={`flex items-center gap-2 px-5 py-3 rounded-2xl text-[10px] font-black uppercase tracking-[1px] transition-all border-2 ${
                            status?.queueEnabled
                                ? 'border-primary/20 bg-emerald-50 text-primary hover:bg-emerald-100'
                                : 'border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100'
                        }`}
                    >
                        {isTogglingQueue ? <Loader2 className="h-4 w-4 animate-spin" /> :
                            status?.queueEnabled ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />
                        }
                        {status?.queueEnabled ? 'Fila Ativa' : 'Fila Pausada'}
                    </button>
                    <button
                        onClick={handleSync}
                        disabled={isSyncing || !status?.queueEnabled}
                        className="flex items-center gap-2 bg-slate-900 hover:bg-black text-white px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-[2px] shadow-xl transition-all hover:-translate-y-1 active:scale-95 disabled:opacity-50"
                    >
                        <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
                        {isSyncing ? 'Sincronizando' : 'Forçar Sync'}
                    </button>
                </div>
            </div>

            {/* KPI Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-6">

                {/* Sync Health */}
                <div className="bg-white/70 backdrop-blur-xl rounded-[32px] p-6 shadow-sm border border-slate-100/60 flex flex-col justify-between h-40 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 group border-r-4 border-r-primary">
                    <div className="flex justify-between items-start">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-tight">Saúde de<br />Sincronismo</h3>
                        <div className={`h-10 w-10 rounded-2xl flex items-center justify-center shadow-lg transition-transform group-hover:scale-110 ${(status?.successRate || 0) >= 90 ? 'bg-primary text-white' : 'bg-rose-500 text-white'}`}>
                            <ShieldCheck className="h-5 w-5" />
                        </div>
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <div className="text-4xl font-black text-slate-900 tracking-tighter">{status?.successRate || 0}%</div>
                            <div className={`h-2.5 w-2.5 rounded-full animate-ping ${(status?.successRate || 0) >= 90 ? 'bg-primary' : 'bg-rose-500'}`}></div>
                        </div>
                        <div className="h-1.5 w-full bg-slate-100 rounded-full mt-3 overflow-hidden">
                            <div className={`h-full rounded-full transition-all duration-1000 ${(status?.successRate || 0) >= 90 ? 'bg-primary' : 'bg-rose-500'}`} style={{ width: `${status?.successRate || 0}%` }}></div>
                        </div>
                    </div>
                </div>

                {/* VisMed Base */}
                <div className="bg-slate-900 rounded-[32px] p-6 shadow-2xl flex flex-col justify-between h-40 transition-all duration-300 hover:scale-[1.02] hover:shadow-primary/20 group relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-primary/20 rounded-full blur-3xl -mr-16 -mt-16 animate-pulse"></div>
                    <div className="flex justify-between items-start relative z-10">
                        <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest leading-tight">VisMed<br />Ecosystem</h3>
                        <div className={`h-10 w-10 rounded-2xl flex items-center justify-center backdrop-blur-sm transition-all ${
                            status?.vismed.connected ? 'bg-white/10 text-primary group-hover:bg-primary group-hover:text-white' : 'bg-rose-500/20 text-rose-400'
                        }`}>
                            {status?.vismed.connected ? <Zap className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}
                        </div>
                    </div>
                    <div className="relative z-10">
                        <div className="text-4xl font-black text-white tracking-tighter">{status?.vismed.stats.doctors || 0}</div>
                        <p className="text-[10px] font-black text-slate-500 mt-1 uppercase tracking-widest">Profissionais na Base</p>
                    </div>
                </div>

                {/* Médicos Mapeados */}
                <div className="bg-white/70 backdrop-blur-xl rounded-[32px] p-6 shadow-sm border border-slate-100/60 flex flex-col justify-between h-40 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 group">
                    <div className="flex justify-between items-start">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-tight">Médicos<br />Pareados</h3>
                        <div className="h-10 w-10 bg-slate-50 text-slate-400 rounded-2xl flex items-center justify-center transition-all group-hover:bg-primary group-hover:text-white group-hover:shadow-lg group-hover:shadow-primary/30">
                            <UserSquare2 className="h-5 w-5" />
                        </div>
                    </div>
                    <div>
                        <div className="text-4xl font-black text-slate-900 tracking-tighter">{status?.doctors.mapped || 0}</div>
                        <div className="flex items-center gap-1.5 mt-1">
                            <div className="h-1.5 w-1.5 rounded-full bg-primary"></div>
                            <p className="text-[10px] font-black text-primary uppercase tracking-widest">Ativos na Doctoralia</p>
                        </div>
                    </div>
                </div>

                {/* Convênios Vinculados */}
                <div className="bg-white/70 backdrop-blur-xl rounded-[32px] p-6 shadow-sm border border-slate-100/60 flex flex-col justify-between h-40 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 group">
                    <div className="flex justify-between items-start">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-tight">Convênios<br />Vinculados</h3>
                        <div className="h-10 w-10 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center transition-all group-hover:bg-primary group-hover:text-white group-hover:shadow-lg">
                            <Link2 className="h-5 w-5" />
                        </div>
                    </div>
                    <div>
                        <div className="text-4xl font-black text-slate-900 tracking-tighter">{status?.insurance.linked || 0}<span className="text-lg text-slate-400 ml-1">/{status?.insurance.total || 0}</span></div>
                        <p className="text-[10px] font-black text-slate-500 mt-1 uppercase tracking-widest">Sincronizados</p>
                    </div>
                </div>

                {/* Especialidades */}
                <div className="bg-white/70 backdrop-blur-xl rounded-[32px] p-6 shadow-sm border border-slate-100/60 flex flex-col justify-between h-40 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 group">
                    <div className="flex justify-between items-start">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-tight">Especialidades<br />VisMed</h3>
                        <div className="h-10 w-10 bg-slate-50 text-slate-400 rounded-2xl flex items-center justify-center transition-all group-hover:bg-blue-600 group-hover:text-white group-hover:shadow-lg">
                            <Stethoscope className="h-5 w-5" />
                        </div>
                    </div>
                    <div>
                        <div className="text-4xl font-black text-slate-900 tracking-tighter">{status?.vismed.stats.specialties || 0}</div>
                        <p className="text-[10px] font-black text-slate-500 mt-1 uppercase tracking-widest">Na Base VisMed</p>
                    </div>
                </div>

                {/* Unidades */}
                <div className="bg-white/70 backdrop-blur-xl rounded-[32px] p-6 shadow-sm border border-slate-100/60 flex flex-col justify-between h-40 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 group">
                    <div className="flex justify-between items-start">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-tight">Unidades<br />Operacionais</h3>
                        <div className="h-10 w-10 bg-slate-50 text-slate-400 rounded-2xl flex items-center justify-center transition-all group-hover:bg-slate-900 group-hover:text-white group-hover:shadow-lg">
                            <Building2 className="h-5 w-5" />
                        </div>
                    </div>
                    <div>
                        <div className="text-4xl font-black text-slate-900 tracking-tighter">{status?.vismed.stats.units || 0}</div>
                        <p className="text-[10px] font-black text-slate-500 mt-1 uppercase tracking-widest">Rede VisMed</p>
                    </div>
                </div>
            </div>

            {/* Fetch Error */}
            {fetchError && (
                <div className="bg-rose-50 border-2 border-rose-100 rounded-[24px] p-6 flex items-center justify-between shadow-sm">
                    <div className="flex items-center gap-4">
                        <div className="h-10 w-10 bg-rose-100 rounded-2xl flex items-center justify-center shrink-0">
                            <WifiOff className="h-5 w-5 text-rose-600" />
                        </div>
                        <div>
                            <p className="text-sm font-black text-rose-800">Falha ao carregar status de sincronização</p>
                            <p className="text-xs text-rose-600 mt-1">Verifique a conexão com o servidor e tente novamente.</p>
                        </div>
                    </div>
                    <button onClick={fetchStatus} className="px-4 py-2 bg-rose-100 hover:bg-rose-200 text-rose-700 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors">
                        Tentar Novamente
                    </button>
                </div>
            )}

            {/* Alerts */}
            {(status?.insurance.pending || 0) > 0 && (
                <div className="bg-amber-50 border-2 border-amber-100 rounded-[24px] p-6 flex items-start gap-4 shadow-sm">
                    <div className="h-10 w-10 bg-amber-100 rounded-2xl flex items-center justify-center shrink-0">
                        <Eye className="h-5 w-5 text-amber-600" />
                    </div>
                    <div>
                        <p className="text-sm font-black text-amber-800">{status?.insurance.pending} convênio(s) aguardando confirmação manual</p>
                        <p className="text-xs text-amber-600 mt-1">Somente correspondências com 100% de match são vinculadas automaticamente. Acesse a Central de Mapeamento para revisar.</p>
                    </div>
                </div>
            )}

            {status?.lastError && (
                <div className="bg-rose-50 border-2 border-rose-100 rounded-[24px] p-6 flex items-start gap-4 shadow-sm">
                    <div className="h-10 w-10 bg-rose-100 rounded-2xl flex items-center justify-center shrink-0">
                        <XCircle className="h-5 w-5 text-rose-600" />
                    </div>
                    <div>
                        <p className="text-sm font-black text-rose-800">Erro na última sincronização</p>
                        <p className="text-xs text-rose-600 mt-1">{status.lastError.message}</p>
                        <p className="text-xs text-rose-400 mt-1">{formatDate(status.lastError.startedAt)}</p>
                    </div>
                </div>
            )}

            {/* Integration Cards */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">

                {/* VisMed API Card */}
                <div className="bg-white/70 backdrop-blur-2xl rounded-[32px] shadow-sm border border-slate-100/80 overflow-hidden flex flex-col group/container transition-all hover:shadow-xl">
                    <div className="p-8 border-b border-slate-100/60 flex justify-between items-center bg-white/40">
                        <div>
                            <h2 className="text-lg font-black text-slate-900 flex items-center gap-3 tracking-tighter uppercase">
                                <Zap className="h-5 w-5 text-primary" />
                                VisMed API
                            </h2>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Central de Dados</p>
                        </div>
                        <span className={`px-4 py-2 rounded-full text-[10px] font-black uppercase tracking-widest shadow-sm ${
                            status?.vismed.connected ? 'bg-primary text-white' : 'bg-slate-100 text-slate-500'
                        }`}>
                            {status?.vismed.connected ? 'Conectado' : 'Desconectado'}
                        </span>
                    </div>
                    <div className="p-8 space-y-5">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="bg-slate-50/80 rounded-2xl p-4">
                                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Profissionais</div>
                                <div className="text-2xl font-black text-slate-900">{status?.vismed.stats.doctors || 0}</div>
                            </div>
                            <div className="bg-slate-50/80 rounded-2xl p-4">
                                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Convênios</div>
                                <div className="text-2xl font-black text-slate-900">{status?.vismed.stats.insurances || 0}</div>
                            </div>
                            <div className="bg-slate-50/80 rounded-2xl p-4">
                                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Especialidades</div>
                                <div className="text-2xl font-black text-slate-900">{status?.vismed.stats.specialties || 0}</div>
                            </div>
                            <div className="bg-slate-50/80 rounded-2xl p-4">
                                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Unidades</div>
                                <div className="text-2xl font-black text-slate-900">{status?.vismed.stats.units || 0}</div>
                            </div>
                        </div>
                        {status?.vismed.lastSync && (
                            <div className="flex items-center justify-between text-xs bg-slate-50/80 rounded-2xl px-5 py-3">
                                <div className="flex items-center gap-2">
                                    <CalendarDays className="h-3.5 w-3.5 text-primary/40" />
                                    <span className="font-black text-slate-500 uppercase tracking-wider">Última Sync</span>
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className="font-bold text-slate-700">{formatDate(status.vismed.lastSync.startedAt)}</span>
                                    <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black uppercase ${
                                        status.vismed.lastSync.status === 'completed' ? 'bg-primary/10 text-primary' : 'bg-amber-100 text-amber-600'
                                    }`}>{status.vismed.lastSync.totalRecords} reg</span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Doctoralia Card */}
                <div className="bg-white/70 backdrop-blur-2xl rounded-[32px] shadow-sm border border-slate-100/80 overflow-hidden flex flex-col group/container transition-all hover:shadow-xl">
                    <div className="p-8 border-b border-slate-100/60 flex justify-between items-center bg-white/40">
                        <div>
                            <h2 className="text-lg font-black text-slate-900 flex items-center gap-3 tracking-tighter uppercase">
                                <GlobeIcon className="h-5 w-5 text-blue-500" />
                                Doctoralia
                            </h2>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Marketplace Externo</p>
                        </div>
                        <span className={`px-4 py-2 rounded-full text-[10px] font-black uppercase tracking-widest shadow-sm ${
                            status?.doctoralia.connected ? 'bg-blue-500 text-white' : 'bg-slate-100 text-slate-500'
                        }`}>
                            {status?.doctoralia.connected ? 'Conectado' : 'Desconectado'}
                        </span>
                    </div>
                    <div className="p-8 space-y-5">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="bg-slate-50/80 rounded-2xl p-4">
                                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Médicos Pareados</div>
                                <div className="text-2xl font-black text-slate-900">{status?.doctors.mapped || 0}</div>
                            </div>
                            <div className="bg-slate-50/80 rounded-2xl p-4">
                                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Convênios Linkados</div>
                                <div className="text-2xl font-black text-emerald-600">{status?.insurance.linked || 0}</div>
                            </div>
                            <div className="bg-slate-50/80 rounded-2xl p-4">
                                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Pendentes Revisão</div>
                                <div className={`text-2xl font-black ${(status?.insurance.pending || 0) > 0 ? 'text-amber-500' : 'text-slate-900'}`}>{status?.insurance.pending || 0}</div>
                            </div>
                            <div className="bg-slate-50/80 rounded-2xl p-4">
                                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Sem Vínculo</div>
                                <div className="text-2xl font-black text-slate-400">{status?.insurance.unlinked || 0}</div>
                            </div>
                        </div>
                        {status?.doctoralia.lastSync && (
                            <div className="flex items-center justify-between text-xs bg-slate-50/80 rounded-2xl px-5 py-3">
                                <div className="flex items-center gap-2">
                                    <CalendarDays className="h-3.5 w-3.5 text-blue-500/40" />
                                    <span className="font-black text-slate-500 uppercase tracking-wider">Última Sync</span>
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className="font-bold text-slate-700">{formatDate(status.doctoralia.lastSync.startedAt)}</span>
                                    <span className="px-2 py-0.5 rounded-lg text-[10px] font-black uppercase bg-blue-50 text-blue-600">{status.doctoralia.lastSync.totalRecords} reg</span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* History */}
            <div className="bg-white/70 backdrop-blur-2xl rounded-[32px] shadow-sm border border-slate-100/80 overflow-hidden transition-all hover:shadow-xl">
                <button
                    onClick={() => setShowHistory(!showHistory)}
                    className="w-full p-8 border-b border-slate-100/60 flex justify-between items-center bg-white/40 hover:bg-slate-50/50 transition-colors"
                >
                    <div className="flex items-center gap-3">
                        <Activity className="h-5 w-5 text-primary" />
                        <h2 className="text-lg font-black text-slate-900 tracking-tighter uppercase">Histórico de Execuções</h2>
                        <span className="text-[10px] bg-slate-100 text-slate-500 px-3 py-1 rounded-full font-black uppercase tracking-widest">{status?.recentRuns.length || 0} recentes</span>
                    </div>
                    {showHistory ? <ChevronUp className="h-5 w-5 text-slate-400" /> : <ChevronDown className="h-5 w-5 text-slate-400" />}
                </button>

                {showHistory && (
                    <div className="divide-y divide-slate-50">
                        {(status?.recentRuns || []).length === 0 ? (
                            <div className="p-20 text-center flex flex-col items-center">
                                <Activity className="h-12 w-12 text-slate-100 mb-4" />
                                <p className="text-[10px] font-black text-slate-300 uppercase tracking-[3px]">Sem atividades registradas</p>
                            </div>
                        ) : (
                            status?.recentRuns.map((run) => (
                                <div key={run.id} className="p-6 px-8 flex items-center justify-between hover:bg-slate-50/50 transition-all cursor-default group/item">
                                    <div className="flex items-center gap-5">
                                        <div className={`h-14 w-14 rounded-2xl flex items-center justify-center shrink-0 border-2 transition-all group-hover/item:scale-105 shadow-lg ${
                                            run.status === 'completed' ? 'bg-white border-emerald-100 text-primary shadow-emerald-100/20' :
                                            run.status === 'running' ? 'bg-white border-blue-100 text-blue-500 shadow-blue-100/20' :
                                            'bg-white border-rose-100 text-rose-500 shadow-rose-100/20'
                                        }`}>
                                            {run.status === 'running' ? <Loader2 className="h-6 w-6 animate-spin" /> :
                                                run.status === 'completed' ? <CheckCircle2 className="h-6 w-6" /> :
                                                <AlertTriangle className="h-6 w-6" />}
                                        </div>
                                        <div>
                                            <h4 className="font-black text-base text-slate-900 leading-none group-hover/item:text-primary transition-colors">
                                                {run.type === 'full' ? 'Doctoralia (Completa)' : run.type === 'vismed-full' ? 'VisMed (Completa)' : 'Parcial'}
                                            </h4>
                                            <div className="flex items-center gap-3 mt-2">
                                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest bg-slate-100 px-2 py-0.5 rounded-lg">ID #{run.id.slice(0, 6)}</span>
                                                <p className="text-[11px] font-bold text-slate-500 uppercase tracking-tight">{run.totalRecords} Registros</p>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-4">
                                        <div className="text-right">
                                            <span className={`px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest shadow-sm ${
                                                run.status === 'completed' ? 'bg-primary text-white' :
                                                run.status === 'running' ? 'bg-blue-500 text-white' :
                                                'bg-rose-500 text-white'
                                            }`}>
                                                {run.status === 'completed' ? 'Sucesso' : run.status === 'running' ? 'Processando' : 'Falha'}
                                            </span>
                                            <p className="text-[10px] font-black text-slate-400 mt-2 flex items-center justify-end gap-1.5 uppercase tracking-widest">
                                                <Clock className="h-3.5 w-3.5 opacity-50" />
                                                {formatDate(run.startedAt)} • {formatDuration(run.startedAt, run.endedAt)}
                                            </p>
                                        </div>
                                        <button
                                            onClick={() => handleOpenRunDetail(run.id)}
                                            className="h-10 w-10 rounded-xl bg-slate-50 text-slate-400 hover:bg-primary hover:text-white transition-all flex items-center justify-center shadow-sm"
                                        >
                                            <FileJson className="h-4 w-4" />
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                )}
            </div>

            {/* JSON Modal */}
            {showJsonModal && selectedRunData && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300">
                    <div className="bg-[#1e1e1e] rounded-[32px] shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden border border-white/10">
                        <div className="p-8 border-b border-white/5 flex justify-between items-center bg-[#252525]">
                            <div className="flex items-center gap-5">
                                <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary border border-primary/20 shadow-lg">
                                    <FileJson className="h-6 w-6" />
                                </div>
                                <div>
                                    <h3 className="text-xl font-black text-white tracking-tight uppercase leading-none mb-1.5">JSON Source Event</h3>
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-[2px]">{selectedRunData.type} • {selectedRunData.id?.slice(0, 8)}</p>
                                </div>
                            </div>
                            <button onClick={() => setShowJsonModal(false)} className="h-12 w-12 flex items-center justify-center rounded-2xl bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition-all">
                                <X className="h-6 w-6" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-auto p-8 bg-[#161616]">
                            <pre className="text-primary font-mono text-[13px] leading-relaxed overflow-x-auto p-6 rounded-3xl bg-black/40 border border-white/5">
                                {JSON.stringify(selectedRunData, null, 4)}
                            </pre>
                        </div>
                        <div className="p-6 border-t border-white/5 bg-[#1e1e1e] flex justify-between items-center">
                            <span className="text-[10px] font-black text-slate-500 uppercase tracking-[3px]">VisMed Secure Logs</span>
                            <button onClick={() => navigator.clipboard.writeText(JSON.stringify(selectedRunData, null, 4))} className="bg-white/5 hover:bg-white/10 text-white px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-[2px] transition-all">
                                Copiar Objeto
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="text-center pt-8 border-t border-slate-100/40">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[4px] leading-relaxed opacity-50 transition-opacity hover:opacity-100">
                    Sincronização Integrada • VisMed + Doctoralia Pipeline • 2026 Build
                </p>
            </div>
        </div>
    );
}

function GlobeIcon(props: any) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
            <circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" />
        </svg>
    );
}
