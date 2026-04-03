'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
    CalendarDays, AlertCircle, Loader2, Clock, RefreshCw, User, ChevronLeft, ChevronRight,
    Stethoscope, X, Phone, Mail, FileText, Globe, Building2, ArrowRightLeft, Ban,
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
}

function formatTime(dateStr: string) {
    try {
        const d = new Date(dateStr);
        return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch { return dateStr; }
}

function formatDate(dateStr: string) {
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

export default function AppointmentsPage() {
    const { user } = useAuthStore();
    const { activeClinic } = useClinic();
    const clinicId = activeClinic?.id;

    const [doctors, setDoctors] = useState<Doctor[]>([]);
    const [selectedDoctorId, setSelectedDoctorId] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isFetching, setIsFetching] = useState(false);

    const today = new Date();
    const [weekStart, setWeekStart] = useState(() => {
        const d = new Date(today);
        d.setDate(d.getDate() - d.getDay() + 1);
        return d.toISOString().split('T')[0];
    });

    const weekEnd = useMemo(() => {
        const d = new Date(weekStart + 'T00:00:00');
        d.setDate(d.getDate() + 6);
        return d.toISOString().split('T')[0];
    }, [weekStart]);

    const weekDays = useMemo(() => getDaysInRange(weekStart, weekEnd), [weekStart, weekEnd]);

    const [doctoraliaBookings, setDoctoraliaBookings] = useState<any[]>([]);
    const [syncRecords, setSyncRecords] = useState<BookingRecord[]>([]);
    const [selectedBooking, setSelectedBooking] = useState<any>(null);

    const [isBookingModalOpen, setIsBookingModalOpen] = useState(false);
    const [bookingSlot, setBookingSlot] = useState<{ date: string; time: string } | null>(null);
    const [patientForm, setPatientForm] = useState({ name: '', surname: '', phone: '', email: '', cpf: '' });
    const [isSaving, setIsSaving] = useState(false);

    const [syncStats, setSyncStats] = useState<any>(null);

    const navigateWeek = (direction: number) => {
        const d = new Date(weekStart + 'T00:00:00');
        d.setDate(d.getDate() + direction * 7);
        setWeekStart(d.toISOString().split('T')[0]);
    };

    const goToToday = () => {
        const d = new Date();
        d.setDate(d.getDate() - d.getDay() + 1);
        setWeekStart(d.toISOString().split('T')[0]);
    };

    const fetchDoctors = useCallback(async () => {
        if (!clinicId) return;
        try {
            const res = await api.get('/appointments/calendar-status', { params: { clinicId } });
            const docs = res.data?.doctors || [];
            setDoctors(docs);
            if (docs.length > 0 && !selectedDoctorId) {
                const enabled = docs.find((d: Doctor) => d.calendarStatus === 'enabled');
                if (enabled) setSelectedDoctorId(enabled.externalId);
                else setSelectedDoctorId(docs[0].externalId);
            }
            setIsLoading(false);
        } catch (e: any) {
            toast.error('Erro ao carregar médicos');
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
                    params: { clinicId, doctorId: selectedDoctorId, start: weekStart, end: weekEnd }
                }),
                api.get('/booking-sync/records', {
                    params: { clinicId, doctoraliaDoctorId: selectedDoctorId, start: weekStart, end: weekEnd }
                }).catch(() => ({ data: [] })),
                api.get('/booking-sync/stats', { params: { clinicId } }).catch(() => ({ data: null })),
            ]);

            setDoctoraliaBookings(bookingsRes.data?.bookings || []);
            setSyncRecords(Array.isArray(syncRes.data) ? syncRes.data : []);
            setSyncStats(statsRes.data);
        } catch (e: any) {
            toast.error('Erro ao buscar agendamentos');
        } finally {
            setIsFetching(false);
        }
    }, [clinicId, selectedDoctorId, weekStart, weekEnd]);

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
            });
        }

        return merged.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
    }, [syncRecords, doctoraliaBookings, selectedDoctorId]);

    const bookingsByDay = useMemo(() => {
        const map: Record<string, BookingRecord[]> = {};
        for (const day of weekDays) {
            map[day] = [];
        }
        for (const b of allBookings) {
            const dayKey = new Date(b.startAt).toISOString().split('T')[0];
            if (map[dayKey]) {
                map[dayKey].push(b);
            }
        }
        return map;
    }, [allBookings, weekDays]);

    const handleOpenBooking = (date: string) => {
        setBookingSlot({ date, time: '08:00' });
        setPatientForm({ name: '', surname: '', phone: '', email: '', cpf: '' });
        setIsBookingModalOpen(true);
    };

    const handleCreateBooking = async () => {
        if (!clinicId || !selectedDoctorId || !bookingSlot) return;
        if (!patientForm.name.trim()) {
            toast.error('Nome do paciente é obrigatório');
            return;
        }

        setIsSaving(true);
        const toastId = toast.loading('Criando agendamento...');

        try {
            const slotStart = `${bookingSlot.date}T${bookingSlot.time}:00-03:00`;

            const selectedDoc = doctors.find(d => d.externalId === selectedDoctorId);

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
            await api.delete(`/booking-sync/cancel/${booking.doctoraliaBookingId}`, {
                params: { clinicId },
            });
            toast.success('Agendamento cancelado', { id: toastId });
            setSelectedBooking(null);
            fetchBookings();
        } catch (e: any) {
            toast.error(`Erro ao cancelar: ${e.response?.data?.message || e.message}`, { id: toastId });
        }
    };

    const selectedDoctor = doctors.find(d => d.externalId === selectedDoctorId);
    const todayStr = today.toISOString().split('T')[0];

    const hours = Array.from({ length: 15 }, (_, i) => {
        const h = i + 7;
        return `${h.toString().padStart(2, '0')}:00`;
    });

    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen">
                <Loader2 className="h-12 w-12 animate-spin text-primary opacity-20" />
                <div className="mt-4 text-[11px] font-black text-slate-400 uppercase tracking-[4px] animate-pulse">Carregando Agenda...</div>
            </div>
        );
    }

    return (
        <div className="max-w-[1700px] mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700 pb-20">

            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
                <div className="flex items-center gap-5">
                    <div className="h-16 w-16 rounded-[24px] bg-gradient-to-br from-primary to-indigo-600 flex items-center justify-center shadow-2xl shadow-primary/30">
                        <CalendarDays className="h-8 w-8 text-white" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-black text-slate-900 tracking-tight">Agenda</h1>
                        <p className="text-slate-500 text-sm font-medium">Agendamentos sincronizados VisMed + Doctoralia</p>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    {syncStats && (
                        <div className="flex items-center gap-4 mr-4">
                            <div className="flex items-center gap-1.5">
                                <div className="h-2.5 w-2.5 rounded-full bg-emerald-500"></div>
                                <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider">VisMed: {syncStats.byOrigin?.VISMED || 0}</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                                <div className="h-2.5 w-2.5 rounded-full bg-blue-500"></div>
                                <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider">Doctoralia: {syncStats.byOrigin?.DOCTORALIA || 0}</span>
                            </div>
                        </div>
                    )}
                    <button onClick={() => { fetchDoctors(); fetchBookings(); }} className="flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-[11px] font-bold hover:bg-slate-50 transition-all shadow-sm">
                        <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} /> Atualizar
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[280px_1fr] gap-6 items-start">

                <aside className="space-y-4">
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                        <div className="px-4 py-3 border-b border-slate-100">
                            <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[2px]">Profissionais</h3>
                        </div>
                        <div className="max-h-[500px] overflow-y-auto">
                            {doctors.map((doc) => (
                                <button
                                    key={doc.externalId}
                                    onClick={() => setSelectedDoctorId(doc.externalId)}
                                    className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-all border-b border-slate-50 last:border-0
                                        ${selectedDoctorId === doc.externalId
                                            ? 'bg-primary/5 border-l-4 !border-l-primary'
                                            : 'hover:bg-slate-50'}`}
                                >
                                    <div className={`h-9 w-9 rounded-xl flex items-center justify-center text-[12px] font-black shrink-0
                                        ${selectedDoctorId === doc.externalId ? 'bg-primary text-white' : 'bg-slate-100 text-slate-400'}`}>
                                        {doc.name.charAt(0)}
                                    </div>
                                    <div className="min-w-0 flex-1">
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
                            {doctors.length === 0 && (
                                <div className="p-6 text-center text-slate-400 text-sm">Nenhum médico mapeado</div>
                            )}
                        </div>
                    </div>

                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[2px] mb-3">Legenda</h3>
                        <div className="space-y-2">
                            <div className="flex items-center gap-2">
                                <div className="h-3 w-3 rounded bg-emerald-500"></div>
                                <span className="text-[11px] text-slate-600 font-medium">Agendado pelo VisMed</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="h-3 w-3 rounded bg-blue-500"></div>
                                <span className="text-[11px] text-slate-600 font-medium">Agendado pela Doctoralia</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="h-3 w-3 rounded bg-red-400"></div>
                                <span className="text-[11px] text-slate-600 font-medium">Cancelado</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="h-3 w-3 rounded bg-amber-400"></div>
                                <span className="text-[11px] text-slate-600 font-medium">Movido</span>
                            </div>
                        </div>
                    </div>
                </aside>

                <main className="space-y-4">
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
                        <div className="flex items-center justify-between px-6 py-3 border-b border-slate-100">
                            <div className="flex items-center gap-3">
                                <button onClick={() => navigateWeek(-1)} className="h-8 w-8 rounded-lg bg-slate-50 hover:bg-slate-100 flex items-center justify-center transition-all">
                                    <ChevronLeft className="h-4 w-4 text-slate-600" />
                                </button>
                                <button onClick={goToToday} className="px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-[10px] font-black uppercase tracking-wider hover:bg-primary/20 transition-all">
                                    Hoje
                                </button>
                                <button onClick={() => navigateWeek(1)} className="h-8 w-8 rounded-lg bg-slate-50 hover:bg-slate-100 flex items-center justify-center transition-all">
                                    <ChevronRight className="h-4 w-4 text-slate-600" />
                                </button>
                            </div>
                            <div className="text-[13px] font-bold text-slate-700">
                                {new Date(weekStart + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} — {new Date(weekEnd + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}
                            </div>
                            {selectedDoctor && (
                                <div className="flex items-center gap-2">
                                    <Stethoscope className="h-4 w-4 text-primary" />
                                    <span className="text-[12px] font-bold text-slate-600">{selectedDoctor.name}</span>
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-7 border-b border-slate-100">
                            {weekDays.map((day) => {
                                const d = new Date(day + 'T00:00:00');
                                const isToday = day === todayStr;
                                const dayBookings = bookingsByDay[day] || [];
                                return (
                                    <div key={day} className={`text-center py-2 border-r border-slate-50 last:border-0 ${isToday ? 'bg-primary/5' : ''}`}>
                                        <div className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                                            {d.toLocaleDateString('pt-BR', { weekday: 'short' })}
                                        </div>
                                        <div className={`text-[18px] font-black mt-0.5 ${isToday ? 'text-primary' : 'text-slate-800'}`}>
                                            {d.getDate()}
                                        </div>
                                        {dayBookings.length > 0 && (
                                            <div className="flex items-center justify-center gap-0.5 mt-1">
                                                {dayBookings.slice(0, 5).map((b, i) => (
                                                    <div key={i} className={`h-1.5 w-1.5 rounded-full ${
                                                        b.status === 'CANCELLED' ? 'bg-red-400' :
                                                        b.status === 'MOVED' ? 'bg-amber-400' :
                                                        b.origin === 'VISMED' ? 'bg-emerald-500' : 'bg-blue-500'
                                                    }`}></div>
                                                ))}
                                                {dayBookings.length > 5 && <span className="text-[8px] text-slate-400 ml-0.5">+{dayBookings.length - 5}</span>}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        <div className="divide-y divide-slate-50">
                            {weekDays.map((day) => {
                                const d = new Date(day + 'T00:00:00');
                                const isToday = day === todayStr;
                                const dayBookings = bookingsByDay[day] || [];

                                return (
                                    <div key={day} className={`${isToday ? 'bg-primary/[0.02]' : ''}`}>
                                        <div className="grid grid-cols-[100px_1fr] min-h-[60px]">
                                            <div className="px-3 py-2 border-r border-slate-100 flex flex-col justify-center">
                                                <div className="text-[10px] font-black text-slate-400 uppercase">
                                                    {d.toLocaleDateString('pt-BR', { weekday: 'short' })}
                                                </div>
                                                <div className={`text-[15px] font-black ${isToday ? 'text-primary' : 'text-slate-700'}`}>
                                                    {d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                                                </div>
                                            </div>
                                            <div className="px-3 py-2 flex flex-wrap gap-2 items-center">
                                                {dayBookings.length === 0 ? (
                                                    <span className="text-[11px] text-slate-300 font-medium italic">Sem agendamentos</span>
                                                ) : (
                                                    dayBookings.map((b, idx) => {
                                                        const isCancelled = b.status === 'CANCELLED';
                                                        const isMoved = b.status === 'MOVED';
                                                        const isVismed = b.origin === 'VISMED';

                                                        const bgColor = isCancelled ? 'bg-red-50 border-red-200 text-red-700'
                                                            : isMoved ? 'bg-amber-50 border-amber-200 text-amber-700'
                                                            : isVismed ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                                            : 'bg-blue-50 border-blue-200 text-blue-700';

                                                        const dotColor = isCancelled ? 'bg-red-400'
                                                            : isMoved ? 'bg-amber-400'
                                                            : isVismed ? 'bg-emerald-500'
                                                            : 'bg-blue-500';

                                                        return (
                                                            <button
                                                                key={idx}
                                                                onClick={() => setSelectedBooking(b)}
                                                                className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-[11px] font-bold transition-all hover:shadow-md hover:-translate-y-0.5 ${bgColor} ${isCancelled ? 'line-through opacity-60' : ''}`}
                                                            >
                                                                <div className={`h-2 w-2 rounded-full ${dotColor}`}></div>
                                                                <span className="font-black">{formatTime(b.startAt)}</span>
                                                                <span className="max-w-[120px] truncate">{b.patientName}{b.patientSurname ? ` ${b.patientSurname}` : ''}</span>
                                                                <span className="text-[8px] font-black uppercase tracking-wider opacity-60">{isVismed ? 'VM' : 'DC'}</span>
                                                            </button>
                                                        );
                                                    })
                                                )}
                                                <button
                                                    onClick={() => handleOpenBooking(day)}
                                                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl border border-dashed border-slate-200 text-[10px] font-bold text-slate-400 hover:border-primary hover:text-primary hover:bg-primary/5 transition-all"
                                                >
                                                    + Agendar
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {isFetching && (
                        <div className="flex items-center justify-center gap-2 py-2">
                            <Loader2 className="h-4 w-4 animate-spin text-primary" />
                            <span className="text-[11px] text-slate-400 font-bold">Carregando agendamentos...</span>
                        </div>
                    )}
                </main>
            </div>

            {selectedBooking && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-6" onClick={() => setSelectedBooking(null)}>
                    <div className="bg-white rounded-3xl shadow-2xl p-8 w-full max-w-lg relative animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => setSelectedBooking(null)} className="absolute top-4 right-4 h-8 w-8 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-all">
                            <X className="h-4 w-4 text-slate-500" />
                        </button>

                        <div className="flex items-center gap-4 mb-6">
                            <div className={`h-14 w-14 rounded-2xl flex items-center justify-center ${
                                selectedBooking.origin === 'VISMED' ? 'bg-emerald-100 text-emerald-600' : 'bg-blue-100 text-blue-600'
                            }`}>
                                {selectedBooking.origin === 'VISMED' ? <Building2 className="h-7 w-7" /> : <Globe className="h-7 w-7" />}
                            </div>
                            <div>
                                <h2 className="text-xl font-black text-slate-900">Detalhes do Agendamento</h2>
                                <div className="flex items-center gap-2 mt-1">
                                    <span className={`px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider ${
                                        selectedBooking.origin === 'VISMED' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
                                    }`}>
                                        {selectedBooking.origin === 'VISMED' ? 'VisMed' : 'Doctoralia'}
                                    </span>
                                    <span className={`px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider ${
                                        selectedBooking.status === 'CANCELLED' ? 'bg-red-100 text-red-700' :
                                        selectedBooking.status === 'MOVED' ? 'bg-amber-100 text-amber-700' :
                                        'bg-slate-100 text-slate-600'
                                    }`}>
                                        {selectedBooking.status}
                                    </span>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-4 bg-slate-50 rounded-2xl p-5">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <div className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-1">Paciente</div>
                                    <div className="text-[14px] font-bold text-slate-800 flex items-center gap-2">
                                        <User className="h-4 w-4 text-slate-400" />
                                        {selectedBooking.patientName} {selectedBooking.patientSurname || ''}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-1">Horário</div>
                                    <div className="text-[14px] font-bold text-slate-800 flex items-center gap-2">
                                        <Clock className="h-4 w-4 text-slate-400" />
                                        {formatTime(selectedBooking.startAt)} - {formatTime(selectedBooking.endAt)}
                                    </div>
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <div className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-1">Data</div>
                                    <div className="text-[14px] font-bold text-slate-800 flex items-center gap-2">
                                        <CalendarDays className="h-4 w-4 text-slate-400" />
                                        {formatDate(selectedBooking.startAt)}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-1">Duração</div>
                                    <div className="text-[14px] font-bold text-slate-800">{selectedBooking.duration || 30} min</div>
                                </div>
                            </div>
                            {selectedBooking.patientPhone && (
                                <div>
                                    <div className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-1">Telefone</div>
                                    <div className="text-[13px] font-bold text-slate-700 flex items-center gap-2">
                                        <Phone className="h-3.5 w-3.5 text-slate-400" />
                                        {selectedBooking.patientPhone}
                                    </div>
                                </div>
                            )}
                            {selectedBooking.patientEmail && (
                                <div>
                                    <div className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-1">Email</div>
                                    <div className="text-[13px] font-bold text-slate-700 flex items-center gap-2">
                                        <Mail className="h-3.5 w-3.5 text-slate-400" />
                                        {selectedBooking.patientEmail}
                                    </div>
                                </div>
                            )}
                            {selectedBooking.serviceName && (
                                <div>
                                    <div className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-1">Serviço</div>
                                    <div className="text-[13px] font-bold text-slate-700 flex items-center gap-2">
                                        <FileText className="h-3.5 w-3.5 text-slate-400" />
                                        {selectedBooking.serviceName}
                                    </div>
                                </div>
                            )}
                        </div>

                        {selectedBooking.status !== 'CANCELLED' && selectedBooking.doctoraliaBookingId && (
                            <div className="mt-6 flex gap-3">
                                <button
                                    onClick={() => handleCancelBooking(selectedBooking)}
                                    className="flex-1 py-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-[11px] font-black uppercase tracking-wider hover:bg-red-100 transition-all flex items-center justify-center gap-2"
                                >
                                    <Ban className="h-4 w-4" /> Cancelar Agendamento
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {isBookingModalOpen && bookingSlot && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-6" onClick={() => setIsBookingModalOpen(false)}>
                    <div className="bg-white rounded-3xl shadow-2xl p-8 w-full max-w-lg relative animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => setIsBookingModalOpen(false)} className="absolute top-4 right-4 h-8 w-8 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-all">
                            <X className="h-4 w-4 text-slate-500" />
                        </button>

                        <div className="flex items-center gap-4 mb-6">
                            <div className="h-14 w-14 rounded-2xl bg-emerald-100 text-emerald-600 flex items-center justify-center">
                                <CalendarDays className="h-7 w-7" />
                            </div>
                            <div>
                                <h2 className="text-xl font-black text-slate-900">Novo Agendamento</h2>
                                <p className="text-[12px] font-bold text-slate-400">
                                    {new Date(bookingSlot.date + 'T00:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })}
                                </p>
                            </div>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-400 mb-1.5 block">Horário</label>
                                <input
                                    type="time"
                                    value={bookingSlot.time}
                                    onChange={(e) => setBookingSlot({ ...bookingSlot, time: e.target.value })}
                                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-400 mb-1.5 block">Nome</label>
                                    <input
                                        type="text"
                                        value={patientForm.name}
                                        onChange={(e) => setPatientForm({ ...patientForm, name: e.target.value })}
                                        placeholder="Nome do paciente"
                                        className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-400 mb-1.5 block">Sobrenome</label>
                                    <input
                                        type="text"
                                        value={patientForm.surname}
                                        onChange={(e) => setPatientForm({ ...patientForm, surname: e.target.value })}
                                        placeholder="Sobrenome"
                                        className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                                    />
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-400 mb-1.5 block">Telefone</label>
                                    <input
                                        type="tel"
                                        value={patientForm.phone}
                                        onChange={(e) => setPatientForm({ ...patientForm, phone: e.target.value })}
                                        placeholder="(11) 99999-9999"
                                        className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-400 mb-1.5 block">CPF</label>
                                    <input
                                        type="text"
                                        value={patientForm.cpf}
                                        onChange={(e) => setPatientForm({ ...patientForm, cpf: e.target.value })}
                                        placeholder="000.000.000-00"
                                        className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-400 mb-1.5 block">Email</label>
                                <input
                                    type="email"
                                    value={patientForm.email}
                                    onChange={(e) => setPatientForm({ ...patientForm, email: e.target.value })}
                                    placeholder="paciente@email.com"
                                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                                />
                            </div>

                            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 flex items-center gap-3">
                                <ArrowRightLeft className="h-4 w-4 text-emerald-600 shrink-0" />
                                <p className="text-[10px] font-bold text-emerald-700">
                                    Este agendamento será criado simultaneamente no VisMed e na Doctoralia, bloqueando o horário em ambas as plataformas.
                                </p>
                            </div>

                            <button
                                onClick={handleCreateBooking}
                                disabled={isSaving || !patientForm.name.trim()}
                                className="w-full py-3.5 bg-primary hover:bg-primary/90 text-white rounded-xl text-[12px] font-black uppercase tracking-wider shadow-lg shadow-primary/30 transition-all disabled:opacity-40 flex items-center justify-center gap-2"
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
