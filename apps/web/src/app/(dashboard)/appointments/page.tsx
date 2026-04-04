'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
    CalendarDays, Loader2, Clock, RefreshCw, User, ChevronLeft, ChevronRight,
    Stethoscope, X, Phone, Mail, FileText, Globe, Building2, ArrowRightLeft, Ban,
    Plus, ChevronDown,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useClinic } from '@/lib/clinic-store';
import { useAuthStore } from '@/lib/store';
import { toast } from 'sonner';

interface Doctor {
    externalId: string;
    name: string;
    calendarStatus: string;
    addressId: string | null;
    facilityId: string | null;
}

interface BookingRecord {
    id?: string;
    doctoraliaBookingId?: string;
    origin: 'VISMED' | 'DOCTORALIA';
    status: string;
    patientName: string;
    patientSurname?: string;
    patientPhone?: string;
    patientEmail?: string;
    startAt: string;
    endAt: string;
    duration?: number;
    serviceName?: string;
    doctoraliaDoctorId?: string;
    vismedDoctorId?: string;
    doctorName?: string;
    start_at?: string;
    end_at?: string;
    patient?: { name?: string; surname?: string; phone?: string; email?: string };
    booked_by?: string;
    syncedToVismed?: boolean;
    syncedToDoctoralia?: boolean;
}

type ViewMode = 'day' | 'week' | 'month';

function formatTime(dateStr: string) {
    try {
        const d = new Date(dateStr);
        return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch { return dateStr; }
}

function formatDateShort(dateStr: string) {
    try {
        const d = new Date(dateStr);
        return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
    } catch { return dateStr; }
}

function getDaysInRange(start: string, end: string): string[] {
    const days: string[] = [];
    const s = new Date(start + 'T00:00:00');
    const e = new Date(end + 'T00:00:00');
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
        days.push(d.toISOString().split('T')[0]);
    }
    return days;
}

function getMonday(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    return d;
}

function getMonthRange(date: Date): { start: string; end: string } {
    const y = date.getFullYear();
    const m = date.getMonth();
    const firstDay = new Date(y, m, 1);
    const lastDay = new Date(y, m + 1, 0);
    const start = getMonday(firstDay);
    const endSunday = new Date(lastDay);
    const dayOfWeek = endSunday.getDay();
    if (dayOfWeek !== 0) endSunday.setDate(endSunday.getDate() + (7 - dayOfWeek));
    return {
        start: start.toISOString().split('T')[0],
        end: endSunday.toISOString().split('T')[0],
    };
}

export default function AppointmentsPage() {
    const { user } = useAuthStore();
    const { activeClinic } = useClinic();
    const clinicId = activeClinic?.id;

    const [doctors, setDoctors] = useState<Doctor[]>([]);
    const [selectedDoctorId, setSelectedDoctorId] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isFetching, setIsFetching] = useState(false);
    const [showDoctorDropdown, setShowDoctorDropdown] = useState(false);

    const [viewMode, setViewMode] = useState<ViewMode>('week');
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const [currentDate, setCurrentDate] = useState(today);

    const { rangeStart, rangeEnd, displayDays } = useMemo(() => {
        if (viewMode === 'day') {
            const dayStr = currentDate.toISOString().split('T')[0];
            return { rangeStart: dayStr, rangeEnd: dayStr, displayDays: [dayStr] };
        } else if (viewMode === 'week') {
            const monday = getMonday(currentDate);
            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);
            const start = monday.toISOString().split('T')[0];
            const end = sunday.toISOString().split('T')[0];
            return { rangeStart: start, rangeEnd: end, displayDays: getDaysInRange(start, end) };
        } else {
            const { start, end } = getMonthRange(currentDate);
            return { rangeStart: start, rangeEnd: end, displayDays: getDaysInRange(start, end) };
        }
    }, [viewMode, currentDate]);

    const [doctoraliaBookings, setDoctoraliaBookings] = useState<any[]>([]);
    const [syncRecords, setSyncRecords] = useState<BookingRecord[]>([]);
    const [selectedBooking, setSelectedBooking] = useState<any>(null);
    const [syncStats, setSyncStats] = useState<any>(null);

    const [isBookingModalOpen, setIsBookingModalOpen] = useState(false);
    const [bookingSlot, setBookingSlot] = useState<{ date: string; time: string } | null>(null);
    const [patientForm, setPatientForm] = useState({ name: '', surname: '', phone: '', email: '', cpf: '' });
    const [isSaving, setIsSaving] = useState(false);

    const navigate = (direction: number) => {
        const d = new Date(currentDate);
        if (viewMode === 'day') d.setDate(d.getDate() + direction);
        else if (viewMode === 'week') d.setDate(d.getDate() + direction * 7);
        else d.setMonth(d.getMonth() + direction);
        setCurrentDate(d);
    };

    const goToToday = () => setCurrentDate(new Date());

    const fetchDoctors = useCallback(async () => {
        if (!clinicId) return;
        try {
            const res = await api.get('/appointments/calendar-status', { params: { clinicId } });
            const docs = res.data?.doctors || [];
            setDoctors(docs);
            if (docs.length > 0 && !selectedDoctorId) {
                const enabled = docs.find((d: Doctor) => d.calendarStatus === 'enabled');
                setSelectedDoctorId(enabled ? enabled.externalId : docs[0].externalId);
            }
            setIsLoading(false);
        } catch {
            toast.error('Erro ao carregar profissionais');
            setIsLoading(false);
        }
    }, [clinicId, selectedDoctorId]);

    useEffect(() => { fetchDoctors(); }, [fetchDoctors]);

    const fetchBookings = useCallback(async () => {
        if (!clinicId || !selectedDoctorId) return;
        setIsFetching(true);
        try {
            const [bookingsRes, syncRes, statsRes] = await Promise.all([
                api.get('/appointments/bookings', {
                    params: { clinicId, doctorId: selectedDoctorId, start: rangeStart, end: rangeEnd }
                }),
                api.get('/booking-sync/records', {
                    params: { clinicId, doctoraliaDoctorId: selectedDoctorId, start: rangeStart, end: rangeEnd }
                }).catch(() => ({ data: [] })),
                api.get('/booking-sync/stats', { params: { clinicId } }).catch(() => ({ data: null })),
            ]);
            setDoctoraliaBookings(bookingsRes.data?.bookings || []);
            setSyncRecords(Array.isArray(syncRes.data) ? syncRes.data : []);
            setSyncStats(statsRes.data);
        } catch {
            toast.error('Erro ao buscar agendamentos');
        } finally {
            setIsFetching(false);
        }
    }, [clinicId, selectedDoctorId, rangeStart, rangeEnd]);

    useEffect(() => { fetchBookings(); }, [fetchBookings]);

    const allBookings = useMemo(() => {
        const merged: BookingRecord[] = [];
        const seenDoctoraliaIds = new Set<string>();

        for (const rec of syncRecords) {
            if (rec.doctoraliaBookingId) seenDoctoraliaIds.add(rec.doctoraliaBookingId);
            merged.push(rec);
        }

        for (const b of doctoraliaBookings) {
            const bid = String(b.id || b.visit_booking_id || '');
            if (bid && seenDoctoraliaIds.has(bid)) continue;
            merged.push({
                doctoraliaBookingId: bid,
                origin: b.booked_by === 'integration' ? 'VISMED' : 'DOCTORALIA',
                status: b.status || 'booked',
                patientName: b.patient?.name || 'Paciente',
                patientSurname: b.patient?.surname || '',
                patientPhone: b.patient?.phone ? String(b.patient.phone) : '',
                patientEmail: b.patient?.email || '',
                startAt: b.start_at,
                endAt: b.end_at,
                duration: parseInt(b.duration) || 30,
                serviceName: b.address_service?.name || '',
                doctoraliaDoctorId: selectedDoctorId,
                doctorName: b.doctorName,
                booked_by: b.booked_by,
                syncedToDoctoralia: true,
                syncedToVismed: b.booked_by === 'integration',
            });
        }
        return merged.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
    }, [syncRecords, doctoraliaBookings, selectedDoctorId]);

    const bookingsByDay = useMemo(() => {
        const map: Record<string, BookingRecord[]> = {};
        for (const day of displayDays) map[day] = [];
        for (const b of allBookings) {
            const dayKey = new Date(b.startAt).toISOString().split('T')[0];
            if (map[dayKey]) map[dayKey].push(b);
        }
        return map;
    }, [allBookings, displayDays]);

    const handleOpenBooking = (date: string) => {
        setBookingSlot({ date, time: '08:00' });
        setPatientForm({ name: '', surname: '', phone: '', email: '', cpf: '' });
        setIsBookingModalOpen(true);
    };

    const handleCreateBooking = async () => {
        if (!clinicId || !selectedDoctorId || !bookingSlot) return;
        if (!patientForm.name.trim()) { toast.error('Nome do paciente é obrigatório'); return; }
        setIsSaving(true);
        const toastId = toast.loading('Criando agendamento...');
        try {
            const slotStart = `${bookingSlot.date}T${bookingSlot.time}:00-03:00`;
            await api.post('/booking-sync/book-from-vismed', {
                clinicId,
                doctoraliaDoctorId: selectedDoctorId,
                slotStart,
                patient: {
                    name: patientForm.name,
                    surname: patientForm.surname || patientForm.name.split(' ').slice(-1)[0],
                    phone: patientForm.phone,
                    email: patientForm.email,
                    cpf: patientForm.cpf,
                },
            });
            toast.success('Agendamento criado com sucesso!', { id: toastId });
            setIsBookingModalOpen(false);
            fetchBookings();
        } catch (e: any) {
            toast.error(`Erro: ${e.response?.data?.message || e.message}`, { id: toastId });
        } finally {
            setIsSaving(false);
        }
    };

    const handleCancelBooking = async (booking: BookingRecord) => {
        if (!clinicId || !booking.doctoraliaBookingId) return;
        if (!confirm('Deseja realmente cancelar este agendamento?')) return;
        const toastId = toast.loading('Cancelando...');
        try {
            await api.delete(`/booking-sync/cancel/${booking.doctoraliaBookingId}`, { params: { clinicId } });
            toast.success('Agendamento cancelado', { id: toastId });
            setSelectedBooking(null);
            fetchBookings();
        } catch (e: any) {
            toast.error(`Erro ao cancelar: ${e.response?.data?.message || e.message}`, { id: toastId });
        }
    };

    const selectedDoctor = doctors.find(d => d.externalId === selectedDoctorId);

    const periodLabel = useMemo(() => {
        if (viewMode === 'day') {
            return currentDate.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
        } else if (viewMode === 'week') {
            const s = new Date(rangeStart + 'T00:00:00');
            const e = new Date(rangeEnd + 'T00:00:00');
            return `${s.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} — ${e.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}`;
        } else {
            return currentDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
        }
    }, [viewMode, currentDate, rangeStart, rangeEnd]);

    const activeBookings = allBookings.filter(b => b.status !== 'CANCELLED');
    const totalBookings = activeBookings.length;
    const fullySynced = activeBookings.filter(b => b.syncedToVismed && b.syncedToDoctoralia).length;
    const pendingSync = activeBookings.filter(b => !b.syncedToVismed || !b.syncedToDoctoralia).length;

    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh]">
                <Loader2 className="h-10 w-10 animate-spin text-primary opacity-30" />
                <span className="mt-4 text-[10px] font-black text-slate-400 uppercase tracking-[4px] animate-pulse">Carregando Agenda</span>
            </div>
        );
    }

    return (
        <div className="max-w-7xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">

            {/* ─── HEADER ─── */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-5">
                    <div className="h-16 w-16 rounded-[24px] bg-gradient-to-br from-primary to-indigo-600 flex items-center justify-center shadow-[0_12px_24px_-8px_rgba(99,102,241,0.4)] border border-white/20 transform rotate-1 transition-transform hover:rotate-0 duration-500">
                        <CalendarDays className="h-8 w-8 text-white" />
                    </div>
                    <div>
                        <div className="flex items-center gap-3">
                            <h1 className="text-3xl font-black text-slate-900 tracking-tighter uppercase">Agenda</h1>
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-indigo-50 text-indigo-700 border border-indigo-100 shadow-sm">
                                <ArrowRightLeft className="h-3 w-3" /> Sync Bidirecional
                            </span>
                        </div>
                        <p className="text-sm text-slate-500 font-medium mt-0.5">VisMed + Doctoralia</p>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <button
                        onClick={() => { fetchDoctors(); fetchBookings(); }}
                        disabled={isFetching}
                        className="flex items-center gap-2 px-5 py-3 bg-white/80 backdrop-blur-sm border border-slate-200 text-slate-600 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-white hover:shadow-md transition-all disabled:opacity-50"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} /> Atualizar
                    </button>
                </div>
            </div>

            {/* ─── METRICS ─── */}
            <div className="grid grid-cols-3 gap-4">
                {[
                    { label: 'Total Agendamentos', value: totalBookings, color: 'text-slate-900', icon: <CalendarDays className="h-5 w-5 text-slate-400" /> },
                    { label: 'Sincronizados', value: fullySynced, color: 'text-emerald-600', icon: <ArrowRightLeft className="h-5 w-5 text-emerald-500" /> },
                    { label: 'Pendentes', value: pendingSync, color: pendingSync > 0 ? 'text-amber-600' : 'text-slate-400', icon: <Clock className="h-5 w-5 text-amber-400" /> },
                ].map((m) => (
                    <div key={m.label} className="bg-white/70 backdrop-blur-xl rounded-[32px] p-5 shadow-sm border border-slate-100/60 flex items-center gap-4 transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5">
                        {m.icon}
                        <div>
                            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{m.label}</div>
                            <div className={`text-2xl font-black tracking-tighter ${m.color}`}>{m.value}</div>
                        </div>
                    </div>
                ))}
            </div>

            {/* ─── TOOLBAR: View mode + Doctor selector + Navigation ─── */}
            <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    {/* View mode pills */}
                    <div className="bg-white/40 backdrop-blur-md rounded-[20px] p-1.5 flex gap-1 border border-slate-100/60">
                        {(['day', 'week', 'month'] as ViewMode[]).map((mode) => (
                            <button
                                key={mode}
                                onClick={() => setViewMode(mode)}
                                className={`px-4 py-2 rounded-[16px] text-[10px] font-black uppercase tracking-widest transition-all duration-300 ${
                                    viewMode === mode
                                        ? 'bg-white text-slate-900 shadow-md'
                                        : 'text-slate-400 hover:text-slate-600'
                                }`}
                            >
                                {mode === 'day' ? 'Dia' : mode === 'week' ? 'Semana' : 'Mês'}
                            </button>
                        ))}
                    </div>

                    {/* Doctor selector */}
                    <div className="relative">
                        <button
                            onClick={() => setShowDoctorDropdown(!showDoctorDropdown)}
                            className="flex items-center gap-2.5 px-4 py-2.5 bg-white/80 backdrop-blur-sm border border-slate-200 rounded-2xl hover:bg-white hover:shadow-md transition-all"
                        >
                            <div className="h-7 w-7 rounded-xl bg-gradient-to-br from-primary to-emerald-600 text-white flex items-center justify-center text-[11px] font-black">
                                {selectedDoctor?.name?.charAt(0) || '?'}
                            </div>
                            <span className="text-[11px] font-bold text-slate-700 max-w-[160px] truncate">{selectedDoctor?.name || 'Selecionar'}</span>
                            <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                        </button>
                        {showDoctorDropdown && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setShowDoctorDropdown(false)} />
                                <div className="absolute top-full left-0 mt-2 w-72 bg-white rounded-2xl shadow-2xl border border-slate-200 z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                                    <div className="p-3 border-b border-slate-100">
                                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Profissionais</span>
                                    </div>
                                    <div className="max-h-[300px] overflow-y-auto">
                                        {doctors.map((doc) => (
                                            <button
                                                key={doc.externalId}
                                                onClick={() => { setSelectedDoctorId(doc.externalId); setShowDoctorDropdown(false); }}
                                                className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-all hover:bg-slate-50 ${
                                                    selectedDoctorId === doc.externalId ? 'bg-primary/5' : ''
                                                }`}
                                            >
                                                <div className={`h-8 w-8 rounded-xl flex items-center justify-center text-[11px] font-black ${
                                                    selectedDoctorId === doc.externalId ? 'bg-primary text-white' : 'bg-slate-100 text-slate-400'
                                                }`}>
                                                    {doc.name.charAt(0)}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className={`text-[12px] font-bold truncate ${selectedDoctorId === doc.externalId ? 'text-primary' : 'text-slate-700'}`}>
                                                        {doc.name}
                                                    </div>
                                                    <div className="flex items-center gap-1.5 mt-0.5">
                                                        <div className={`h-1.5 w-1.5 rounded-full ${doc.calendarStatus === 'enabled' ? 'bg-emerald-500' : 'bg-slate-300'}`}></div>
                                                        <span className="text-[9px] font-bold text-slate-400 uppercase">{doc.calendarStatus === 'enabled' ? 'Online' : 'Offline'}</span>
                                                    </div>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* Navigation */}
                <div className="flex items-center gap-2">
                    <button onClick={() => navigate(-1)} className="h-9 w-9 rounded-xl bg-white/80 border border-slate-200 hover:bg-white hover:shadow-md flex items-center justify-center transition-all">
                        <ChevronLeft className="h-4 w-4 text-slate-600" />
                    </button>
                    <button onClick={goToToday} className="px-4 py-2 rounded-xl bg-primary/10 text-primary text-[10px] font-black uppercase tracking-widest hover:bg-primary/20 transition-all">
                        Hoje
                    </button>
                    <button onClick={() => navigate(1)} className="h-9 w-9 rounded-xl bg-white/80 border border-slate-200 hover:bg-white hover:shadow-md flex items-center justify-center transition-all">
                        <ChevronRight className="h-4 w-4 text-slate-600" />
                    </button>
                    <span className="text-[13px] font-bold text-slate-700 ml-2 capitalize">{periodLabel}</span>
                </div>
            </div>

            {/* ─── CALENDAR BODY ─── */}
            <div className="bg-white/70 backdrop-blur-xl rounded-[32px] shadow-sm border border-slate-100/80 overflow-hidden">
                {/* Column headers for week/month */}
                {viewMode !== 'day' && (
                    <div className={`grid border-b border-slate-100 ${viewMode === 'month' ? 'grid-cols-7' : 'grid-cols-7'}`}>
                        {(viewMode === 'month' ? ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'] : displayDays.map(day => {
                            const d = new Date(day + 'T00:00:00');
                            return d.toLocaleDateString('pt-BR', { weekday: 'short' });
                        })).map((label, i) => (
                            <div key={i} className="text-center py-2.5 text-[9px] font-black text-slate-400 uppercase tracking-widest border-r border-slate-50 last:border-0">
                                {label}
                            </div>
                        ))}
                    </div>
                )}

                {/* Month grid */}
                {viewMode === 'month' && (
                    <div className="grid grid-cols-7">
                        {displayDays.map((day) => {
                            const d = new Date(day + 'T00:00:00');
                            const isToday = day === todayStr;
                            const isCurrentMonth = d.getMonth() === currentDate.getMonth();
                            const dayBookings = bookingsByDay[day] || [];
                            return (
                                <div
                                    key={day}
                                    className={`min-h-[100px] border-r border-b border-slate-50 p-2 transition-colors ${
                                        isToday ? 'bg-primary/[0.04]' : !isCurrentMonth ? 'bg-slate-50/50' : 'hover:bg-slate-50/50'
                                    }`}
                                >
                                    <div className="flex items-center justify-between mb-1">
                                        <span className={`text-[13px] font-black ${
                                            isToday ? 'text-white bg-primary rounded-lg px-2 py-0.5' : isCurrentMonth ? 'text-slate-700' : 'text-slate-300'
                                        }`}>
                                            {d.getDate()}
                                        </span>
                                        {isCurrentMonth && (
                                            <button
                                                onClick={() => handleOpenBooking(day)}
                                                className="h-5 w-5 rounded-md bg-slate-100 hover:bg-primary hover:text-white text-slate-400 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all text-[10px]"
                                                style={{ opacity: 1 }}
                                            >
                                                <Plus className="h-3 w-3" />
                                            </button>
                                        )}
                                    </div>
                                    <div className="space-y-0.5">
                                        {dayBookings.slice(0, 3).map((b, idx) => {
                                            const isCancelled = b.status === 'CANCELLED';
                                            const isMoved = b.status === 'MOVED';
                                            const bothSynced = b.syncedToVismed && b.syncedToDoctoralia;
                                            const dotColor = isCancelled ? 'bg-red-400' : isMoved ? 'bg-amber-400' : bothSynced ? 'bg-emerald-500' : 'bg-amber-400';
                                            return (
                                                <button
                                                    key={idx}
                                                    onClick={() => setSelectedBooking(b)}
                                                    className={`w-full text-left flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-bold transition-all hover:bg-slate-100 ${isCancelled ? 'line-through opacity-50' : 'text-slate-600'}`}
                                                >
                                                    <div className={`h-1.5 w-1.5 rounded-full shrink-0 ${dotColor}`}></div>
                                                    <span className="font-black text-slate-500">{formatTime(b.startAt)}</span>
                                                    <span className="truncate">{b.patientName}</span>
                                                </button>
                                            );
                                        })}
                                        {dayBookings.length > 3 && (
                                            <span className="text-[8px] font-black text-slate-400 pl-1">+{dayBookings.length - 3} mais</span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Week view */}
                {viewMode === 'week' && (
                    <div className="grid grid-cols-7">
                        {/* Day number row */}
                        {displayDays.map((day) => {
                            const d = new Date(day + 'T00:00:00');
                            const isToday = day === todayStr;
                            const dayBookings = bookingsByDay[day] || [];
                            return (
                                <div key={day} className={`border-r border-slate-50 last:border-0 ${isToday ? 'bg-primary/[0.03]' : ''}`}>
                                    <div className="text-center py-2 border-b border-slate-50">
                                        <span className={`inline-flex items-center justify-center h-8 w-8 rounded-xl text-[16px] font-black ${
                                            isToday ? 'bg-primary text-white' : 'text-slate-700'
                                        }`}>
                                            {d.getDate()}
                                        </span>
                                    </div>
                                    <div className="min-h-[400px] p-2 space-y-1">
                                        {dayBookings.map((b, idx) => {
                                            const isCancelled = b.status === 'CANCELLED';
                                            const isMoved = b.status === 'MOVED';
                                            const bothSynced = b.syncedToVismed && b.syncedToDoctoralia;
                                            const bgColor = isCancelled ? 'bg-red-50 border-red-200'
                                                : isMoved ? 'bg-amber-50 border-amber-200'
                                                : bothSynced ? 'bg-emerald-50 border-emerald-200'
                                                : 'bg-amber-50 border-amber-200';
                                            const textColor = isCancelled ? 'text-red-700'
                                                : isMoved ? 'text-amber-700'
                                                : bothSynced ? 'text-emerald-700'
                                                : 'text-amber-700';
                                            const dotColor = isCancelled ? 'bg-red-400' : isMoved ? 'bg-amber-400' : bothSynced ? 'bg-emerald-500' : 'bg-amber-400';
                                            return (
                                                <button
                                                    key={idx}
                                                    onClick={() => setSelectedBooking(b)}
                                                    className={`w-full text-left p-2 rounded-xl border transition-all hover:shadow-md hover:-translate-y-0.5 ${bgColor} ${isCancelled ? 'opacity-50 line-through' : ''}`}
                                                >
                                                    <div className="flex items-center gap-1.5 mb-1">
                                                        <div className={`h-2 w-2 rounded-full ${dotColor}`}></div>
                                                        <span className={`text-[10px] font-black ${textColor}`}>{formatTime(b.startAt)}</span>
                                                    </div>
                                                    <div className={`text-[10px] font-bold truncate ${textColor}`}>
                                                        {b.patientName}{b.patientSurname ? ` ${b.patientSurname}` : ''}
                                                    </div>
                                                    <div className="flex items-center gap-1 mt-1">
                                                        <span className={`text-[7px] font-black uppercase tracking-wider px-1 py-0.5 rounded ${b.syncedToVismed ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>V</span>
                                                        <span className={`text-[7px] font-black uppercase tracking-wider px-1 py-0.5 rounded ${b.syncedToDoctoralia ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400'}`}>D</span>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                        <button
                                            onClick={() => handleOpenBooking(day)}
                                            className="w-full flex items-center justify-center gap-1 py-2 rounded-xl border border-dashed border-slate-200 text-[9px] font-bold text-slate-300 hover:border-primary hover:text-primary hover:bg-primary/5 transition-all mt-1"
                                        >
                                            <Plus className="h-3 w-3" /> Agendar
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Day view */}
                {viewMode === 'day' && (() => {
                    const dayStr = displayDays[0];
                    const dayBookings = bookingsByDay[dayStr] || [];
                    const hours = Array.from({ length: 14 }, (_, i) => i + 7);
                    return (
                        <div>
                            <div className="text-center py-3 border-b border-slate-100">
                                <span className="text-[13px] font-bold text-slate-700 capitalize">
                                    {new Date(dayStr + 'T00:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })}
                                </span>
                            </div>
                            <div className="divide-y divide-slate-50">
                                {hours.map((hour) => {
                                    const hourStr = `${hour.toString().padStart(2, '0')}`;
                                    const hourBookings = dayBookings.filter(b => {
                                        const bHour = new Date(b.startAt).getHours();
                                        return bHour === hour;
                                    });
                                    return (
                                        <div key={hour} className="grid grid-cols-[80px_1fr] min-h-[56px]">
                                            <div className="px-4 py-3 border-r border-slate-100 flex items-start">
                                                <span className="text-[12px] font-bold text-slate-400">{hourStr}:00</span>
                                            </div>
                                            <div className="px-3 py-2 flex flex-wrap gap-2 items-start">
                                                {hourBookings.map((b, idx) => {
                                                    const isCancelled = b.status === 'CANCELLED';
                                                    const isMoved = b.status === 'MOVED';
                                                    const bothSynced = b.syncedToVismed && b.syncedToDoctoralia;
                                                    const bgColor = isCancelled ? 'bg-red-50 border-red-200 text-red-700'
                                                        : isMoved ? 'bg-amber-50 border-amber-200 text-amber-700'
                                                        : bothSynced ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                                        : 'bg-amber-50 border-amber-200 text-amber-700';
                                                    const dotColor = isCancelled ? 'bg-red-400' : isMoved ? 'bg-amber-400' : bothSynced ? 'bg-emerald-500' : 'bg-amber-400';
                                                    return (
                                                        <button
                                                            key={idx}
                                                            onClick={() => setSelectedBooking(b)}
                                                            className={`flex items-center gap-2.5 px-4 py-2.5 rounded-2xl border text-[11px] font-bold transition-all hover:shadow-lg hover:-translate-y-0.5 ${bgColor} ${isCancelled ? 'line-through opacity-50' : ''}`}
                                                        >
                                                            <div className={`h-2.5 w-2.5 rounded-full ${dotColor}`}></div>
                                                            <span className="font-black">{formatTime(b.startAt)}</span>
                                                            <span className="max-w-[200px] truncate">{b.patientName}{b.patientSurname ? ` ${b.patientSurname}` : ''}</span>
                                                            <span className={`text-[7px] font-black uppercase px-1 py-0.5 rounded ${b.syncedToVismed ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>V</span>
                                                            <span className={`text-[7px] font-black uppercase px-1 py-0.5 rounded ${b.syncedToDoctoralia ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400'}`}>D</span>
                                                        </button>
                                                    );
                                                })}
                                                {hourBookings.length === 0 && (
                                                    <button
                                                        onClick={() => { setBookingSlot({ date: dayStr, time: `${hourStr}:00` }); setPatientForm({ name: '', surname: '', phone: '', email: '', cpf: '' }); setIsBookingModalOpen(true); }}
                                                        className="flex items-center gap-1 px-3 py-2 rounded-xl border border-dashed border-transparent hover:border-slate-200 text-[9px] font-bold text-transparent hover:text-slate-400 transition-all"
                                                    >
                                                        <Plus className="h-3 w-3" /> Agendar
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })()}
            </div>

            {/* Legend bar */}
            <div className="flex items-center gap-6 px-2">
                {[
                    { color: 'bg-emerald-500', label: 'Sincronizado (V+D)' },
                    { color: 'bg-amber-400', label: 'Sincronização Pendente' },
                    { color: 'bg-red-400', label: 'Cancelado' },
                ].map((l) => (
                    <div key={l.label} className="flex items-center gap-1.5">
                        <div className={`h-2.5 w-2.5 rounded-full ${l.color}`}></div>
                        <span className="text-[10px] font-bold text-slate-400">{l.label}</span>
                    </div>
                ))}
            </div>

            {/* ─── BOOKING DETAIL MODAL ─── */}
            {selectedBooking && (
                <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-6" onClick={() => setSelectedBooking(null)}>
                    <div className="bg-white rounded-[32px] shadow-2xl p-8 w-full max-w-lg relative animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => setSelectedBooking(null)} className="absolute top-5 right-5 h-8 w-8 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-all">
                            <X className="h-4 w-4 text-slate-500" />
                        </button>

                        <div className="flex items-center gap-4 mb-6">
                            <div className={`h-14 w-14 rounded-2xl flex items-center justify-center ${
                                selectedBooking.syncedToVismed && selectedBooking.syncedToDoctoralia ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'
                            }`}>
                                <ArrowRightLeft className="h-7 w-7" />
                            </div>
                            <div>
                                <h2 className="text-xl font-black text-slate-900 tracking-tight">Detalhes do Agendamento</h2>
                                <div className="flex items-center gap-2 mt-1">
                                    <span className={`px-2.5 py-0.5 rounded-lg text-[9px] font-black uppercase tracking-wider ${
                                        selectedBooking.status === 'CANCELLED' ? 'bg-red-100 text-red-700' :
                                        selectedBooking.status === 'MOVED' ? 'bg-amber-100 text-amber-700' :
                                        'bg-slate-100 text-slate-600'
                                    }`}>
                                        {selectedBooking.status}
                                    </span>
                                    <span className={`text-[8px] font-black uppercase tracking-wider ${
                                        selectedBooking.origin === 'VISMED' ? 'text-emerald-500' : 'text-blue-500'
                                    }`}>
                                        Origem: {selectedBooking.origin === 'VISMED' ? 'VisMed' : 'Doctoralia'}
                                    </span>
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center gap-3 mb-5">
                            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider border ${
                                selectedBooking.syncedToVismed ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-slate-50 border-slate-200 text-slate-400'
                            }`}>
                                <Building2 className="h-3.5 w-3.5" />
                                VisMed {selectedBooking.syncedToVismed ? '✓' : '✗'}
                            </div>
                            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider border ${
                                selectedBooking.syncedToDoctoralia ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-slate-50 border-slate-200 text-slate-400'
                            }`}>
                                <Globe className="h-3.5 w-3.5" />
                                Doctoralia {selectedBooking.syncedToDoctoralia ? '✓' : '✗'}
                            </div>
                        </div>

                        <div className="space-y-4 bg-slate-50 rounded-2xl p-5">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <div className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-1">Paciente</div>
                                    <div className="text-[13px] font-bold text-slate-800 flex items-center gap-2">
                                        <User className="h-4 w-4 text-slate-400" />
                                        {selectedBooking.patientName} {selectedBooking.patientSurname || ''}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-1">Horário</div>
                                    <div className="text-[13px] font-bold text-slate-800 flex items-center gap-2">
                                        <Clock className="h-4 w-4 text-slate-400" />
                                        {formatTime(selectedBooking.startAt)} — {formatTime(selectedBooking.endAt)}
                                    </div>
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <div className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-1">Data</div>
                                    <div className="text-[13px] font-bold text-slate-800 flex items-center gap-2">
                                        <CalendarDays className="h-4 w-4 text-slate-400" />
                                        {formatDateShort(selectedBooking.startAt)}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-1">Duração</div>
                                    <div className="text-[13px] font-bold text-slate-800">{selectedBooking.duration || 30} min</div>
                                </div>
                            </div>
                            {selectedBooking.patientPhone && (
                                <div>
                                    <div className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-1">Telefone</div>
                                    <div className="text-[12px] font-bold text-slate-700 flex items-center gap-2">
                                        <Phone className="h-3.5 w-3.5 text-slate-400" /> {selectedBooking.patientPhone}
                                    </div>
                                </div>
                            )}
                            {selectedBooking.patientEmail && (
                                <div>
                                    <div className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-1">Email</div>
                                    <div className="text-[12px] font-bold text-slate-700 flex items-center gap-2">
                                        <Mail className="h-3.5 w-3.5 text-slate-400" /> {selectedBooking.patientEmail}
                                    </div>
                                </div>
                            )}
                            {selectedBooking.serviceName && (
                                <div>
                                    <div className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-1">Serviço</div>
                                    <div className="text-[12px] font-bold text-slate-700 flex items-center gap-2">
                                        <FileText className="h-3.5 w-3.5 text-slate-400" /> {selectedBooking.serviceName}
                                    </div>
                                </div>
                            )}
                        </div>

                        {selectedBooking.status !== 'CANCELLED' && selectedBooking.doctoraliaBookingId && (
                            <div className="mt-5">
                                <button
                                    onClick={() => handleCancelBooking(selectedBooking)}
                                    className="w-full py-3 bg-red-50 border border-red-200 text-red-700 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-red-100 transition-all flex items-center justify-center gap-2"
                                >
                                    <Ban className="h-4 w-4" /> Cancelar Agendamento
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ─── CREATE BOOKING MODAL ─── */}
            {isBookingModalOpen && bookingSlot && (
                <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-6" onClick={() => setIsBookingModalOpen(false)}>
                    <div className="bg-white rounded-[32px] shadow-2xl p-8 w-full max-w-lg relative animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => setIsBookingModalOpen(false)} className="absolute top-5 right-5 h-8 w-8 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-all">
                            <X className="h-4 w-4 text-slate-500" />
                        </button>

                        <div className="flex items-center gap-4 mb-6">
                            <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-primary to-emerald-600 text-white flex items-center justify-center">
                                <CalendarDays className="h-7 w-7" />
                            </div>
                            <div>
                                <h2 className="text-xl font-black text-slate-900 tracking-tight">Novo Agendamento</h2>
                                <p className="text-[11px] font-bold text-slate-400 capitalize">
                                    {new Date(bookingSlot.date + 'T00:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })}
                                </p>
                            </div>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Horário</label>
                                <input
                                    type="time"
                                    value={bookingSlot.time}
                                    onChange={(e) => setBookingSlot({ ...bookingSlot, time: e.target.value })}
                                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Nome</label>
                                    <input type="text" value={patientForm.name} onChange={(e) => setPatientForm({ ...patientForm, name: e.target.value })} placeholder="Nome do paciente"
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all" />
                                </div>
                                <div>
                                    <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Sobrenome</label>
                                    <input type="text" value={patientForm.surname} onChange={(e) => setPatientForm({ ...patientForm, surname: e.target.value })} placeholder="Sobrenome"
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all" />
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Telefone</label>
                                    <input type="tel" value={patientForm.phone} onChange={(e) => setPatientForm({ ...patientForm, phone: e.target.value })} placeholder="(11) 99999-9999"
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all" />
                                </div>
                                <div>
                                    <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">CPF</label>
                                    <input type="text" value={patientForm.cpf} onChange={(e) => setPatientForm({ ...patientForm, cpf: e.target.value })} placeholder="000.000.000-00"
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all" />
                                </div>
                            </div>
                            <div>
                                <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">Email</label>
                                <input type="email" value={patientForm.email} onChange={(e) => setPatientForm({ ...patientForm, email: e.target.value })} placeholder="paciente@email.com"
                                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all" />
                            </div>

                            <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-3 flex items-center gap-3">
                                <ArrowRightLeft className="h-4 w-4 text-emerald-600 shrink-0" />
                                <p className="text-[9px] font-bold text-emerald-700 uppercase tracking-wider">
                                    Agendamento será criado no VisMed e na Doctoralia simultaneamente.
                                </p>
                            </div>

                            <button
                                onClick={handleCreateBooking}
                                disabled={isSaving || !patientForm.name.trim()}
                                className="w-full py-3.5 bg-gradient-to-r from-primary to-emerald-600 hover:from-primary/90 hover:to-emerald-600/90 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-[0_8px_20px_-6px_rgba(31,181,122,0.4)] transition-all disabled:opacity-40 flex items-center justify-center gap-2"
                            >
                                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarDays className="h-4 w-4" />}
                                {isSaving ? 'Agendando...' : 'Confirmar Agendamento'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
