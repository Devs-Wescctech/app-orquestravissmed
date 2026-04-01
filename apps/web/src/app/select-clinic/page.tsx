'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldPlus, Building2, Search, Loader2, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { useClinicStore } from '@/lib/clinic-store';

export default function SelectClinicPage() {
    const router = useRouter();
    const user = useAuthStore((s) => s.user);
    const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
    const { setActiveClinic, setClinics } = useClinicStore();
    const [clinicsList, setClinicsList] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [search, setSearch] = useState('');

    useEffect(() => {
        if (!isAuthenticated) {
            router.push('/login');
            return;
        }
        fetchClinics();
    }, [isAuthenticated]);

    const fetchClinics = async () => {
        try {
            const res = await api.get('/clinics/my');
            const list = res.data || [];
            setClinicsList(list);
            setClinics(list.map((c: any) => ({ id: c.id, name: c.name, cnpj: c.cnpj, active: c.active })));

            // Auto-select if only 1 clinic
            if (list.length === 1) {
                handleSelect(list[0]);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSelect = (clinic: any) => {
        setActiveClinic({ id: clinic.id, name: clinic.name, cnpj: clinic.cnpj, active: clinic.active });
        router.push('/');
    };

    const filtered = clinicsList.filter((c) =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        (c.cnpj || '').includes(search)
    );

    if (isLoading) {
        return (
            <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center">
                <Loader2 className="h-10 w-10 animate-spin text-primary mb-4" />
                <p className="text-slate-600">Carregando clínicas...</p>
            </div>
        );
    }

    // If auto-selecting single clinic, show loading
    if (clinicsList.length === 1) {
        return (
            <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center">
                <Loader2 className="h-10 w-10 animate-spin text-primary mb-4" />
                <p className="text-slate-600">Redirecionando...</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center py-12 px-4">
            <div className="w-full max-w-2xl">
                <div className="flex flex-col items-center mb-8">
                    <div className="h-14 w-14 bg-primary rounded-xl flex items-center justify-center shadow-md mb-4">
                        <ShieldPlus className="h-8 w-8 text-white" />
                    </div>
                    <h1 className="text-2xl font-bold text-slate-900">Selecionar Clínica</h1>
                    <p className="text-sm text-slate-500 mt-1">
                        Olá, <span className="font-medium">{user?.name}</span>! Escolha a clínica que deseja operar.
                    </p>
                </div>

                {clinicsList.length > 3 && (
                    <div className="relative mb-4">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                        <input
                            type="text"
                            placeholder="Buscar por nome ou CNPJ..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                        />
                    </div>
                )}

                <div className="space-y-3">
                    {filtered.length === 0 ? (
                        <div className="text-center py-12 text-slate-400">
                            Nenhuma clínica encontrada.
                        </div>
                    ) : (
                        filtered.map((clinic) => {
                            const integrations = clinic.integrations || [];
                            const hasDocto = integrations.some((i: any) => i.provider === 'doctoralia' && i.status === 'connected');
                            return (
                                <button
                                    key={clinic.id}
                                    onClick={() => handleSelect(clinic)}
                                    className="w-full bg-white border border-slate-200 rounded-xl p-5 flex items-center justify-between hover:border-primary/50 hover:shadow-md transition-all group text-left"
                                >
                                    <div className="flex items-center gap-4">
                                        <div className="h-11 w-11 bg-primary/10 rounded-lg flex items-center justify-center text-primary shrink-0">
                                            <Building2 className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <h3 className="font-semibold text-slate-900 group-hover:text-primary transition-colors">
                                                {clinic.name}
                                            </h3>
                                            <div className="flex items-center gap-3 mt-1">
                                                {clinic.cnpj && (
                                                    <span className="text-xs text-slate-400">{clinic.cnpj}</span>
                                                )}
                                                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${clinic.active ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                                                    {clinic.active ? 'Ativa' : 'Inativa'}
                                                </span>
                                                {hasDocto && (
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-blue-50 text-blue-600">
                                                        Doctoralia
                                                    </span>
                                                )}
                                                {clinic.userRole && (
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-slate-100 text-slate-500">
                                                        {clinic.userRole}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                    <ChevronRight className="h-5 w-5 text-slate-300 group-hover:text-primary transition-colors" />
                                </button>
                            );
                        })
                    )}
                </div>

                <p className="text-center text-xs text-slate-400 mt-6">
                    Você pode trocar de clínica a qualquer momento pelo seletor no topo do painel.
                </p>
            </div>
        </div>
    );
}
