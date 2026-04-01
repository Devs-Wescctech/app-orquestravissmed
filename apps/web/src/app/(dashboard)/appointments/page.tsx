'use client';
import { useState, useEffect, useCallback } from 'react';
import {
    CalendarDays, AlertCircle, ExternalLink, Loader2, UserSquare2,
    CalendarOff, Clock, Search, AlertTriangle, RefreshCw, CalendarClock, Timer,
    User, ChevronRight, Activity, ShieldCheck, Filter, ArrowUpRight, BarChart3, CheckCircle2, Stethoscope,
    PowerOff,
    Settings2,
    Zap,
    LayoutGrid,
    ShieldAlert,
    Power
} from 'lucide-react';
import { api } from '@/lib/api';
import { useClinic } from '@/lib/clinic-store';
import { useAuthStore } from '@/lib/store';
import { toast } from 'sonner';

type ViewState = 'loading' | 'disabled' | 'empty' | 'error' | 'timeout' | 'ready';
type Tab = 'bookings' | 'slots';

export default function AppointmentsPage() {
    const { user } = useAuthStore();
    const { activeClinic } = useClinic();
    const [calendarStatus, setCalendarStatus] = useState<any>(null);
    const [bookings, setBookings] = useState<any[]>([]);
    const [slots, setSlots] = useState<any[]>([]);
    const [viewState, setViewState] = useState<ViewState>('loading');
    const [errorMsg, setErrorMsg] = useState('');
    const [activeTab, setActiveTab] = useState<Tab>('bookings');

    // Filters
    const today = new Date().toISOString().split('T')[0];
    const weekLater = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
    const [startDate, setStartDate] = useState(today);
    const [endDate, setEndDate] = useState(weekLater);
    const [selectedDoctor, setSelectedDoctor] = useState('');
    const [isFetching, setIsFetching] = useState(false);

    const clinicId = activeClinic?.id;

    // ────────────────────── FETCH STATUS ──────────────────────
    const fetchStatus = useCallback(async () => {
        if (!clinicId) return;
        setViewState('loading');
        try {
            const res = await api.get('/appointments/calendar-status', {
                params: { clinicId }
            });
            setCalendarStatus(res.data);

            if (!res.data?.integrated) {
                setViewState('error');
                setErrorMsg('Integração Doctoralia não configurada para esta unidade.');
            } else if (res.data?.timedOut) {
                setViewState('timeout');
                setErrorMsg(res.data.error || 'O servidor de sincronização não respondeu');
            } else if (!res.data?.calendarEnabled) {
                setViewState('disabled');
            } else {
                setViewState('ready');
            }
        } catch (e: any) {
            setViewState('error');
            setErrorMsg(e.message || 'Erro ao verificar status do calendário');
        }
    }, [clinicId]);

    useEffect(() => {
        fetchStatus();
    }, [fetchStatus]);

    // ────────────────────── FETCH DATA ──────────────────────
    const fetchData = useCallback(async () => {
        if (!clinicId || viewState === 'disabled') return;
        setIsFetching(true);
        setErrorMsg('');

        try {
            if (activeTab === 'bookings') {
                const params: any = { clinicId, start: startDate, end: endDate };
                if (selectedDoctor) params.doctorId = selectedDoctor;
                const res = await api.get('/appointments/bookings', { params });

                if (res.data?.timedOut) {
                    setErrorMsg(res.data.error || 'API não respondeu no tempo esperado');
                } else {
                    setBookings(res.data?.bookings || []);
                    if ((res.data?.bookings || []).length === 0) {
                        setViewState('empty');
                    } else {
                        setViewState('ready');
                    }
                }
            } else {
                if (!selectedDoctor) {
                    toast.error('Selecione um médico para buscar slots.');
                    setIsFetching(false);
                    return;
                }
                const params = { clinicId, doctorId: selectedDoctor, start: startDate, end: endDate };
                const res = await api.get('/appointments/slots', { params });

                if (res.data?.timedOut) {
                    setErrorMsg(res.data.error || 'API não respondeu');
                } else {
                    setSlots(res.data?.slots || []);
                    setViewState((res.data?.slots || []).length === 0 ? 'empty' : 'ready');
                }
            }
        } catch (e: any) {
            setErrorMsg(e.message || 'Erro desconhecido');
        } finally {
            setIsFetching(false);
        }
    }, [clinicId, activeTab, startDate, endDate, selectedDoctor, viewState]);

    useEffect(() => {
        if (viewState === 'ready' || viewState === 'empty') {
            fetchData();
        }
    }, [activeTab, selectedDoctor, startDate, endDate, viewState, fetchData]);

    const [isBookingModalOpen, setIsBookingModalOpen] = useState(false);
    const [selectedSlot, setSelectedSlot] = useState<any>(null);
    const [isWorkPeriodModalOpen, setIsWorkPeriodModalOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    // Form states
    const [patientForm, setPatientForm] = useState({ name: '', phone: '', email: '' });
    const [workPeriodForm, setWorkPeriodForm] = useState({ start: '08:00', end: '18:00' });

    // ────────────────────── MUTATION ACTIONS ──────────────────────
    const handleToggleCalendar = async (doctoraliaDoctorId: string, currentStatus: string) => {
        const newStatus = currentStatus === 'enabled' ? 'disabled' : 'enabled';
        const toastId = toast.loading(`${newStatus === 'enabled' ? 'Habilitando' : 'Desabilitando'} agenda na Doctoralia...`);
        
        try {
            await api.post('/appointments/calendar-status', {
                clinicId,
                doctoraliaDoctorId,
                status: newStatus
            });
            toast.success(`Agenda ${newStatus === 'enabled' ? 'ativada' : 'desativada'} com sucesso.`, { id: toastId });
            fetchStatus(); // Refresh the list from the new endpoint
        } catch (error: any) {
            toast.error(`Falha ao alterar status: ${error.message}`, { id: toastId });
        }
    };

    const setQuickDate = (daysOffset: number, isRange: boolean = false) => {
        const start = new Date();
        start.setDate(start.getDate() + daysOffset);
        const startStr = start.toISOString().split('T')[0];
        
        setStartDate(startStr);
        if (!isRange) {
            setEndDate(startStr);
        } else {
            const end = new Date();
            end.setDate(end.getDate() + daysOffset + 6);
            setEndDate(end.toISOString().split('T')[0]);
        }
    };

    const handleBlockSlot = async (slot: any) => {
        if (!clinicId || !selectedDoctor) return;
        const confirm = window.confirm(`Deseja realmente remover o slot de ${slot.start}?`);
        if (!confirm) return;

        const toastId = toast.loading('Removendo slot...');
        try {
            await api.delete('/appointments/slots', {
                params: {
                    clinicId,
                    doctorId: selectedDoctor,
                    start: slot.start,
                    end: slot.end
                }
            });
            toast.success('Slot removido com sucesso.', { id: toastId });
            fetchData();
        } catch (e: any) {
            toast.error(`Falha ao remover: ${e.message}`, { id: toastId });
        }
    };

    const handleConfirmBooking = async () => {
        if (!clinicId || !selectedDoctor || !selectedSlot) return;
        if (!patientForm.name) {
            toast.error('O nome do paciente é obrigatório.');
            return;
        }

        const toastId = toast.loading('Agendando consulta...');
        setIsSaving(true);
        try {
            await api.post('/appointments/slots/book', {
                clinicId,
                doctorId: selectedDoctor,
                start: selectedSlot.start,
                end: selectedSlot.end,
                address_service_id: selectedSlot.address_service_id,
                patient: {
                    name: patientForm.name,
                    phone: patientForm.phone || '11999999999',
                    email: patientForm.email || 'vissmed@integration.local'
                }
            });
            toast.success('Reserva realizada com sucesso.', { id: toastId });
            setIsBookingModalOpen(false);
            setPatientForm({ name: '', phone: '', email: '' });
            fetchData();
        } catch (e: any) {
            const msg = e.message;
            toast.error(`Falha ao agendar: ${msg}`, { id: toastId });
        } finally {
            setIsSaving(false);
        }
    };

    const handleConfirmWorkPeriod = async () => {
        if (!clinicId || !selectedDoctor) return;

        const toastId = toast.loading('Publicando malha de horários...');
        setIsSaving(true);
        try {
            const startISO = `${startDate}T${workPeriodForm.start}:00-0300`;
            const endISO = `${startDate}T${workPeriodForm.end}:00-0300`;

            await api.put('/appointments/slots', {
                clinicId,
                doctorId: selectedDoctor,
                slots: [
                    {
                        start: startISO,
                        end: endISO,
                        address_services: [
                            { address_service_id: slots[0]?.address_service_id || 0, duration: 30 }
                        ]
                    }
                ]
            });
            toast.success('Período de trabalho definido.', { id: toastId });
            setIsWorkPeriodModalOpen(false);
            fetchData();
        } catch (e: any) {
            const msg = e.message;
            toast.error(`Falha ao definir período: ${msg}`, { id: toastId });
        } finally {
            setIsSaving(false);
        }
    };

    const doctors = calendarStatus?.doctors || [];
    const enabledDoctors = doctors.filter((d: any) => d.calendarStatus === 'enabled');

    if (viewState === 'loading' && slots.length === 0 && bookings.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen">
                <Loader2 className="h-12 w-12 animate-spin text-primary opacity-20" />
                <div className="mt-4 text-[11px] font-black text-slate-400 uppercase tracking-[4px] animate-pulse">Sincronizando Malha...</div>
            </div>
        );
    }

    return (
        <div className="max-w-[1600px] mx-auto space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-700 pb-20">
            
            {/* ─── HEADER ─── */}
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6">
                <div className="flex items-center gap-6">
                    <div className="h-20 w-20 rounded-[30px] bg-gradient-to-br from-primary to-indigo-600 flex items-center justify-center shadow-2xl shadow-primary/30 relative group overflow-hidden">
                        <CalendarDays className="h-10 w-10 text-white relative z-10 transition-transform group-hover:scale-110 duration-500" />
                        <div className="absolute inset-0 bg-white/20 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                    </div>
                    <div>
                        <div className="flex items-center gap-3 mb-1">
                            <span className="px-3 py-1 rounded-full bg-primary/10 text-primary text-[10px] font-black uppercase tracking-[2px]">Central de Operações</span>
                            <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Live Sync</span>
                        </div>
                        <h1 className="text-4xl font-black text-slate-900 tracking-tight leading-none">Agendamentos</h1>
                        <p className="text-slate-500 mt-2 font-medium flex items-center gap-2">
                             Gestão em tempo real da malha de agendamentos e disponibilidades da infraestrutura Doctoralia.
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <button 
                        onClick={fetchStatus}
                        className="flex items-center gap-2 px-6 py-3 bg-white border border-slate-200 text-slate-600 rounded-2xl text-[12px] font-black uppercase tracking-widest hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm"
                    >
                        <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} /> Sincronizar Agora
                    </button>
                </div>
            </div>

            {/* ─── METRICS BAR ─── */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {[
                    { label: 'Total Consultas', value: bookings.length, icon: User, color: 'primary', trend: '+12%' },
                    { label: 'Slots Livres', value: slots.length, icon: CalendarClock, color: 'emerald', trend: 'Live' },
                    { label: 'Médicos Ativos', value: enabledDoctors.length, icon: ShieldCheck, color: 'indigo', trend: `${enabledDoctors.length}/${doctors.length}` },
                    { label: 'Saúde Conexão', value: '98%', icon: Activity, color: 'orange', trend: 'Estável' },
                ].map((stat, i) => (
                    <div key={i} className="bg-white/60 backdrop-blur-md rounded-[32px] p-8 border border-slate-100/60 shadow-sm group hover:border-primary/20 transition-all duration-500">
                        <div className="flex items-start justify-between mb-4">
                            <div className={`h-14 w-14 rounded-2xl bg-${stat.color === 'primary' ? 'primary' : stat.color + '-500'}/10 text-${stat.color === 'primary' ? 'primary' : stat.color + '-600'} flex items-center justify-center transition-transform group-hover:scale-110 duration-500`}>
                                <stat.icon className="h-7 w-7" />
                            </div>
                            <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest">{stat.trend}</span>
                        </div>
                        <div className="text-3xl font-black text-slate-900 tracking-tighter mb-1">{stat.value}</div>
                        <div className="text-[12px] font-bold text-slate-400 uppercase tracking-widest">{stat.label}</div>
                    </div>
                ))}
            </div>

            {/* ─── MAIN CONTENT ─── */}
            <div className="grid grid-cols-1 xl:grid-cols-[400px_1fr] gap-8 items-start">
                
                {/* SIDEBAR: COMMAND CENTER */}
                <aside className="space-y-8 sticky top-24">
                    {/* Operation Controls */}
                    <div className="bg-slate-900 rounded-[40px] p-8 text-white shadow-2xl relative overflow-hidden group border border-white/5">
                        <div className="absolute -top-10 -right-10 opacity-[0.03] group-hover:opacity-[0.07] transition-all duration-1000 rotate-12">
                            <Activity className="h-64 w-64" />
                        </div>

                        <div className="flex items-center justify-between mb-8 relative z-10">
                            <h2 className="text-xl font-black flex items-center gap-3">
                                <div className="h-10 w-10 rounded-2xl bg-primary/20 text-primary flex items-center justify-center shadow-inner">
                                    <Settings2 className="h-5 w-5" />
                                </div>
                                Painel de Controle
                            </h2>
                            <div className="flex gap-1">
                                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
                                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500/40"></div>
                            </div>
                        </div>
                        
                        <div className="space-y-8 relative z-10">
                            {/* Quick Dates */}
                            <div>
                                <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-500 ml-1 mb-3 block">Navegação Temporal</label>
                                <div className="flex flex-wrap gap-2">
                                    {[
                                        { label: 'Hoje', offset: 0 },
                                        { label: 'Amanhã', offset: 1 },
                                        { label: 'Semana', offset: 0, range: true },
                                    ].map((d, i) => (
                                        <button 
                                            key={i}
                                            onClick={() => setQuickDate(d.offset, d.range)}
                                            className="px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-[10px] font-black uppercase tracking-widest hover:bg-primary hover:border-primary transition-all active:scale-95"
                                        >
                                            {d.label}
                                        </button>
                                    ))}
                                </div>
                                <div className="grid grid-cols-2 gap-3 mt-4">
                                    <div className="space-y-1">
                                        <span className="text-[8px] font-black text-slate-600 uppercase tracking-widest ml-1">De</span>
                                        <input type="date" value={startDate} onChange={(e)=>setStartDate(e.target.value)} className="bg-white/5 border border-white/5 rounded-xl px-4 py-2.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all text-white w-full" />
                                    </div>
                                    <div className="space-y-1">
                                        <span className="text-[8px] font-black text-slate-600 uppercase tracking-widest ml-1">Até</span>
                                        <input type="date" value={endDate} onChange={(e)=>setEndDate(e.target.value)} className="bg-white/5 border border-white/5 rounded-xl px-4 py-2.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all text-white w-full" />
                                    </div>
                                </div>
                            </div>
                            
                            {/* Specialist List (Modern Replacement for Select) */}
                            <div>
                                <div className="flex items-center justify-between mb-4">
                                    <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-500 ml-1 block">Especialistas Disponíveis</label>
                                    <span className="px-2 py-0.5 rounded-md bg-white/5 text-[9px] font-bold text-slate-500">{doctors.length} total</span>
                                </div>
                                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
                                    {doctors.map((doc: any, i: number) => (
                                        <div 
                                            key={i} 
                                            onClick={() => setSelectedDoctor(doc.externalId)}
                                            className={`p-4 rounded-3xl border transition-all cursor-pointer group flex items-center justify-between
                                                ${selectedDoctor === doc.externalId 
                                                    ? 'bg-primary/10 border-primary/40 shadow-lg shadow-primary/5' 
                                                    : 'bg-white/5 border-white/5 hover:border-white/20'}`}
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className={`h-10 w-10 rounded-2xl flex items-center justify-center font-black text-[12px] transition-all
                                                    ${selectedDoctor === doc.externalId ? 'bg-primary text-white scale-110 shadow-lg shadow-primary/30' : 'bg-white/10 text-slate-400 group-hover:bg-white/20'}`}>
                                                    {doc.name.charAt(0)}
                                                </div>
                                                <div>
                                                    <div className={`text-[13px] font-black tracking-tight leading-none ${selectedDoctor === doc.externalId ? 'text-white' : 'text-slate-300 group-hover:text-white'}`}>
                                                        {doc.name.split(' ')[0]} {doc.name.split(' ').slice(-1)}
                                                    </div>
                                                    <div className="flex items-center gap-2 mt-1.5">
                                                        <div className={`h-1.5 w-1.5 rounded-full ${doc.calendarStatus === 'enabled' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`}></div>
                                                        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">
                                                            {doc.calendarStatus === 'enabled' ? 'Calendar On' : 'Offline'}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>

                                            <button 
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleToggleCalendar(doc.externalId, doc.calendarStatus);
                                                }}
                                                className={`h-8 w-8 rounded-xl flex items-center justify-center transition-all
                                                    ${doc.calendarStatus === 'enabled' 
                                                        ? 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500 hover:text-white shadow-emerald-500/20 shadow-md' 
                                                        : 'bg-slate-800 text-slate-500 hover:bg-primary hover:text-white'}`}
                                                title={doc.calendarStatus === 'enabled' ? 'Pausar Agenda' : 'Ativar Agenda'}
                                            >
                                                {doc.calendarStatus === 'enabled' ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Main Actions */}
                            <div className="pt-4 space-y-3">
                                <button 
                                    onClick={fetchData}
                                    disabled={isFetching || !selectedDoctor}
                                    className="w-full h-14 bg-primary hover:bg-primary/90 text-white rounded-[20px] font-black uppercase tracking-[3px] text-[11px] shadow-2xl shadow-primary/40 transition-all flex items-center justify-center gap-3 disabled:opacity-30 disabled:grayscale"
                                >
                                    {isFetching ? <Loader2 className="h-5 w-5 animate-spin" /> : <Zap className="h-5 w-5 fill-current" />}
                                    Escanear Malha
                                </button>
                                
                                <button 
                                    onClick={() => setIsWorkPeriodModalOpen(true)}
                                    disabled={!selectedDoctor || isFetching}
                                    className="w-full h-14 bg-white/5 hover:bg-white/10 text-slate-300 rounded-[20px] font-black uppercase tracking-[3px] text-[11px] border border-white/5 transition-all flex items-center justify-center gap-3 disabled:opacity-20 translate-y-0 hover:-translate-y-1 active:translate-y-0"
                                >
                                    <LayoutGrid className="h-5 w-5" />
                                    Publicar Período
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Operational Safety Alert */}
                    <div className="bg-amber-500/10 border border-amber-500/20 rounded-[32px] p-6 flex gap-4">
                        <ShieldAlert className="h-6 w-6 text-amber-500 shrink-0" />
                        <div>
                            <div className="text-[11px] font-black text-amber-500 uppercase tracking-widest mb-1">Atenção Operacional</div>
                            <p className="text-[10px] font-bold text-amber-600/80 leading-relaxed uppercase tracking-wider">
                                Ações de reserva e bloqueio refletem instantaneamente no marketplace Doctoralia. Verifique os dados do paciente.
                            </p>
                        </div>
                    </div>
                </aside>

                {/* MAIN AREA: TABS & RESULTS */}
                <main className="space-y-8">
                    {/* Tabs Navigation */}
                    <div className="flex items-center gap-2 p-2 bg-slate-100/80 backdrop-blur-sm rounded-[28px] border border-slate-200/50 w-fit shadow-inner">
                        <button
                            onClick={() => setActiveTab('bookings')}
                            className={`flex items-center gap-3 px-8 py-4 rounded-[22px] text-[13px] font-black uppercase tracking-[2px] transition-all duration-500
                                ${activeTab === 'bookings' 
                                    ? 'bg-white text-slate-900 shadow-2xl shadow-slate-200 scale-[1.02]' 
                                    : 'text-slate-400 hover:text-slate-600 hover:bg-white/40'}`}
                        >
                            <UserSquare2 className={`h-4 w-4 ${activeTab === 'bookings' ? 'text-primary' : 'opacity-40'}`} />
                            Consultas
                        </button>
                        <button
                            onClick={() => setActiveTab('slots')}
                            className={`flex items-center gap-3 px-8 py-4 rounded-[22px] text-[13px] font-black uppercase tracking-[2px] transition-all duration-500
                                ${activeTab === 'slots' 
                                    ? 'bg-white text-slate-900 shadow-2xl shadow-slate-200 scale-[1.02]' 
                                    : 'text-slate-400 hover:text-slate-600 hover:bg-white/40'}`}
                        >
                            <CalendarClock className={`h-4 w-4 ${activeTab === 'slots' ? 'text-primary' : 'opacity-40'}`} />
                            Slots Livres
                        </button>
                    </div>

                    {/* Content Section */}
                    {viewState === 'loading' ? (
                        <div className="flex flex-col items-center justify-center min-h-[500px] bg-white/40 rounded-[40px] border border-dashed border-slate-200">
                            <Loader2 className="h-12 w-12 animate-spin text-primary opacity-20" />
                            <div className="mt-4 text-[11px] font-black text-slate-400 uppercase tracking-[4px] animate-pulse">Estabelecendo Link</div>
                        </div>
                    ) : viewState === 'disabled' ? (
                        <div className="bg-amber-50 rounded-[40px] p-12 border border-amber-100 flex flex-col items-center text-center animate-in zoom-in duration-500">
                            <div className="h-24 w-24 rounded-[32px] bg-amber-100 flex items-center justify-center text-amber-600 mb-8 shadow-inner">
                                <CalendarOff className="h-12 w-12" />
                            </div>
                            <h2 className="text-2xl font-black text-amber-900 tracking-tight">Agendas não conectadas</h2>
                            <p className="text-amber-800/60 mt-4 max-w-md font-medium">Nenhum médico nesta unidade possui a integração de agendamento online habilitada no portal Doctoralia.</p>
                            <a href="/mapping" className="mt-8 px-8 py-4 bg-amber-900 text-white rounded-2xl font-black uppercase tracking-[2px] text-[12px] shadow-xl shadow-amber-900/40 hover:scale-105 active:scale-95 transition-all">
                                Ir para Central de Mapeamento
                            </a>
                        </div>
                    ) : viewState === 'empty' ? (
                        <div className="flex flex-col items-center justify-center min-h-[500px] bg-white/60 backdrop-blur-md rounded-[40px] border border-slate-100 shadow-sm animate-in fade-in transition-all">
                            <div className="h-20 w-20 bg-slate-50 border border-slate-100 rounded-3xl flex items-center justify-center text-slate-200 mb-6">
                                <Search className="h-10 w-10" />
                            </div>
                            <h3 className="text-xl font-black text-slate-900">Nenhum dado encontrado</h3>
                            <p className="text-slate-400 mt-2 font-medium max-w-[280px] text-center">Tente ajustar o intervalo de datas ou o filtro de especialistas para escanear a rede.</p>
                        </div>
                    ) : (
                        <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-700">
                            {activeTab === 'bookings' ? (
                                bookings.map((booking: any, idx) => (
                                    <div key={idx} className="group bg-white/60 hover:bg-white backdrop-blur-md rounded-3xl p-6 border border-slate-100/60 shadow-sm hover:shadow-xl hover:shadow-slate-200/50 hover:border-primary/20 transition-all duration-500 relative overflow-hidden">
                                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 relative z-10">
                                            <div className="flex items-center gap-5">
                                                <div className="h-16 w-16 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-[22px] text-indigo-500 shrink-0 group-hover:bg-primary group-hover:text-white transition-all duration-500 shadow-inner">
                                                    <User className="h-8 w-8" />
                                                </div>
                                                <div>
                                                    <div className="text-[17px] font-black text-slate-900 tracking-tight group-hover:text-primary transition-colors">{booking.patient?.name || 'Paciente Privado'}</div>
                                                    <div className="flex flex-wrap items-center gap-3 mt-1.5">
                                                        <span className="text-[10px] font-black uppercase tracking-widest py-1 px-3 bg-slate-100 rounded-full text-slate-500">{booking.status || 'Confirmado'}</span>
                                                        <div className="h-1 w-1 rounded-full bg-slate-300"></div>
                                                        <span className="text-[11px] font-bold text-slate-400 flex items-center gap-1">
                                                            <Stethoscope className="h-3 w-3" /> Dr(a). {booking.doctorName}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-6 sm:text-right">
                                                <div className="flex flex-col items-end">
                                                    <div className="flex items-center gap-2 text-primary">
                                                        <Clock className="h-4 w-4" />
                                                        <span className="text-[15px] font-black tracking-tight">{booking.start_at}</span>
                                                    </div>
                                                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Horário Agendado</div>
                                                </div>
                                                <ChevronRight className="h-5 w-5 text-slate-300 group-hover:text-primary transition-all group-hover:translate-x-1" />
                                            </div>
                                        </div>
                                        {/* Background decoration */}
                                        <div className="absolute -right-4 -bottom-4 h-24 w-24 bg-primary/5 rounded-full blur-2xl group-hover:bg-primary/10 transition-colors"></div>
                                    </div>
                                ))
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                                    {slots.map((slot: any, idx) => (
                                        <div key={idx} className="group bg-white/60 hover:bg-slate-900 backdrop-blur-md rounded-[32px] p-6 border border-slate-100 shadow-sm transition-all duration-500 hover:-translate-y-2 hover:shadow-2xl hover:shadow-slate-900/20">
                                            <div className="flex items-center justify-between mb-4">
                                                <div className="h-12 w-12 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center group-hover:bg-emerald-500 group-hover:text-white transition-all duration-500">
                                                    <Clock className="h-6 w-6" />
                                                </div>
                                                <CheckCircle2 className="h-5 w-5 text-emerald-500 opacity-0 group-hover:opacity-100 transition-opacity" />
                                            </div>
                                            <div className="text-2xl font-black text-slate-900 group-hover:text-white transition-colors">{slot.start}</div>
                                            <div className="text-[10px] font-black text-slate-400 uppercase tracking-[2px] mt-2 group-hover:text-emerald-400 transition-colors">Duração: {slot.duration || '00'} Minutos</div>
                                            
                                            <div className="flex gap-2 mt-6">
                                                <button 
                                                    onClick={() => {
                                                        setSelectedSlot(slot);
                                                        setIsBookingModalOpen(true);
                                                    }}
                                                    className="flex-1 py-3 bg-emerald-500 rounded-2xl text-[10px] font-black uppercase tracking-widest text-white opacity-0 group-hover:opacity-100 transition-all duration-500 hover:bg-emerald-600 shadow-lg shadow-emerald-500/20"
                                                >
                                                    Reservar
                                                </button>
                                                <button 
                                                    onClick={() => handleBlockSlot(slot)}
                                                    className="flex-1 py-3 bg-slate-100 border border-slate-200 rounded-2xl text-[10px] font-black uppercase tracking-widest text-slate-700 opacity-0 group-hover:opacity-100 transition-all duration-500 hover:bg-red-500 hover:text-white hover:border-red-500"
                                                >
                                                    Remover
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </main>
            </div>

            {/* ─── FOOTER INFO ─── */}
            <footer className="pt-12 border-t border-slate-100 flex flex-col md:flex-row items-center justify-between gap-6">
                <div className="flex items-center gap-6">
                    <img src="/vismed-logo-dark.png" alt="VisMed" className="h-5 opacity-40 grayscale" />
                    <div className="h-4 w-[1px] bg-slate-200"></div>
                    <p className="text-[11px] font-bold text-slate-400 uppercase tracking-[2px]">Core Integration Engine v2.4</p>
                </div>
                <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-500"></span>
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Sistemas Operantes • Latência: 45ms</span>
                </div>
            </footer>

            {/* ─── MODALS ─── */}
            {isBookingModalOpen && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-center justify-center p-6 animate-in fade-in duration-500">
                    <div className="bg-white/95 backdrop-blur-2xl rounded-[48px] shadow-2xl p-10 w-full max-w-xl relative border border-white/50 animate-in zoom-in-95 duration-300">
                        <button onClick={() => setIsBookingModalOpen(false)} className="absolute top-8 right-10 h-10 w-10 flex items-center justify-center rounded-xl bg-slate-50 text-slate-400 hover:bg-slate-100 transition-all text-2xl font-light">×</button>
                        
                        <div className="flex items-center gap-4 mb-8">
                            <div className="h-16 w-16 rounded-3xl bg-emerald-50 text-emerald-600 flex items-center justify-center shadow-inner border border-emerald-100">
                                <User className="h-8 w-8" />
                            </div>
                            <div>
                                <h2 className="text-2xl font-black text-slate-900 tracking-tighter">Reservar Horário</h2>
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{selectedSlot?.start}</p>
                            </div>
                        </div>

                        <div className="space-y-6">
                            <div>
                                <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-400 ml-1 mb-2 block">Nome Completo</label>
                                <input 
                                    type="text" 
                                    value={patientForm.name} 
                                    onChange={(e)=>setPatientForm({...patientForm, name: e.target.value})}
                                    placeholder="Ex: João da Silva"
                                    className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 transition-all" 
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-400 ml-1 mb-2 block">Celular</label>
                                    <input 
                                        type="tel" 
                                        value={patientForm.phone} 
                                        onChange={(e)=>setPatientForm({...patientForm, phone: e.target.value})}
                                        placeholder="(11) 99999-9999"
                                        className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 transition-all" 
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-400 ml-1 mb-2 block">E-mail</label>
                                    <input 
                                        type="email" 
                                        value={patientForm.email} 
                                        onChange={(e)=>setPatientForm({...patientForm, email: e.target.value})}
                                        placeholder="paciente@email.com"
                                        className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 transition-all" 
                                    />
                                </div>
                            </div>

                            <button 
                                onClick={handleConfirmBooking}
                                disabled={isSaving}
                                className="w-full py-5 bg-emerald-500 text-white rounded-[24px] font-black uppercase tracking-[2px] text-[12px] shadow-xl shadow-emerald-500/30 hover:bg-emerald-600 transition-all flex items-center justify-center gap-3 mt-4 disabled:opacity-50"
                            >
                                {isSaving ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
                                Confirmar Reserva
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {isWorkPeriodModalOpen && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-center justify-center p-6 animate-in fade-in duration-500">
                    <div className="bg-white/95 backdrop-blur-2xl rounded-[48px] shadow-2xl p-10 w-full max-w-xl relative border border-white/50 animate-in zoom-in-95 duration-300">
                        <button onClick={() => setIsWorkPeriodModalOpen(false)} className="absolute top-8 right-10 h-10 w-10 flex items-center justify-center rounded-xl bg-slate-50 text-slate-400 hover:bg-slate-100 transition-all text-2xl font-light">×</button>
                        
                        <div className="flex items-center gap-4 mb-8">
                            <div className="h-16 w-16 rounded-3xl bg-primary/10 text-primary flex items-center justify-center shadow-inner border border-primary/20">
                                <CalendarClock className="h-8 w-8" />
                            </div>
                            <div>
                                <h2 className="text-2xl font-black text-slate-900 tracking-tighter">Definir Expediente</h2>
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Publicação de Horários na Doctoralia</p>
                            </div>
                        </div>

                        <div className="space-y-6">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-400 ml-1 mb-2 block">Início</label>
                                    <input 
                                        type="time" 
                                        value={workPeriodForm.start} 
                                        onChange={(e)=>setWorkPeriodForm({...workPeriodForm, start: e.target.value})}
                                        className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all" 
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-400 ml-1 mb-2 block">Término</label>
                                    <input 
                                        type="time" 
                                        value={workPeriodForm.end} 
                                        onChange={(e)=>setWorkPeriodForm({...workPeriodForm, end: e.target.value})}
                                        className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all" 
                                    />
                                </div>
                            </div>
                            
                            <div className="bg-amber-50 border border-amber-100 p-5 rounded-3xl flex gap-4">
                                <AlertCircle className="h-5 w-5 text-amber-600 shrink-0" />
                                <p className="text-[11px] font-bold text-amber-800 leading-relaxed uppercase tracking-wider">
                                    Esta ação irá criar slots intercalados de 30 minutos dentro do intervalo definido para o dia {startDate}.
                                </p>
                            </div>

                            <button 
                                onClick={handleConfirmWorkPeriod}
                                disabled={isSaving}
                                className="w-full py-5 bg-primary text-white rounded-[24px] font-black uppercase tracking-[2px] text-[12px] shadow-xl shadow-primary/30 hover:bg-primary/90 transition-all flex items-center justify-center gap-3 mt-4 disabled:opacity-50"
                            >
                                {isSaving ? <Loader2 className="h-5 w-5 animate-spin" /> : <RefreshCw className="h-5 w-5" />}
                                Publicar Período
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
