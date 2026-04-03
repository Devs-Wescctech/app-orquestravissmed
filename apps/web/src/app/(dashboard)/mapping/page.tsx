'use client';
import { useState, useEffect, useCallback } from 'react';
import {
    RefreshCw, FileText, CheckCircle2, AlertTriangle,
    User, Loader2, Building2, Stethoscope, Link2, Link2Off, ShieldCheck, Globe, Settings, KeyRound, ArrowUpRight,
    Calendar, CalendarOff, ToggleLeft, ToggleRight, Activity
} from 'lucide-react';
import { api } from '@/lib/api';
import { fetchProfessionalMappings, fetchSpecialtyMatches, fetchUnitMappings, fetchLegacyMappings, fetchSpecialtyStats } from '@/lib/mapping-data';
import { useAuthStore } from '@/lib/store';
import { useClinic } from '@/lib/clinic-store';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface VismedProfessional {
    id: string; vismedId: number; name: string; formalName?: string;
    documentNumber?: string; documentType?: string; gender?: string; isActive: boolean;
    unit?: { name: string; city?: string } | null;
    turnos?: { turnoM: string | null; turnoT: string | null; turnoN: string | null };
    specialties: Array<{
        id: string; name: string; normalizedName?: string;
        activeMatch?: {
            matchType: string; confidenceScore: number;
            requiresReview: boolean; doctoraliaService?: string;
        } | null;
    }>;
    doctoraliaCounterpart?: {
        name: string; doctoraliaDoctorId: string; services: string[];
        calendarStatus?: 'enabled' | 'disabled' | 'unknown';
    } | null;
}

interface VismedUnit {
    id: string; vismedId: number; name: string;
    cityName?: string; cnpj?: string; isActive: boolean;
    doctorCount: number;
    linkedDoctors?: string[];
    doctoraliaCounterpart?: {
        name: string;
        externalId: string;
        status: string;
    } | null;
}

interface SpecialtyMatch {
    id: string; vismedSpecialtyId: string; doctoraliaServiceId: string;
    matchType: string; confidenceScore: number; requiresReview: boolean; isActive: boolean;
    vismedSpecialty?: { name: string; normalizedName?: string } | null;
    doctoraliaService?: { name: string } | null;
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
export default function MappingHub() {
    const { user } = useAuthStore();
    const { activeClinic } = useClinic();

    const [activeTab, setActiveTab] = useState('Profissionais');
    const [isSyncing, setIsSyncing] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isResolving, setIsResolving] = useState(false);
    const [updatingCalendarIds, setUpdatingCalendarIds] = useState<Set<string>>(new Set());

    // Per-tab data
    const [professionals, setProfessionals] = useState<VismedProfessional[]>([]);
    const [units, setUnits] = useState<VismedUnit[]>([]);
    const [specialtyMatches, setSpecialtyMatches] = useState<SpecialtyMatch[]>([]);
    const [legacyMappings, setLegacyMappings] = useState<any[]>([]);
    const [specStats, setSpecStats] = useState<any>(null);

    // Resolve modal (legacy Convênios tab)
    const [showResolveModal, setShowResolveModal] = useState(false);
    const [selectedMapping, setSelectedMapping] = useState<any>(null);

    const TABS = ['Profissionais', 'Especialidades', 'Convênios', 'Unidades'];

    // ------------------------------------------------------------------
    // Fetch
    // ------------------------------------------------------------------
    const fetchData = useCallback(async () => {
        if (!user) return;
        setIsLoading(true);
        try {
            const clinicId = activeClinic?.id || '';
            if (activeTab === 'Profissionais') {
                const data = await fetchProfessionalMappings(clinicId);
                setProfessionals(data || []);
            } else if (activeTab === 'Especialidades') {
                const [data, stats] = await Promise.all([
                    fetchSpecialtyMatches(clinicId),
                    fetchSpecialtyStats(),
                ]);
                setSpecialtyMatches(data || []);
                setSpecStats(stats);
            } else if (activeTab === 'Unidades') {
                const data = await fetchUnitMappings(clinicId);
                setUnits(data || []);
            } else {
                const data = await fetchLegacyMappings(clinicId, 'INSURANCE');
                setLegacyMappings(data || []);
            }
        } catch (err) {
            console.error('fetchData error', err);
        } finally {
            setIsLoading(false);
        }
    }, [user, activeTab, activeClinic?.id]);

    useEffect(() => { fetchData(); }, [fetchData]);

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------
    const handleSync = async () => {
        if (!activeClinic) return;
        setIsSyncing(true);
        try {
            await api.post(`/sync/${activeClinic.id}/global`);
            toast.success('Sincronização iniciada com sucesso. Os dados serão atualizados em instantes.');
            setTimeout(() => { 
                fetchData(); 
                setIsSyncing(false); 
            }, 3000);
        } catch (err: any) { 
            console.error('Sync error:', err);
            toast.error(`Falha na sincronização: ${err.message || 'Erro desconhecido'}`);
            setIsSyncing(false); 
        }
    };

    const handleApprove = async (vismedSpecialtyId: string, doctoraliaServiceId: string) => {
        setIsResolving(true);
        try {
            await api.post('/mappings/specialties/approve', { vismedSpecialtyId, doctoraliaServiceId });
            fetchData();
        } finally { setIsResolving(false); }
    };

    const handleReject = async (vismedSpecialtyId: string, doctoraliaServiceId: string) => {
        if (!confirm('Rejeitar e invalidar este match permanentemente?')) return;
        setIsResolving(true);
        try {
            await api.post('/mappings/specialties/reject', { vismedSpecialtyId, doctoraliaServiceId });
            fetchData();
        } finally { setIsResolving(false); }
    };



    const handleToggleCalendar = async (professionalId: string, doctoraliaDoctorId: string, currentStatus: string) => {
        const newStatus = currentStatus === 'enabled' ? 'disabled' : 'enabled';
        
        setUpdatingCalendarIds(prev => new Set(prev).add(professionalId));
        
        try {
            const endpoint = newStatus === 'enabled'
                ? `/sync/${activeClinic?.id}/calendar/${doctoraliaDoctorId}/enable`
                : `/sync/${activeClinic?.id}/calendar/${doctoraliaDoctorId}/disable`;
            await api.post(endpoint);
            toast.success(`Calendário ${newStatus === 'enabled' ? 'habilitado' : 'desabilitado'} com sucesso.`);
            await fetchData();
        } catch (err) {
            console.error('handleToggleCalendar error', err);
            toast.error('Erro ao atualizar status do calendário.');
        } finally {
            setUpdatingCalendarIds(prev => {
                const next = new Set(prev);
                next.delete(professionalId);
                return next;
            });
        }
    };

    const handleResolveConflict = async (dataToKeep: 'VISMED' | 'EXTERNAL') => {
        if (!selectedMapping) return;
        setIsResolving(true);
        try {
            await api.post(`/mappings/${selectedMapping.id}/resolve`, { dataToKeep });
            setShowResolveModal(false); setSelectedMapping(null);
            fetchData();
        } finally { setIsResolving(false); }
    };

    const handlePushInsurance = async (doctoraliaInsuranceId: string) => {
        if (!activeClinic) return;
        setIsResolving(true);
        try {
            await api.post(`/sync/${activeClinic.id}/insurances/push`, { insuranceProviderId: doctoraliaInsuranceId });
            toast.success('Sincronismo de convênio iniciado na Doctoralia em massa.');
        } catch (err: any) {
            toast.error(`Falha ao sincronizar convênio: ${err.message}`);
        } finally {
            setIsResolving(false);
        }
    };

    const handleApproveInsurance = async (mappingId: string) => {
        setIsResolving(true);
        try {
            await api.post('/mappings/insurance/approve', { mappingId });
            toast.success('Convênio aprovado com sucesso.');
            fetchData();
            if (activeClinic?.id) {
                api.post(`/sync/${activeClinic.id}/insurance`).then(() => {
                    toast.success('Convênios sincronizados com profissionais na Doctoralia.');
                }).catch(() => {});
            }
        } catch (err: any) {
            toast.error(`Falha ao aprovar convênio: ${err.message}`);
        } finally {
            setIsResolving(false);
        }
    };

    const handleRejectInsurance = async (mappingId: string) => {
        if (!confirm('Rejeitar este match de convênio?')) return;
        setIsResolving(true);
        try {
            await api.post('/mappings/insurance/reject', { mappingId });
            toast.success('Convênio rejeitado.');
            fetchData();
        } catch (err: any) {
            toast.error(`Falha ao rejeitar convênio: ${err.message}`);
        } finally {
            setIsResolving(false);
        }
    };



    // ------------------------------------------------------------------
    // Metrics (per-tab)
    // ------------------------------------------------------------------
    const profMetrics = {
        total: professionals.length,
        linked: professionals.filter(p => !!p.doctoraliaCounterpart).length,
        withSpecialties: professionals.filter(p => p.specialties.length > 0).length,
        pendingReview: professionals.filter(p => p.specialties.some(s => s.activeMatch?.requiresReview)).length,
    };
    const specMetrics = {
        confirmed: specialtyMatches.filter(m => !m.requiresReview).length,
        pending: specialtyMatches.filter(m => m.requiresReview).length,
    };

    // ------------------------------------------------------------------
    // Render
    // ------------------------------------------------------------------
    return (
        <div className="max-w-7xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Header Moderno */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div className="flex items-center gap-5">
                    <div className="h-16 w-16 rounded-[24px] bg-gradient-to-br from-primary to-emerald-600 flex items-center justify-center shadow-[0_12px_24px_-8px_rgba(31,181,122,0.4)] border border-white/20 transform rotate-1 transition-transform hover:rotate-0 duration-500">
                        <Link2 className="h-8 w-8 text-white" />
                    </div>
                    <div>
                        <div className="flex items-center gap-3 mb-1">
                            <h1 className="text-3xl font-black text-slate-900 tracking-tighter uppercase">Central de Mapeamento</h1>
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-emerald-50 text-emerald-700 border border-emerald-100 shadow-sm" title="Bidirecional Ativo">
                                <ShieldCheck className="h-3 w-3" /> Bidirecional
                            </span>
                        </div>
                        <p className="text-sm text-slate-500 font-bold uppercase tracking-wide">Sincronização inteligente e integridade de dados na infraestrutura VisMed</p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={handleSync} disabled={isSyncing}
                        className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-6 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-xl transition-all hover:-translate-y-1 active:scale-95 disabled:opacity-70"
                    >
                        <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
                        {isSyncing ? 'Sincronizando' : 'Sincronizar'}
                    </button>
                </div>
            </div>

            {/* Metrics Glass Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                {[
                    { label: 'Total VisMed', value: profMetrics.total, icon: <User className="h-6 w-6" />, color: 'from-slate-500 to-slate-700' },
                    { label: 'Vinculados', value: profMetrics.linked, icon: <CheckCircle2 className="h-6 w-6" />, color: 'from-primary to-emerald-600' },
                    { label: 'Especialidades', value: profMetrics.withSpecialties, icon: <Stethoscope className="h-6 w-6" />, color: 'from-emerald-400 to-primary' },
                    { label: 'Pendente Review', value: profMetrics.pendingReview, icon: <AlertTriangle className="h-6 w-6" />, color: 'from-orange-400 to-rose-500' },
                ].map(m => (
                    <div key={m.label} className="bg-white/70 backdrop-blur-xl rounded-[32px] p-6 shadow-sm border border-slate-100/60 flex flex-col justify-between h-36 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 group">
                        <div className="flex justify-between items-start">
                            <div className={`h-12 w-12 rounded-2xl bg-gradient-to-br ${m.color} flex items-center justify-center text-white shadow-lg transition-transform group-hover:scale-110 group-hover:rotate-3`}>
                                {m.icon}
                            </div>
                            <div className="text-right">
                                <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 leading-none">{m.label}</h3>
                                <div className="text-3xl font-black text-slate-900 tracking-tighter">
                                    {isLoading ? <Loader2 className="h-6 w-6 animate-spin text-slate-300" /> : m.value}
                                </div>
                            </div>
                        </div>
                        <div className="w-full bg-slate-100/50 h-1.5 rounded-full overflow-hidden mt-4">
                            <div className={`h-full bg-gradient-to-r ${m.color}`} style={{ width: m.value > 0 ? '70%' : '0%' }}></div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Tabs Glass Navigation */}
            <div className="bg-white/40 backdrop-blur-md rounded-[28px] p-2 flex gap-2 border border-slate-100/60 w-fit">
                {TABS.map(tab => (
                    <button key={tab} onClick={() => setActiveTab(tab)}
                        className={`px-8 py-3 rounded-2xl text-[10px] font-black uppercase tracking-[2px] transition-all duration-300 ${activeTab === tab
                            ? 'bg-primary text-white shadow-lg shadow-primary/20 scale-105'
                            : 'text-slate-400 hover:text-slate-600 hover:bg-white/50'}`}>
                        {tab}
                    </button>
                ))}
            </div>

            {/* ── PROFISSIONAIS ─────────────────────────────────────── */}
            {activeTab === 'Profissionais' && (
                <div className="bg-white/70 backdrop-blur-xl rounded-[32px] shadow-sm border border-slate-100/80 overflow-hidden animate-in fade-in slide-in-from-top-4 duration-500">
                    <div className="p-8 border-b border-slate-100/60 flex justify-between items-center bg-white/40">
                        <h3 className="text-[12px] font-black text-slate-900 uppercase tracking-[2px]">Relação de Profissionais & Vínculos</h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm text-left border-separate border-spacing-0">
                            <thead className="bg-slate-50/50 text-[10px] text-slate-400 uppercase font-black tracking-[2px] border-b border-slate-100">
                                <tr>
                                    <th className="px-6 py-5 w-[24%]">Profissional</th>
                                    <th className="px-4 py-5 w-[14%]">Turnos</th>
                                    <th className="px-4 py-5 w-[18%]">Especialidades</th>
                                    <th className="px-4 py-5 w-[22%]">Vínculo Doctoralia</th>
                                    <th className="px-4 py-5 w-[10%] text-center">Calendário</th>
                                    <th className="px-4 py-5 w-[12%] text-center">Status Sync</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {isLoading ? (
                                    <tr><td colSpan={6} className="px-10 py-24 text-center">
                                        <div className="flex flex-col items-center gap-4">
                                            <Loader2 className="h-12 w-12 animate-spin text-primary" />
                                            <span className="text-[10px] font-black text-slate-300 uppercase tracking-[4px]">Sincronizando registros...</span>
                                        </div>
                                    </td></tr>
                                ) : professionals.length === 0 ? (
                                    <tr><td colSpan={6} className="px-10 py-24 text-center">
                                        <div className="max-w-xs mx-auto opacity-30">
                                            <User className="h-16 w-16 text-slate-200 mx-auto mb-6" />
                                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] leading-tight text-center">Nenhum profissional<br />sincronizado hoje.</p>
                                        </div>
                                    </td></tr>
                                ) : professionals.map(p => (
                                    <tr key={p.id} className="group hover:bg-emerald-50/20 transition-all duration-300 align-top">
                                        <td className="px-6 py-5">
                                            <div className="flex items-start gap-4">
                                                <div className="h-11 w-11 rounded-2xl bg-gradient-to-br from-white to-slate-50 text-slate-900 flex items-center justify-center shrink-0 font-black text-lg border-2 border-white shadow-lg group-hover:from-primary group-hover:to-emerald-600 group-hover:text-white transition-all duration-500">
                                                    {(p.name || '?').charAt(0).toUpperCase()}
                                                </div>
                                                <div className="min-w-0">
                                                    <div className="font-black text-sm text-slate-900 leading-tight group-hover:text-primary transition-colors tracking-tight truncate">{p.name}</div>
                                                    <div className="flex flex-wrap items-center gap-2 mt-1.5">
                                                        {p.documentNumber && (
                                                            <span className="text-[9px] font-black text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded uppercase tracking-wider">
                                                                {p.documentType || 'CRM'}: {p.documentNumber}
                                                            </span>
                                                        )}
                                                        {p.unit && (
                                                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                                                                <span className="h-1 w-1 rounded-full bg-primary/40 inline-block"></span>
                                                                {p.unit.name}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-4 py-5">
                                            {(p.turnos?.turnoM || p.turnos?.turnoT || p.turnos?.turnoN) ? (
                                                <div className="inline-flex flex-col gap-1">
                                                    {p.turnos.turnoM && (
                                                        <div className="flex items-center gap-1.5">
                                                            <span className="text-[8px] font-black text-amber-600 bg-amber-50 w-5 h-5 rounded flex items-center justify-center leading-none">M</span>
                                                            <span className="text-[10px] font-semibold text-slate-600 tabular-nums whitespace-nowrap">{p.turnos.turnoM}</span>
                                                        </div>
                                                    )}
                                                    {p.turnos.turnoT && (
                                                        <div className="flex items-center gap-1.5">
                                                            <span className="text-[8px] font-black text-blue-600 bg-blue-50 w-5 h-5 rounded flex items-center justify-center leading-none">T</span>
                                                            <span className="text-[10px] font-semibold text-slate-600 tabular-nums whitespace-nowrap">{p.turnos.turnoT}</span>
                                                        </div>
                                                    )}
                                                    {p.turnos.turnoN && (
                                                        <div className="flex items-center gap-1.5">
                                                            <span className="text-[8px] font-black text-violet-600 bg-violet-50 w-5 h-5 rounded flex items-center justify-center leading-none">N</span>
                                                            <span className="text-[10px] font-semibold text-slate-600 tabular-nums whitespace-nowrap">{p.turnos.turnoN}</span>
                                                        </div>
                                                    )}
                                                </div>
                                            ) : (
                                                <span className="text-[9px] font-bold text-slate-300 uppercase tracking-wider">Sem turno</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-5">
                                            {p.specialties.length === 0 ? (
                                                <span className="text-[9px] font-bold text-slate-300 uppercase tracking-wider">—</span>
                                            ) : (
                                                <div className="flex flex-wrap gap-1.5">
                                                    {p.specialties.map(s => (
                                                        <span key={s.id} className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[9px] font-black border uppercase tracking-wider transition-all ${s.activeMatch
                                                            ? 'border-emerald-100 bg-emerald-50 text-primary'
                                                            : 'border-slate-100 bg-slate-50 text-slate-400'}`}>
                                                            {s.activeMatch
                                                                ? <CheckCircle2 className="h-3 w-3" />
                                                                : <Link2Off className="h-3 w-3 opacity-40" />
                                                            }
                                                            {s.name}
                                                            {s.activeMatch?.requiresReview && (
                                                                <AlertTriangle className="h-3 w-3 text-orange-500 ml-0.5" />
                                                            )}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-5">
                                            {p.doctoraliaCounterpart ? (
                                                <div className="flex items-center gap-3">
                                                    <div className="h-9 w-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0 border border-primary/20">
                                                        <ShieldCheck className="h-4 w-4" />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <div className="text-xs font-black text-slate-900 leading-tight truncate">{p.doctoraliaCounterpart.name}</div>
                                                        <div className="flex items-center gap-1 mt-1">
                                                            <span className="h-1.5 w-1.5 rounded-full bg-primary"></span>
                                                            <span className="text-[9px] font-black text-primary uppercase tracking-wider">Vinculado</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-3 text-slate-300">
                                                    <div className="h-9 w-9 rounded-xl bg-slate-50 flex items-center justify-center border border-slate-100">
                                                        <Link2Off className="h-4 w-4 opacity-40" />
                                                    </div>
                                                    <span className="text-[9px] font-bold uppercase tracking-wider opacity-60">Pendente</span>
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-5 text-center">
                                            {p.doctoraliaCounterpart ? (
                                                (() => {
                                                    const isUpdating = updatingCalendarIds.has(p.id);
                                                    const isEnabled = p.doctoraliaCounterpart.calendarStatus === 'enabled';
                                                    return (
                                                        <button
                                                            onClick={() => handleToggleCalendar(p.id, p.doctoraliaCounterpart!.doctoraliaDoctorId, p.doctoraliaCounterpart!.calendarStatus || 'disabled')}
                                                            disabled={isUpdating}
                                                            className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all duration-300 ${isEnabled
                                                                ? 'bg-emerald-500 text-white shadow-sm hover:bg-emerald-600'
                                                                : 'bg-slate-100 text-slate-400 hover:bg-slate-200 hover:text-slate-600'
                                                            } ${isUpdating ? 'opacity-60 cursor-wait' : 'hover:scale-105 active:scale-95'}`}
                                                        >
                                                            {isUpdating ? (
                                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                            ) : isEnabled ? (
                                                                <ToggleRight className="h-3.5 w-3.5" />
                                                            ) : (
                                                                <ToggleLeft className="h-3.5 w-3.5" />
                                                            )}
                                                            {isUpdating ? '...' : isEnabled ? 'Ativo' : 'Inativo'}
                                                        </button>
                                                    );
                                                })()
                                            ) : (
                                                <span className="text-[9px] font-bold text-slate-200 uppercase">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-5 text-center">
                                            {(() => {
                                                const hasLink = !!p.doctoraliaCounterpart;
                                                const hasTurnos = !!(p.turnos?.turnoM || p.turnos?.turnoT || p.turnos?.turnoN);
                                                const calStatus = p.doctoraliaCounterpart?.calendarStatus;
                                                const calEnabled = calStatus === 'enabled';
                                                const calUnknown = !calStatus || calStatus === 'unknown';
                                                const allDone = hasLink && hasTurnos && calEnabled && !calUnknown;
                                                const partial = hasLink && hasTurnos && !allDone;

                                                if (allDone) {
                                                    return (
                                                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider bg-primary/10 text-primary border border-primary/20">
                                                            <CheckCircle2 className="h-3.5 w-3.5" />
                                                            Completo
                                                        </span>
                                                    );
                                                }
                                                if (partial) {
                                                    return (
                                                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider bg-amber-50 text-amber-600 border border-amber-100" title="Calendário desabilitado">
                                                            <AlertTriangle className="h-3.5 w-3.5" />
                                                            Parcial
                                                        </span>
                                                    );
                                                }
                                                if (hasLink) {
                                                    return (
                                                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider bg-blue-50 text-blue-500 border border-blue-100" title="Sem turnos cadastrados">
                                                            <Calendar className="h-3.5 w-3.5" />
                                                            Sem Turnos
                                                        </span>
                                                    );
                                                }
                                                return (
                                                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider bg-slate-50 text-slate-300 border border-slate-100">
                                                        <Link2Off className="h-3.5 w-3.5" />
                                                        Pendente
                                                    </span>
                                                );
                                            })()}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* ── ESPECIALIDADES (Motor IA) ──────────────────────────── */}
            {activeTab === 'Especialidades' && (
                <div className="space-y-8 animate-in fade-in slide-in-from-top-4 duration-500">
                    <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-6">
                        {[
                            { label: 'Espec. VisMed', value: specStats?.totalVismedSpecialties ?? '—', icon: <FileText className="h-6 w-6" />, color: 'from-indigo-500 to-indigo-700' },
                            { label: 'Serviços Doctoralia', value: specStats?.totalDoctoraliaServices ?? '—', icon: <Activity className="h-6 w-6" />, color: 'from-blue-500 to-blue-700' },
                            { label: 'Aprovados', value: specStats?.totalAutoApproved ?? '—', icon: <CheckCircle2 className="h-6 w-6" />, color: 'from-primary to-emerald-600' },
                            { label: 'Pendentes Revisão', value: specStats?.totalPendingReview ?? '—', icon: <AlertTriangle className="h-6 w-6" />, color: 'from-amber-400 to-amber-600' },
                            { label: 'Sem Match', value: specStats?.totalUnmatched ?? '—', icon: <Link2Off className="h-6 w-6" />, color: 'from-orange-400 to-rose-500' },
                            { label: 'Cobertura', value: specStats ? `${specStats.coveragePercent}%` : '—', icon: <Stethoscope className="h-6 w-6" />, color: 'from-slate-700 to-slate-900' },
                        ].map(m => (
                            <div key={m.label} className="bg-white/70 backdrop-blur-xl rounded-[32px] p-8 shadow-sm border border-slate-100/60 flex items-center justify-between transition-all hover:shadow-xl hover:-translate-y-1 group">
                                <div>
                                    <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] mb-2 leading-none">{m.label}</h3>
                                    <div className="text-4xl font-black text-slate-900 tracking-tighter">
                                        {isLoading ? <Loader2 className="h-6 w-6 animate-spin text-primary/30" /> : m.value}
                                    </div>
                                </div>
                                <div className={`h-14 w-14 rounded-2xl bg-gradient-to-br ${m.color} flex items-center justify-center text-white shadow-xl transition-transform group-hover:scale-110`}>
                                    {m.icon}
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="bg-white/70 backdrop-blur-xl rounded-[32px] shadow-sm border border-slate-100/80 overflow-hidden">
                        <div className="p-8 border-b border-slate-100/60 flex justify-between items-center bg-white/40">
                            <h3 className="text-[12px] font-black text-slate-900 uppercase tracking-[2px]">Motor de Equivalência de Serviços (IA)</h3>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left border-separate border-spacing-0">
                                <thead className="bg-slate-50/50 text-[10px] text-slate-400 uppercase font-black tracking-[3px] border-b border-slate-100">
                                    <tr>
                                        <th className="px-10 py-6">Especialidade (VisMed)</th>
                                        <th className="px-10 py-6 text-center">Status de Busca</th>
                                        <th className="px-10 py-6">Serviços Doctoralia</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-50">
                                    {isLoading ? (
                                        <tr><td colSpan={3} className="px-10 py-32 text-center">
                                            <div className="flex flex-col items-center gap-4">
                                                <Loader2 className="h-12 w-12 animate-spin text-primary" />
                                                <p className="text-[10px] font-black text-slate-300 uppercase tracking-[4px]">Processando motor de busca...</p>
                                            </div>
                                        </td></tr>
                                    ) : specialtyMatches.length === 0 ? (
                                        <tr><td colSpan={3} className="px-10 py-32 text-center text-slate-400 font-bold uppercase tracking-widest text-xs opacity-50">Aguardando gatilho do motor de IA...</td></tr>
                                    ) : specialtyMatches.map(m => (
                                        <tr key={m.id} className="group hover:bg-emerald-50/20 transition-all duration-500">
                                            <td className="px-10 py-6">
                                                <div className="font-black text-base text-slate-900 leading-tight group-hover:text-primary transition-colors tracking-tight">{m.vismedSpecialty?.name ?? '—'}</div>
                                                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2">{m.vismedSpecialty?.normalizedName ?? 'NORMALIZED'}</div>
                                            </td>
                                            <td className="px-10 py-6 text-center">
                                                <div className="flex flex-col items-center gap-4">
                                                    <span className="inline-flex items-center px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-primary/20 bg-primary/5 text-primary">
                                                        Sincronizado ({Math.round(m.confidenceScore * 100)}%)
                                                    </span>
                                                    {m.requiresReview && (
                                                        <div className="flex gap-3 animate-in fade-in zoom-in duration-300">
                                                            <button onClick={() => handleApprove(m.vismedSpecialtyId, m.doctoraliaServiceId)} disabled={isResolving}
                                                                className="text-[10px] font-black uppercase tracking-widest bg-primary text-white px-5 py-2.5 rounded-2xl hover:bg-emerald-600 transition-all shadow-lg active:scale-95 disabled:opacity-50">
                                                                Confirmar
                                                            </button>
                                                            <button onClick={() => handleReject(m.vismedSpecialtyId, m.doctoraliaServiceId)} disabled={isResolving}
                                                                className="text-[10px] font-black uppercase tracking-widest bg-white text-rose-600 border border-rose-100 px-5 py-2.5 rounded-2xl hover:bg-rose-50 transition-all active:scale-95 disabled:opacity-50">
                                                                Ignorar
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-10 py-6">
                                                <div className="flex items-center gap-5">
                                                    <div className="h-12 w-12 rounded-[20px] bg-slate-50 text-slate-400 flex items-center justify-center border border-slate-100 group-hover:bg-primary group-hover:text-white group-hover:border-primary/20 transition-all duration-500 shadow-sm">
                                                        <Stethoscope className="h-6 w-6" />
                                                    </div>
                                                    <div>
                                                        <div className="font-black text-base text-slate-900 leading-none group-hover:text-primary transition-colors tracking-tight">{m.doctoraliaService?.name ?? '—'}</div>
                                                        <div className="flex items-center gap-1.5 mt-2">
                                                            <Globe className="h-3.5 w-3.5 text-primary/40" />
                                                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Catálogo Unificado</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {/* ── CONVÊNIOS ─────────────────────────────────────────── */}
            {activeTab === 'Convênios' && (
                <div className="space-y-8 animate-in fade-in slide-in-from-top-4 duration-500">
                    <div className="grid grid-cols-1 md:grid-cols-5 gap-8">
                        {[
                            { label: 'Total Mapeados', value: legacyMappings.length, icon: <FileText className="h-6 w-6" />, color: 'from-slate-500 to-slate-700' },
                            { label: 'Vinculados', value: legacyMappings.filter(m => m.status === 'LINKED').length, icon: <CheckCircle2 className="h-6 w-6" />, color: 'from-primary to-emerald-600' },
                            { label: 'Aguardando Revisão', value: legacyMappings.filter(m => m.status === 'PENDING_REVIEW').length, icon: <AlertTriangle className="h-6 w-6" />, color: 'from-amber-400 to-amber-600' },
                            { label: 'Sem Vínculo', value: legacyMappings.filter(m => m.status === 'UNLINKED').length, icon: <Link2Off className="h-6 w-6" />, color: 'from-orange-400 to-rose-500' },
                            { label: 'Conflitos', value: legacyMappings.filter(m => m.status === 'CONFLICT').length, icon: <AlertTriangle className="h-6 w-6" />, color: 'from-rose-500 to-red-600' },
                        ].map(m => (
                            <div key={m.label} className="bg-white/70 backdrop-blur-xl rounded-[32px] p-8 shadow-sm border border-slate-100/60 flex items-center justify-between transition-all hover:shadow-xl hover:-translate-y-1 group">
                                <div>
                                    <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] mb-2 leading-none">{m.label}</h3>
                                    <div className="text-4xl font-black text-slate-900 tracking-tighter">
                                        {isLoading ? <Loader2 className="h-6 w-6 animate-spin text-primary/30" /> : m.value}
                                    </div>
                                </div>
                                <div className={`h-14 w-14 rounded-2xl bg-gradient-to-br ${m.color} flex items-center justify-center text-white shadow-xl transition-transform group-hover:scale-110`}>
                                    {m.icon}
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="bg-white/70 backdrop-blur-xl rounded-[32px] shadow-sm border border-slate-100/80 overflow-hidden">
                        <div className="p-8 border-b border-slate-100/60 flex justify-between items-center bg-white/40">
                            <h3 className="text-[12px] font-black text-slate-900 uppercase tracking-[2px]">Sincronismo de Convênios & Planos</h3>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left border-separate border-spacing-0">
                                <thead className="bg-slate-50/50 text-[10px] text-slate-400 uppercase font-black tracking-[3px] border-b border-slate-100">
                                    <tr>
                                        <th className="px-10 py-6 font-black">Convênio (VisMed)</th>
                                        <th className="px-10 py-6 text-center">Status</th>
                                        <th className="px-10 py-6 text-right">Referência Externa</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-50">
                                    {isLoading ? (
                                        <tr><td colSpan={3} className="px-10 py-32 text-center"><Loader2 className="h-12 w-12 animate-spin text-primary mx-auto" /></td></tr>
                                    ) : legacyMappings.length === 0 ? (
                                        <tr><td colSpan={3} className="px-10 py-32 text-center text-slate-400 font-bold uppercase tracking-widest text-xs opacity-50">Nenhum registro de convênio encontrado.</td></tr>
                                    ) : legacyMappings.map(m => (
                                        <tr key={m.id}
                                            className={`group transition-all duration-500 ${m.status === 'CONFLICT' ? 'bg-rose-50/20 hover:bg-rose-50/40 cursor-pointer shadow-inner' : 'hover:bg-emerald-50/20'}`}
                                            onClick={() => { if (m.status === 'CONFLICT') { setSelectedMapping(m); setShowResolveModal(true); } }}>
                                            <td className="px-10 py-6">
                                                <div className="flex flex-col gap-1 items-start">
                                                    <div className="font-black text-base text-slate-900 group-hover:text-primary transition-colors tracking-tight">{m.vismedEntity?.name ?? m.conflictData?.name ?? 'Convênio VisMed'}</div>
                                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                                                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded-md border border-slate-100 flex items-center gap-1">
                                                            VisMed ID: #{m.vismedEntity?.vismed_id || m.vismedId || m.externalId || '---'}
                                                        </span>
                                                        {m.conflictData?.idconveniotipo && (
                                                            <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded-md border border-indigo-100">
                                                                Tipo: {m.conflictData.idconveniotipo}
                                                            </span>
                                                        )}
                                                        {(m.conflictData?.datainicio || m.vismedEntity?.datainicio) && (
                                                            <span className="text-[10px] font-medium text-slate-500">
                                                                Início: {m.conflictData?.datainicio || '---'}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                                {!m.vismedId && (
                                                    <div className="mt-2.5 px-2.5 py-1.5 bg-amber-50/50 rounded-xl border border-amber-100 flex items-center gap-2">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                                                        <p className="text-[9px] text-amber-700 font-black uppercase tracking-widest">
                                                            Aguardando Catálogo Global
                                                        </p>
                                                    </div>
                                                )}
                                            </td>
                                            <td className="px-10 py-6 text-center">
                                                <div className="flex justify-center">
                                                    {m.status === 'LINKED' && (
                                                        <span className="inline-flex items-center gap-1.5 px-4 py-2 rounded-2xl text-[10px] font-black uppercase tracking-widest bg-emerald-50 text-primary border border-emerald-100 shadow-sm">
                                                            <CheckCircle2 className="h-4 w-4" /> Vinculado
                                                        </span>
                                                    )}
                                                    {m.status === 'PENDING_REVIEW' && (
                                                        <div className="flex flex-col items-center gap-2">
                                                            <span className="inline-flex items-center gap-1.5 px-4 py-2 rounded-2xl text-[10px] font-black uppercase tracking-widest bg-amber-50 text-amber-700 border border-amber-200 shadow-sm">
                                                                <AlertTriangle className="h-4 w-4" /> Aguardando Revisão
                                                            </span>
                                                            {m.conflictData?.matchScore && (
                                                                <span className="text-[9px] font-bold text-amber-600">
                                                                    Score: {(m.conflictData.matchScore * 100).toFixed(0)}%
                                                                </span>
                                                            )}
                                                            <div className="flex gap-2">
                                                                <button
                                                                    onClick={(e) => { e.stopPropagation(); handleApproveInsurance(m.id); }}
                                                                    disabled={isResolving}
                                                                    className="px-3 py-1.5 bg-emerald-500 text-white text-[9px] font-black uppercase tracking-widest rounded-xl hover:bg-emerald-600 transition-all active:scale-95 disabled:opacity-50"
                                                                >
                                                                    Aprovar
                                                                </button>
                                                                <button
                                                                    onClick={(e) => { e.stopPropagation(); handleRejectInsurance(m.id); }}
                                                                    disabled={isResolving}
                                                                    className="px-3 py-1.5 bg-rose-500 text-white text-[9px] font-black uppercase tracking-widest rounded-xl hover:bg-rose-600 transition-all active:scale-95 disabled:opacity-50"
                                                                >
                                                                    Rejeitar
                                                                </button>
                                                            </div>
                                                        </div>
                                                    )}
                                                    {m.status === 'UNLINKED' && (
                                                        <span className="inline-flex items-center gap-1.5 px-4 py-2 rounded-2xl text-[10px] font-black uppercase tracking-widest bg-slate-50 text-slate-400 border border-slate-200 opacity-60">
                                                            <Link2Off className="h-4 w-4" /> Sem Vínculo
                                                        </span>
                                                    )}
                                                    {m.status === 'CONFLICT' && (
                                                        <span className="inline-flex items-center gap-1.5 px-4 py-2 rounded-2xl text-[10px] font-black uppercase tracking-[2px] bg-rose-500 text-white shadow-lg shadow-rose-200 animate-pulse">
                                                            <AlertTriangle className="h-4 w-4" /> Resolver
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-10 py-6 text-right space-y-2">
                                                <div className="flex flex-col items-end">
                                                    <div className="text-sm font-black text-slate-900 group-hover:text-primary transition-colors">{m.doctoraliaCounterpart?.name || m.externalId || '---'}</div>
                                                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1 opacity-50">Doctoralia Sync</div>
                                                </div>
                                                
                                                {m.status === 'LINKED' && m.externalId && (
                                                    <button 
                                                        onClick={(e) => { e.stopPropagation(); handlePushInsurance(m.externalId); }}
                                                        disabled={isResolving}
                                                        className="inline-flex items-center gap-2 px-4 py-2 bg-slate-900 text-white text-[9px] font-black uppercase tracking-widest rounded-xl hover:bg-primary transition-all active:scale-95 disabled:opacity-50 shadow-md"
                                                        title="Adicionar este convênio em todos os calendários de médicos da Doctoralia"
                                                    >
                                                        <ArrowUpRight className="h-3 w-3" />
                                                        Expandir Calendários
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Conflict Modal Glassmorphism */}
                    {showResolveModal && selectedMapping && (
                        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-center justify-center p-6 animate-in fade-in duration-500">
                            <div className="bg-white/95 backdrop-blur-2xl rounded-[48px] shadow-2xl p-12 w-full max-w-xl relative border border-white/50 animate-in zoom-in-95 duration-300">
                                <button onClick={() => { setShowResolveModal(false); setSelectedMapping(null); }} className="absolute top-8 right-10 h-12 w-12 flex items-center justify-center rounded-2xl bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-all text-3xl font-light">×</button>

                                <div className="h-20 w-20 rounded-3xl bg-rose-50 text-rose-600 flex items-center justify-center mb-8 shadow-inner border border-rose-100">
                                    <AlertTriangle className="h-10 w-10 animate-bounce-slow" />
                                </div>

                                <h2 className="text-3xl font-black text-slate-900 tracking-tighter mb-3">Resolução de Conflito</h2>
                                <p className="text-slate-500 text-lg font-bold mb-10 leading-relaxed tracking-tight">
                                    Divergência estrutural detectada em <span className="text-slate-900 underline decoration-rose-500/30 underline-offset-4">{selectedMapping.vismedEntity?.name}</span>.
                                    Qual autoridade de dados deve prevalecer?
                                </p>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                                    <button
                                        onClick={() => handleResolveConflict('EXTERNAL')}
                                        disabled={isResolving}
                                        className="py-6 px-8 rounded-3xl border-2 border-slate-100 bg-white text-slate-900 font-black text-[10px] uppercase tracking-[2px] hover:border-primary hover:text-primary transition-all active:scale-95 disabled:opacity-50 flex flex-col items-center gap-3 group shadow-sm hover:shadow-xl"
                                    >
                                        <div className="h-12 w-12 rounded-2xl bg-slate-50 flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                                            <Globe className="h-6 w-6 text-slate-300 group-hover:text-primary transition-colors" />
                                        </div>
                                        Prevalecer Fonte Externa
                                    </button>
                                    <button
                                        onClick={() => handleResolveConflict('VISMED')}
                                        disabled={isResolving}
                                        className="py-6 px-8 rounded-3xl bg-slate-900 text-white font-black text-[10px] uppercase tracking-[2px] hover:bg-black transition-all shadow-2xl shadow-slate-900/40 active:scale-95 disabled:opacity-50 flex flex-col items-center gap-3 group"
                                    >
                                        <div className="h-12 w-12 rounded-2xl bg-white/10 flex items-center justify-center group-hover:bg-white/20 transition-colors">
                                            {isResolving ? <Loader2 className="h-6 w-6 animate-spin text-primary" /> : <Building2 className="h-6 w-6 text-primary" />}
                                        </div>
                                        Integridade VisMed
                                    </button>
                                </div>

                                <div className="mt-12 p-6 bg-slate-50 rounded-3xl border border-slate-100">
                                    <p className="text-center text-[10px] font-black text-slate-400 uppercase tracking-[4px]">Atenção: Impacto na sincronização bi-direcional</p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── UNIDADES ──────────────────────────────────────────── */}
            {activeTab === 'Unidades' && (
                <div className="space-y-8 animate-in fade-in slide-in-from-top-4 duration-500">
                    {isLoading ? (
                        <div className="bg-white/70 backdrop-blur-xl rounded-[32px] shadow-sm border border-slate-100/80 p-32 flex flex-col items-center gap-4">
                            <Loader2 className="h-12 w-12 animate-spin text-primary" />
                            <p className="text-[10px] font-black text-slate-300 uppercase tracking-[4px]">Catalogando unidades...</p>
                        </div>
                    ) : units.length === 0 ? (
                        <div className="bg-white/70 backdrop-blur-xl rounded-[32px] shadow-sm border border-slate-100/80 p-32 text-center">
                            <Building2 className="h-16 w-16 text-slate-200 mx-auto mb-6" />
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[3px]">Nenhuma unidade VisMed configurada ainda.</p>
                        </div>
                    ) : units.map(u => {
                        const isLinked = !!u.doctoraliaCounterpart;
                        return (
                            <div key={u.id} className="bg-white/70 backdrop-blur-xl rounded-[32px] shadow-sm border border-slate-100/80 overflow-hidden hover:shadow-xl transition-all duration-500 group">
                                <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] items-stretch min-h-[180px]">
                                    {/* LEFT — VisMed */}
                                    <div className="p-8 flex flex-col justify-center border-r border-slate-100/60">
                                        <div className="flex items-center gap-2 mb-4">
                                            <div className="h-6 w-6 rounded-lg bg-slate-900 flex items-center justify-center">
                                                <Building2 className="h-3.5 w-3.5 text-white" />
                                            </div>
                                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-[3px]">VisMed</span>
                                        </div>
                                        <div className="font-black text-lg text-slate-900 tracking-tight leading-tight mb-3">{u.name}</div>
                                        <div className="space-y-2">
                                            {u.cityName && (
                                                <div className="text-[10px] font-bold text-slate-500 flex items-center gap-1.5">
                                                    <div className="h-1.5 w-1.5 rounded-full bg-slate-300"></div>
                                                    {u.cityName}
                                                </div>
                                            )}
                                            {u.cnpj && (
                                                <span className="inline-block text-[10px] font-black text-slate-400 bg-slate-50 px-2 py-0.5 rounded-lg uppercase tracking-widest border border-slate-100">
                                                    CNPJ: {u.cnpj}
                                                </span>
                                            )}
                                            <div className="flex items-center gap-2 mt-1">
                                                <User className="h-3.5 w-3.5 text-slate-400" />
                                                <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                                                    {u.doctorCount} Profissional(is)
                                                </span>
                                            </div>
                                        </div>
                                    </div>

                                    {/* CENTER — Status */}
                                    <div className="px-10 flex flex-col items-center justify-center bg-slate-50/30">
                                        {isLinked ? (
                                            <div className="flex flex-col items-center gap-3">
                                                <div className="h-16 w-16 rounded-[22px] bg-gradient-to-br from-primary to-emerald-600 flex items-center justify-center shadow-lg shadow-primary/20 group-hover:scale-110 transition-transform duration-500">
                                                    <CheckCircle2 className="h-8 w-8 text-white" />
                                                </div>
                                                <span className="text-[10px] font-black text-primary uppercase tracking-[3px]">Vinculado</span>
                                                <div className="h-1 w-12 rounded-full bg-gradient-to-r from-primary to-emerald-400"></div>
                                            </div>
                                        ) : (
                                            <div className="flex flex-col items-center gap-3">
                                                <div className="h-16 w-16 rounded-[22px] bg-slate-100 flex items-center justify-center border-2 border-dashed border-slate-200 group-hover:border-orange-300 transition-colors duration-500">
                                                    <Link2Off className="h-8 w-8 text-slate-300" />
                                                </div>
                                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-[3px]">Pendente</span>
                                                <div className="h-1 w-12 rounded-full bg-slate-200"></div>
                                            </div>
                                        )}
                                    </div>

                                    {/* RIGHT — Doctoralia */}
                                    <div className="p-8 flex flex-col justify-center border-l border-slate-100/60">
                                        <div className="flex items-center gap-2 mb-4 justify-end">
                                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-[3px]">Doctoralia</span>
                                            <div className="h-6 w-6 rounded-lg bg-blue-500 flex items-center justify-center">
                                                <Globe className="h-3.5 w-3.5 text-white" />
                                            </div>
                                        </div>
                                        {isLinked ? (
                                            <div className="text-right">
                                                <div className="font-black text-lg text-slate-900 tracking-tight leading-tight mb-3">{u.doctoraliaCounterpart!.name}</div>
                                                <div className="space-y-2">
                                                    <span className="inline-block text-[10px] font-black text-blue-600 bg-blue-50 px-2.5 py-1 rounded-lg uppercase tracking-widest border border-blue-100">
                                                        ID: {u.doctoraliaCounterpart!.externalId}
                                                    </span>
                                                    <div className="flex items-center justify-end gap-1.5 mt-1">
                                                        <div className="h-2 w-2 rounded-full bg-primary animate-pulse"></div>
                                                        <span className="text-[10px] font-black text-primary uppercase tracking-widest">Sincronizado</span>
                                                    </div>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="text-right">
                                                <div className="font-black text-base text-slate-300 tracking-tight leading-tight mb-3">Sem vínculo externo</div>
                                                <span className="inline-block text-[10px] font-black text-slate-300 uppercase tracking-widest opacity-50">Aguardando sincronização</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            <div className="text-center pt-8 border-t border-slate-100/40">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[5px] leading-relaxed opacity-40 hover:opacity-100 transition-opacity">
                    Data Governance Architecture • VisMed 2026 • Security Tier 1
                </p>
            </div>
        </div>
    );
}

const styles = `
@keyframes bounce-slow {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-5px); }
}
.animate-bounce-slow {
    animation: bounce-slow 3s infinite ease-in-out;
}
@keyframes spin-slow {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}
.animate-spin-slow {
    animation: spin-slow 8s linear infinite;
}
`;
