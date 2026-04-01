'use client';
import { useState, useEffect } from 'react';
import { CheckCircle2, Hourglass, AlertTriangle, Settings2, Users, Loader2, UserSquare2, CalendarDays, ExternalLink, Activity, ShieldCheck, ArrowUpRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useClinic } from '@/lib/clinic-store';
import { useAuthStore } from '@/lib/store';

export default function DashboardOverview() {
    const { user } = useAuthStore();
    const { activeClinic } = useClinic();
    const [isLoading, setIsLoading] = useState(true);

    const [metrics, setMetrics] = useState({
        activeUsers: 0,
        totalUsers: 0,
        activeClinics: 0,
        totalClinics: 0,
        syncedDoctors: 0,
        linkedDoctors: 0,
        unlinkedDoctors: 0,
        calendarEnabled: false,
        syncHealth: 100,
        recentLogs: [] as any[],
        doctorsList: [] as any[],
        vismedStats: { units: 0, doctors: 0, specialties: 0 },
    });

    useEffect(() => {
        const fetchDashboardData = async () => {
            if (!user || !activeClinic) return;
            try {
                const clinicId = activeClinic.id;

                const [usersRes, clinicsRes, syncRes, doctorsCountRes, calendarRes, doctorsRes, vismedRes] = await Promise.all([
                    api.get('/users').catch(() => ({ data: [] })),
                    api.get('/clinics').catch(() => ({ data: [] })),
                    api.get(`/sync/${clinicId}/history`).catch(() => ({ data: [] })),
                    api.get('/doctors/count', { params: { clinicId } }).catch(() => ({ data: { total: 0, linked: 0, unlinked: 0 } })),
                    api.get('/appointments/calendar-status', { params: { clinicId } }).catch(() => ({ data: { calendarEnabled: false } })),
                    api.get('/doctors', { params: { clinicId } }).catch(() => ({ data: [] })),
                    api.get('/sync/vismed/stats').catch(() => ({ data: { units: 0, doctors: 0, specialties: 0 } })),
                ]);

                const allUsers = usersRes.data || [];
                const activeU = allUsers.filter((u: any) => u.active).length;

                const allClinics = clinicsRes.data || [];
                const activeC = allClinics.filter((c: any) => c.active).length;

                const allLogs = syncRes.data || [];
                let health = 100;
                if (allLogs.length > 0) {
                    const successLogs = allLogs.filter((l: any) => l.status === 'completed' || l.status === 'success').length;
                    health = Math.round((successLogs / allLogs.length) * 100);
                }

                const topLogs = allLogs.slice(0, 3).map((log: any) => {
                    let logStatus: 'success' | 'warning' | 'failed' | 'pending' = 'pending';
                    if (log.status === 'completed' || log.status === 'success') logStatus = 'success';
                    else if (log.status === 'partially' || log.status === 'warning') logStatus = 'warning';
                    else if (log.status === 'failed' || log.status === 'error') logStatus = 'failed';
                    return {
                        id: log.id,
                        type: log.type === 'full' ? 'Sincronização Completa' : 'Parcial',
                        records: log.totalRecords || 0,
                        status: logStatus,
                        startedAt: log.startedAt
                    };
                });

                setMetrics({
                    activeUsers: activeU,
                    totalUsers: allUsers.length,
                    activeClinics: activeC,
                    totalClinics: allClinics.length,
                    syncedDoctors: doctorsCountRes.data?.total || 0,
                    linkedDoctors: doctorsCountRes.data?.linked || 0,
                    unlinkedDoctors: doctorsCountRes.data?.unlinked || 0,
                    calendarEnabled: calendarRes.data?.calendarEnabled || false,
                    syncHealth: health,
                    recentLogs: topLogs,
                    doctorsList: (doctorsRes.data || []).slice(0, 5),
                    vismedStats: vismedRes.data || { units: 0, doctors: 0, specialties: 0 },
                });
            } catch (error) {
                console.error("Failed to load dashboard metrics", error);
            } finally {
                setIsLoading(false);
            }
        };

        fetchDashboardData();
    }, [user, activeClinic]);

    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] animate-in fade-in duration-700">
                <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
                <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-[4px]">Carregando Plataforma</h2>
            </div>
        );
    }

    return (
        <div className="max-w-7xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Header Glassmorphism */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                <div className="flex items-center gap-5">
                    <div className="h-16 w-16 rounded-[24px] bg-gradient-to-br from-primary to-emerald-600 flex items-center justify-center shadow-[0_12px_24px_-8px_rgba(31,181,122,0.4)] border border-white/20 transform rotate-1 transition-transform hover:rotate-0 duration-500">
                        <Activity className="h-8 w-8 text-white" />
                    </div>
                    <div>
                        <div className="flex items-center gap-3 mb-1">
                            <h1 className="text-3xl font-black text-slate-900 tracking-tighter">Visão Geral</h1>
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-emerald-50 text-emerald-700 border border-emerald-100 shadow-sm animate-pulse">
                                <Activity className="h-3 w-3" /> Live
                            </span>
                        </div>
                        <p className="text-sm text-slate-500 font-bold uppercase tracking-wide flex items-center gap-2">
                            Monitoramento de Saúde e Sincronismo da Clínica
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2 px-6 py-3 bg-white/40 backdrop-blur-md rounded-2xl border border-slate-100/60 shadow-sm">
                    <div className="text-right">
                        <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Unidade Ativa</div>
                        <div className="text-sm font-black text-slate-900">{activeClinic?.name}</div>
                    </div>
                    <div className="h-8 w-[1px] bg-slate-100 mx-2"></div>
                    <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                        <Settings2 className="h-4 w-4" />
                    </div>
                </div>
            </div>

            {/* KPI Grid - Glassmorphism Green Theme */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-6">

                {/* Sync Health (Destacado) */}
                <div className="bg-white/70 backdrop-blur-xl rounded-[32px] p-6 shadow-sm border border-slate-100/60 flex flex-col justify-between h-40 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 group border-r-4 border-r-primary">
                    <div className="flex justify-between items-start">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-tight">Saúde de<br />Sincronismo</h3>
                        <div className={`h-10 w-10 rounded-2xl flex items-center justify-center shadow-lg transition-transform group-hover:scale-110 ${metrics.syncHealth >= 90 ? 'bg-primary text-white' : 'bg-rose-500 text-white'}`}>
                            <ShieldCheck className="h-5 w-5" />
                        </div>
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <div className="text-4xl font-black text-slate-900 tracking-tighter">{metrics.syncHealth}%</div>
                            <div className={`h-2.5 w-2.5 rounded-full animate-ping ${metrics.syncHealth >= 90 ? 'bg-primary' : 'bg-rose-500'}`}></div>
                        </div>
                        <div className="h-1.5 w-full bg-slate-100 rounded-full mt-3 overflow-hidden">
                            <div className={`h-full rounded-full transition-all duration-1000 ${metrics.syncHealth >= 90 ? 'bg-primary' : 'bg-rose-500'}`} style={{ width: `${metrics.syncHealth}%` }}></div>
                        </div>
                    </div>
                </div>

                {/* VISMED Base */}
                <div className="bg-slate-900 rounded-[32px] p-6 shadow-2xl flex flex-col justify-between h-40 transition-all duration-300 hover:scale-[1.02] hover:shadow-primary/20 group relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-primary/20 rounded-full blur-3xl -mr-16 -mt-16 animate-pulse"></div>
                    <div className="flex justify-between items-start relative z-10">
                        <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest leading-tight">VisMed<br />Ecosystem</h3>
                        <div className="h-10 w-10 bg-white/10 rounded-2xl flex items-center justify-center text-primary backdrop-blur-sm transition-all group-hover:bg-primary group-hover:text-white">
                            <Activity className="h-5 w-5" />
                        </div>
                    </div>
                    <div className="relative z-10">
                        <div className="text-4xl font-black text-white tracking-tighter">{metrics.vismedStats.doctors}</div>
                        <p className="text-[10px] font-black text-slate-500 mt-1 uppercase tracking-widest">Profissionais na Base</p>
                    </div>
                </div>

                {/* Synced Doctors */}
                <div className="bg-white/70 backdrop-blur-xl rounded-[32px] p-6 shadow-sm border border-slate-100/60 flex flex-col justify-between h-40 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 group">
                    <div className="flex justify-between items-start">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-tight">Sincronismo<br />Externo</h3>
                        <div className="h-10 w-10 bg-slate-50 text-slate-400 rounded-2xl flex items-center justify-center transition-all group-hover:bg-primary group-hover:text-white group-hover:shadow-lg group-hover:shadow-primary/30">
                            <UserSquare2 className="h-5 w-5" />
                        </div>
                    </div>
                    <div>
                        <div className="text-4xl font-black text-slate-900 tracking-tighter">{metrics.syncedDoctors}</div>
                        <div className="flex items-center gap-1.5 mt-1">
                            <div className="h-1.5 w-1.5 rounded-full bg-primary"></div>
                            <p className="text-[10px] font-black text-primary uppercase tracking-widest">{metrics.linkedDoctors} Pareados</p>
                        </div>
                    </div>
                </div>

                {/* Users */}
                <div className="bg-white/70 backdrop-blur-xl rounded-[32px] p-6 shadow-sm border border-slate-100/60 flex flex-col justify-between h-40 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 group">
                    <div className="flex justify-between items-start">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-tight">Acessos<br />Plataforma</h3>
                        <div className="h-10 w-10 bg-slate-50 text-slate-400 rounded-2xl flex items-center justify-center transition-all group-hover:bg-slate-900 group-hover:text-white group-hover:shadow-lg">
                            <Users className="h-5 w-5" />
                        </div>
                    </div>
                    <div>
                        <div className="text-4xl font-black text-slate-900 tracking-tighter">{metrics.activeUsers}</div>
                        <p className="text-[10px] font-black text-slate-500 mt-1 uppercase tracking-widest">Membros Integrados</p>
                    </div>
                </div>

                {/* Clinics */}
                <div className="bg-white/70 backdrop-blur-xl rounded-[32px] p-6 shadow-sm border border-slate-100/60 flex flex-col justify-between h-40 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 group">
                    <div className="flex justify-between items-start">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-tight">Unidades<br />Monitoradas</h3>
                        <div className="h-10 w-10 bg-slate-50 text-slate-400 rounded-2xl flex items-center justify-center transition-all group-hover:bg-blue-600 group-hover:text-white group-hover:shadow-lg">
                            <Settings2 className="h-5 w-5" />
                        </div>
                    </div>
                    <div>
                        <div className="text-4xl font-black text-slate-900 tracking-tighter">{metrics.activeClinics}</div>
                        <p className="text-[10px] font-black text-slate-500 mt-1 uppercase tracking-widest">Rede VisMed</p>
                    </div>
                </div>

                {/* Calendar Online */}
                <div className="bg-white/70 backdrop-blur-xl rounded-[32px] p-6 shadow-sm border border-slate-100/60 flex flex-col justify-between h-40 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 group">
                    <div className="flex justify-between items-start">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-tight">Status do<br />Calendário</h3>
                        <div className={`h-10 w-10 rounded-2xl flex items-center justify-center shadow-md transition-all ${metrics.calendarEnabled ? 'bg-emerald-50 text-emerald-600 group-hover:bg-primary group-hover:text-white' : 'bg-rose-50 text-rose-500 group-hover:bg-rose-500 group-hover:text-white'}`}>
                            <CalendarDays className="h-5 w-5" />
                        </div>
                    </div>
                    <div>
                        <div className={`text-2xl font-black tracking-tighter uppercase leading-none ${metrics.calendarEnabled ? 'text-primary' : 'text-rose-500'}`}>
                            {metrics.calendarEnabled ? 'Online' : 'Offline'}
                        </div>
                        <p className="text-[10px] font-black text-slate-400 mt-2 uppercase tracking-widest">Direct Sync</p>
                    </div>
                </div>
            </div>

            {/* Listagens Premium */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">

                {/* Recent Sync Table Pattern */}
                <div className="bg-white/70 backdrop-blur-2xl rounded-[32px] shadow-sm border border-slate-100/80 overflow-hidden flex flex-col group/container transition-all hover:shadow-xl">
                    <div className="p-8 border-b border-slate-100/60 flex justify-between items-center bg-white/40">
                        <div>
                            <h2 className="text-lg font-black text-slate-900 flex items-center gap-3 tracking-tighter uppercase">
                                <Activity className="h-5 w-5 text-primary" />
                                Histórico Ativo
                            </h2>
                        </div>
                        <button className="h-10 w-10 rounded-xl bg-slate-50 text-slate-400 hover:bg-primary hover:text-white transition-all flex items-center justify-center shadow-sm">
                            <ArrowUpRight className="h-5 w-5" />
                        </button>
                    </div>
                    <div className="divide-y divide-slate-50 flex-1">
                        {metrics.recentLogs.length === 0 ? (
                            <div className="p-20 text-center flex flex-col items-center">
                                <Activity className="h-12 w-12 text-slate-100 mb-4" />
                                <p className="text-[10px] font-black text-slate-300 uppercase tracking-[3px]">Sem atividades</p>
                            </div>
                        ) : (
                            metrics.recentLogs.map((log: any) => (
                                <div key={log.id} className="p-6 px-8 flex items-center justify-between hover:bg-slate-50/50 transition-all cursor-default group/item">
                                    <div className="flex items-center gap-5">
                                        <div className={`h-14 w-14 rounded-2xl flex items-center justify-center shrink-0 border-2 transition-all group-hover/item:scale-105 ${log.status === 'success' ? 'bg-white border-emerald-100 text-primary shadow-emerald-100/20' :
                                            log.status === 'pending' ? 'bg-white border-blue-100 text-blue-500 shadow-blue-100/20' :
                                                'bg-white border-rose-100 text-rose-500 shadow-rose-100/20'
                                            } shadow-lg`}>
                                            {log.status === 'success' ? <CheckCircle2 className="h-6 w-6" /> :
                                                log.status === 'pending' ? <Loader2 className="h-6 w-6 animate-spin" /> :
                                                    <AlertTriangle className="h-6 w-6" />}
                                        </div>
                                        <div>
                                            <h4 className="font-black text-base text-slate-900 leading-none group-hover/item:text-primary transition-colors">{log.type}</h4>
                                            <div className="flex items-center gap-3 mt-2">
                                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest bg-slate-100 px-2 py-0.5 rounded-lg">ID #{log.id.slice(0, 6)}</span>
                                                <p className="text-[11px] font-bold text-slate-500 uppercase tracking-tight">{log.records} Registros</p>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <span className={`px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest shadow-sm ${log.status === 'success' ? 'bg-primary text-white' :
                                            log.status === 'pending' ? 'bg-blue-500 text-white' :
                                                'bg-rose-500 text-white'
                                            }`}>
                                            {log.status === 'success' ? 'Sucesso' : log.status === 'pending' ? 'Processando' : 'Falha'}
                                        </span>
                                        <p className="text-[10px] font-black text-slate-400 mt-2.5 flex items-center justify-end gap-1.5 uppercase tracking-widest">
                                            <CalendarDays className="h-3.5 w-3.5 opacity-50" />
                                            {new Date(log.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                        </p>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {/* Synced Doctors Compact List */}
                <div className="bg-white/70 backdrop-blur-2xl rounded-[32px] shadow-sm border border-slate-100/80 overflow-hidden flex flex-col group/container transition-all hover:shadow-xl">
                    <div className="p-8 border-b border-slate-100/60 flex justify-between items-center bg-white/40">
                        <h2 className="text-lg font-black text-slate-900 flex items-center gap-3 tracking-tighter uppercase">
                            <UserSquare2 className="h-5 w-5 text-primary" />
                            Profissionais Ativos
                        </h2>
                        <button className="h-10 w-10 rounded-xl bg-slate-50 text-slate-400 hover:bg-primary hover:text-white transition-all flex items-center justify-center shadow-sm">
                            <ArrowUpRight className="h-5 w-5" />
                        </button>
                    </div>
                    <div className="divide-y divide-slate-50 flex-1">
                        {metrics.doctorsList.length === 0 ? (
                            <div className="p-20 text-center flex flex-col items-center">
                                <Users className="h-12 w-12 text-slate-100 mb-4" />
                                <p className="text-[10px] font-black text-slate-300 uppercase tracking-[3px]">Sem mapeamentos</p>
                            </div>
                        ) : (
                            metrics.doctorsList.map((doc: any, i: number) => (
                                <div key={doc.id || i} className="p-6 px-8 flex items-center justify-between hover:bg-slate-50/50 transition-all cursor-default group/item">
                                    <div className="flex items-center gap-5">
                                        <div className="h-14 w-14 rounded-[20px] bg-gradient-to-br from-white to-slate-50 border-2 border-white shadow-xl flex items-center justify-center text-slate-900 font-black text-lg shrink-0 transition-all group-hover/item:scale-105 group-hover/item:border-primary/20">
                                            {(doc.fullName || doc.name || '?').split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase()}
                                        </div>
                                        <div>
                                            <h4 className="font-black text-base text-slate-900 leading-none group-hover/item:text-primary transition-colors">{doc.fullName || doc.name}</h4>
                                            <div className="flex items-center gap-2.5 mt-2">
                                                <div className="h-2 w-2 rounded-full bg-primary/40 animate-pulse"></div>
                                                <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest">CRM {doc.crm || 'N/A'}</p>
                                            </div>
                                        </div>
                                    </div>
                                    <span className={`px-4 py-2 rounded-2xl text-[10px] font-black uppercase tracking-[2px] border-2 transition-all ${doc.status === 'LINKED'
                                        ? 'border-emerald-50 bg-emerald-50 text-primary shadow-sm'
                                        : 'border-slate-50 bg-slate-50 text-slate-400'
                                        }`}>
                                        {doc.status === 'LINKED' ? 'Pareado' : 'Pendente'}
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>

            <div className="text-center pt-8 border-t border-slate-100/40">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[4px] leading-relaxed opacity-50 transition-opacity hover:opacity-100">
                    Sincronização Ativa • VisMed Integrated Ecosystem • 2026 Build
                </p>
            </div>
        </div>
    );
}
