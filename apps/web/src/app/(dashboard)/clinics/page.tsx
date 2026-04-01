'use client';
import { useState, useEffect } from 'react';
import { Settings, Plus, Globe, Building2, KeyRound, CheckCircle2, Loader2, Activity, ArrowRight, ShieldCheck, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';

interface Clinic {
    id: string;
    name: string;
    cnpj: string | null;
    timezone: string;
    status: string;
    active: boolean;
    integrations?: any[];
}

export default function ClinicsManagement() {
    const [activeTab, setActiveTab] = useState('Visão Geral');
    const [clinics, setClinics] = useState<Clinic[]>([]);
    const [selectedClinic, setSelectedClinic] = useState<Clinic | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [testingId, setTestingId] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
    const [refreshTrigger, setRefreshTrigger] = useState(0);
    const [notification, setNotification] = useState<{ show: boolean; title: string; message: string; type: 'success' | 'error' } | null>(null);

    useEffect(() => {
        const fetchClinics = async () => {
            try {
                const response = await api.get('/clinics');
                const data = response.data;
                const formattedData = data.map((c: any) => ({
                    ...c,
                    status: c.active ? 'Ativa' : 'Inativa',
                    docplanner: c.integrations?.some((i: any) => i.provider === 'doctoralia'),
                    vismed: c.integrations?.some((i: any) => i.provider === 'vismed')
                }));

                setClinics(formattedData);
                if (formattedData.length > 0 && !selectedClinic) {
                    setSelectedClinic(formattedData[0]);
                } else if (selectedClinic) {
                    const updated = formattedData.find((c: any) => c.id === selectedClinic.id);
                    if (updated) setSelectedClinic(updated);
                }
            } catch (error) {
                console.error("Error fetching clinics:", error);
            } finally {
                setIsLoading(false);
            }
        };

        fetchClinics();
    }, [refreshTrigger, selectedClinic?.id]);

    const handleTestIntegration = async (clinicId: string) => {
        setTestingId(clinicId);
        setTestResult(null);
        try {
            const res = await api.post(`/clinics/${clinicId}/test-integration`);
            setTestResult(res.data);
            setRefreshTrigger(prev => prev + 1);
        } catch (e: any) {
            setTestResult({ success: false, message: e.response?.data?.message || e.message });
        } finally {
            setTestingId(null);
        }
    };

    const handleTestVismedIntegration = async (clinicId: string) => {
        setTestingId(`vismed-${clinicId}`);
        setTestResult(null);
        try {
            const res = await api.post(`/clinics/${clinicId}/test-vismed`);
            setTestResult(res.data);
            setRefreshTrigger(prev => prev + 1);
        } catch (e: any) {
            setTestResult({ success: false, message: e.response?.data?.message || e.message });
        } finally {
            setTestingId(null);
        }
    };

    const handleCreateNew = () => {
        setActiveTab('Visão Geral');
        setSelectedClinic({
            id: 'new',
            name: '',
            cnpj: '',
            timezone: 'America/Sao_Paulo',
            status: 'Nova',
            active: true,
            integrations: []
        });
    };

    const handleSaveClinic = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!selectedClinic) return;
        setIsLoading(true);
        const formData = new FormData(e.currentTarget);
        const rawData: any = Object.fromEntries(formData.entries());

        const clinicData: any = {};
        const integrations: any[] = [];

        Object.keys(rawData).forEach(key => {
            if (key.startsWith('vismed_')) {
                const field = key.replace('vismed_', '');
                let integration = integrations.find(i => i.provider === 'vismed');
                if (!integration) {
                    integration = { provider: 'vismed' };
                    integrations.push(integration);
                }
                // Map frontend field "domain" back to "domain" if it was vismed_domain
                integration[field] = rawData[key];
            } else if (key.startsWith('doctoralia_')) {
                const field = key.replace('doctoralia_', '');
                let integration = integrations.find(i => i.provider === 'doctoralia');
                if (!integration) {
                    integration = { provider: 'doctoralia' };
                    integrations.push(integration);
                }
                integration[field] = rawData[key];
            } else {
                clinicData[key] = rawData[key];
            }
        });

        try {
            let clinicId = selectedClinic.id;

            // First save basic clinic data
            if (selectedClinic.id === 'new') {
                const res = await api.post('/clinics', clinicData);
                clinicId = res.data.id;
            } else {
                await api.put(`/clinics/${clinicId}`, clinicData);
            }

            // Then save integrations sequentially
            for (const integration of integrations) {
                // For VisMed, if domain is provided but clientId is not explicit, we might need a better check
                // but usually both are provided.
                if (integration.clientId || integration.domain) {
                    await api.put(`/clinics/${clinicId}`, { integrationArgs: integration });
                }
            }

            setRefreshTrigger(prev => prev + 1);
            setNotification({
                show: true,
                title: selectedClinic.id === 'new' ? 'Clínica Criada' : 'Arquitetura Persistida',
                message: selectedClinic.id === 'new' ? 'A nova unidade foi integrada ao cluster com sucesso.' : 'As configurações de governança e sincronismo foram atualizadas com sucesso no ecossistema.',
                type: 'success'
            });

            if (selectedClinic.id === 'new') {
                setSelectedClinic(null); // Fetch process will auto-select the first one or updated list
            }
        } catch (err) {
            console.error(err);
            setNotification({
                show: true,
                title: 'Falha na Persistência',
                message: 'Ocorreu uma anomalia ao tentar salvar os dados. Verifique a conexão com o cluster.',
                type: 'error'
            });
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="max-w-7xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Header Moderno */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div className="flex items-center gap-5">
                    <div className="h-16 w-16 rounded-[24px] bg-gradient-to-br from-primary to-emerald-600 flex items-center justify-center shadow-[0_12px_24px_-8px_rgba(31,181,122,0.4)] border border-white/20 transform rotate-1 transition-transform hover:rotate-0 duration-500">
                        <Building2 className="h-8 w-8 text-white" />
                    </div>
                    <div>
                        <div className="flex items-center gap-3 mb-1">
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-emerald-50 text-emerald-700 border border-emerald-100 shadow-sm">
                                <ShieldCheck className="h-3 w-3" /> Governança de Master Data
                            </span>
                        </div>
                        <h1 className="text-4xl font-black text-slate-900 tracking-tighter uppercase leading-none">CLÍNICAS</h1>
                        <p className="text-sm text-slate-500 font-bold uppercase tracking-wide mt-1">Gerenciamento completo do cluster de unidades e hubs VisMed.</p>
                    </div>
                </div>
                <button onClick={handleCreateNew} className="flex items-center gap-2 bg-slate-900 hover:bg-black text-white px-7 py-3.5 rounded-2xl text-[10px] font-black uppercase tracking-[2px] shadow-xl transition-all hover:-translate-y-1 active:scale-95 group">
                    <Plus className="h-4 w-4 transition-transform group-hover:rotate-90" />
                    Criar Clínica
                </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                {/* Sidebar Selection Glass */}
                <div className="lg:col-span-4 bg-white/70 backdrop-blur-xl rounded-[32px] shadow-sm border border-slate-100/60 flex flex-col h-[650px] overflow-hidden">
                    <div className="p-6 border-b border-slate-100/60 bg-white/40">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[3px]">Unidades Geográficas</h3>
                    </div>
                    <div className="overflow-y-auto flex-1 p-4 space-y-3 custom-scrollbar">
                        {isLoading && clinics.length === 0 ? (
                            <div className="flex flex-col items-center justify-center p-16 gap-4">
                                <Loader2 className="h-10 w-10 animate-spin text-primary/40" />
                                <span className="text-[10px] font-black text-slate-300 uppercase tracking-[4px]">Localizando...</span>
                            </div>
                        ) : clinics.length === 0 ? (
                            <div className="text-center p-12 opacity-30">
                                <Building2 className="h-16 w-16 text-slate-200 mx-auto mb-6" />
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] leading-tight">Master data vazio</p>
                            </div>
                        ) : (
                            clinics.map(clinic => (
                                <button
                                    key={clinic.id}
                                    type="button"
                                    onClick={() => setSelectedClinic(clinic)}
                                    className={`w-full text-left p-5 rounded-[24px] flex items-center gap-5 transition-all duration-500 group relative overflow-hidden ${selectedClinic?.id === clinic.id
                                        ? 'bg-primary text-white shadow-xl shadow-primary/20 scale-[1.02]'
                                        : 'hover:bg-emerald-50/50 text-slate-700 bg-white/40'
                                        }`}
                                >
                                    <div className={`h-12 w-12 rounded-[18px] flex items-center justify-center shrink-0 border-2 transition-all duration-500 ${selectedClinic?.id === clinic.id ? 'bg-white/20 border-white/30 text-white shadow-inner' : 'bg-white border-slate-100 text-slate-400 group-hover:border-primary/20 group-hover:text-primary group-hover:scale-110'}`}>
                                        <Building2 className="h-6 w-6" />
                                    </div>
                                    <div className="overflow-hidden relative z-10">
                                        <div className="font-black text-[15px] truncate leading-none tracking-tight">{clinic.name}</div>
                                        <div className={`text-[10px] font-black uppercase tracking-[2px] mt-2 flex items-center gap-2 ${selectedClinic?.id === clinic.id ? 'text-white/70' : 'text-slate-400'}`}>
                                            <div className={`h-1.5 w-1.5 rounded-full ${clinic.active ? 'bg-emerald-400' : 'bg-rose-400'}`}></div>
                                            {clinic.status}
                                        </div>
                                    </div>
                                </button>
                            ))
                        )}
                    </div>
                </div>

                {/* Main Workspace Glass */}
                <div className="lg:col-span-8 bg-white/70 backdrop-blur-xl rounded-[40px] shadow-sm border border-slate-100/80 overflow-hidden min-h-[650px] flex flex-col">
                    {!selectedClinic ? (
                        <div className="flex-1 flex flex-col items-center justify-center p-20 text-center opacity-40">
                            <div className="h-32 w-32 bg-slate-50 rounded-[48px] flex items-center justify-center mb-8 border border-slate-100 shadow-inner">
                                <Settings className="h-12 w-12 text-slate-200 animate-spin-slow" />
                            </div>
                            <h2 className="text-xl font-black text-slate-900 mb-2 uppercase tracking-[2px]">Configurações da Unidade</h2>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[4px] max-w-[280px]">Selecione uma clínica para ajustar integrações e master data.</p>
                        </div>
                    ) : (
                        <form onSubmit={handleSaveClinic} className="flex-1 flex flex-col overflow-hidden">
                            {/* Inner Header */}
                            <div className="p-10 pb-6 shrink-0">
                                <div className="flex flex-col sm:flex-row justify-between items-start gap-6">
                                    <div>
                                        <h2 className="text-4xl font-black text-slate-900 tracking-tighter uppercase transition-all duration-700">{selectedClinic.name || 'NOVA CLÍNICA'}</h2>
                                        <div className="flex flex-wrap items-center gap-4 mt-5">
                                            <div className="flex items-center gap-2 bg-slate-100/50 border border-slate-200/40 px-3 py-1.5 rounded-xl text-[10px] font-black text-slate-500 uppercase tracking-widest">
                                                CNPJ: <span className="text-slate-900 font-mono tracking-normal">{selectedClinic.cnpj || '---'}</span>
                                            </div>
                                            <div className="h-1 w-1 rounded-full bg-slate-200"></div>
                                            {selectedClinic.active ? (
                                                <span className="flex items-center gap-2 px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest bg-emerald-50 text-primary border border-emerald-100 shadow-sm">
                                                    <CheckCircle2 className="h-4 w-4" /> Unidade Ativa
                                                </span>
                                            ) : (
                                                <span className="flex items-center gap-2 px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest bg-rose-50 text-rose-700 border border-rose-100">
                                                    Unidade Inativa
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <div className={`h-12 w-12 rounded-2xl flex items-center justify-center border-2 transition-all duration-700 ${clinicIntegrations(selectedClinic).doctoralia ? 'bg-emerald-50 border-emerald-100 text-primary shadow-lg shadow-emerald-100/50' : 'bg-slate-50 border-slate-100 text-slate-300'}`} title="Doctoralia">
                                            <Globe className="h-6 w-6" />
                                        </div>
                                        <div className={`h-12 w-12 rounded-2xl flex items-center justify-center border-2 transition-all duration-700 ${clinicIntegrations(selectedClinic).vismed ? 'bg-primary/5 border-primary/20 text-primary shadow-lg shadow-primary/10' : 'bg-slate-50 border-slate-100 text-slate-300'}`} title="VisMed">
                                            <Activity className="h-6 w-6" />
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Alert Result Banner */}
                            {testResult && (
                                <div className="mx-10 mt-2 animate-in slide-in-from-top-4 duration-500 shrink-0">
                                    <div className={`rounded-[24px] p-6 flex items-center gap-6 border shadow-xl ${testResult.success ? 'bg-emerald-50 border-emerald-100 shadow-emerald-100/30' : 'bg-rose-50 border-rose-100 shadow-rose-100/30'}`}>
                                        <div className={`h-12 w-12 rounded-2xl flex items-center justify-center shrink-0 border ${testResult.success ? 'bg-white text-primary border-emerald-200' : 'bg-white text-rose-600 border-rose-200'}`}>
                                            {testResult.success ? <CheckCircle2 className="h-6 w-6" /> : <Loader2 className="h-6 w-6 animate-spin" />}
                                        </div>
                                        <div className="flex-1">
                                            <h4 className={`text-[11px] font-black uppercase tracking-[3px] ${testResult.success ? 'text-primary' : 'text-rose-800'}`}>
                                                {testResult.success ? 'Integridade da Rede: OK' : 'Anomalia na Validação'}
                                            </h4>
                                            <p className={`text-sm font-bold mt-1 ${testResult.success ? 'text-emerald-700/80' : 'text-rose-700/80'}`}>{testResult.message}</p>
                                        </div>
                                        <button type="button" onClick={() => setTestResult(null)} className="h-10 w-10 flex items-center justify-center rounded-full bg-white/50 text-slate-400 hover:text-slate-600 transition-colors">×</button>
                                    </div>
                                </div>
                            )}

                            {/* Tabs Navigation */}
                            <div className="flex gap-10 px-10 border-b border-slate-100 mt-8 bg-slate-50/20 shrink-0">
                                {['Visão Geral', 'Canais de Integração'].map((tab) => (
                                    <button
                                        key={tab}
                                        type="button"
                                        onClick={() => setActiveTab(tab)}
                                        className={`py-5 text-[11px] font-black uppercase tracking-[3px] transition-all relative group ${activeTab === tab ? 'text-primary' : 'text-slate-400 hover:text-slate-900'}`}
                                    >
                                        {tab}
                                        {activeTab === tab && (
                                            <span className="absolute bottom-0 left-0 w-full h-1 bg-primary rounded-t-full shadow-[0_0_12px_rgba(31,181,122,0.6)]"></span>
                                        )}
                                    </button>
                                ))}
                            </div>

                            {/* Form Content */}
                            <div className="flex-1 overflow-y-auto p-10 custom-scrollbar space-y-10 pb-32">
                                {activeTab === 'Visão Geral' && (
                                    <div className="space-y-10 max-w-3xl animate-in fade-in duration-700">
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
                                            <div className="space-y-3">
                                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] ml-1">Friendly Name da Unidade</label>
                                                <input type="text" name="name" defaultValue={selectedClinic.name} key={selectedClinic.id + '-name'} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all duration-300 placeholder:font-normal" required />
                                            </div>
                                            <div className="space-y-3">
                                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] ml-1">Cadastro Fiscal (CNPJ)</label>
                                                <input type="text" name="cnpj" placeholder="00.000.000/0000-00" defaultValue={selectedClinic.cnpj || ''} key={selectedClinic.id + '-cnpj'} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all duration-300" />
                                            </div>
                                        </div>

                                        <div className="space-y-3">
                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] ml-1">Temporalidade & Timezone</label>
                                            <select name="timezone" defaultValue={selectedClinic.timezone} key={selectedClinic.id + '-tz'} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none cursor-pointer appearance-none transition-all duration-300">
                                                <option value="America/Sao_Paulo">Brasil / Sudeste (São Paulo - UTC-3)</option>
                                                <option value="America/New_York">USA / Eastern (New York - EST)</option>
                                            </select>
                                        </div>

                                        <div className="pt-10 border-t border-slate-100/60">
                                            <div className="flex items-center gap-4 mb-8">
                                                <div className="h-10 w-10 rounded-xl bg-slate-900 flex items-center justify-center text-primary shadow-lg">
                                                    <Globe className="h-5 w-5" />
                                                </div>
                                                <h4 className="text-[13px] font-black text-slate-900 uppercase tracking-[2px]">Endereço VisMed / Sincronismo Global</h4>
                                            </div>

                                            <div className="grid grid-cols-12 gap-6 mb-6">
                                                <div className="space-y-3 col-span-12 sm:col-span-3">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] ml-1">CEP</label>
                                                    <input type="text" name="addressZipCode" defaultValue={(selectedClinic as any).addressZipCode || ''} key={selectedClinic.id + '-zip'} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary outline-none transition-all" />
                                                </div>
                                                <div className="space-y-3 col-span-12 sm:col-span-7">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] ml-1">Logradouro</label>
                                                    <input type="text" name="addressStreet" defaultValue={(selectedClinic as any).addressStreet || ''} key={selectedClinic.id + '-st'} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary outline-none transition-all" />
                                                </div>
                                                <div className="space-y-3 col-span-6 sm:col-span-2">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] ml-1">Nº</label>
                                                    <input type="text" name="addressNumber" defaultValue={(selectedClinic as any).addressNumber || ''} key={selectedClinic.id + '-num'} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary outline-none transition-all" />
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-12 gap-6">
                                                <div className="space-y-3 col-span-12 sm:col-span-4">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] ml-1">Bairro</label>
                                                    <input type="text" name="addressNeighborhood" defaultValue={(selectedClinic as any).addressNeighborhood || ''} key={selectedClinic.id + '-neigh'} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary outline-none transition-all" />
                                                </div>
                                                <div className="space-y-3 col-span-8 sm:col-span-4">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] ml-1">Cidade</label>
                                                    <input type="text" name="addressCity" defaultValue={(selectedClinic as any).addressCity || ''} key={selectedClinic.id + '-city'} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary outline-none transition-all" />
                                                </div>
                                                <div className="space-y-3 col-span-4 sm:col-span-4">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] ml-1">UF (Unidade Federativa)</label>
                                                    <input type="text" name="addressState" defaultValue={(selectedClinic as any).addressState || ''} key={selectedClinic.id + '-uf'} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-center text-[15px] font-black shadow-sm focus:border-primary outline-none transition-all" maxLength={2} placeholder="Ex: SP" />
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {activeTab === 'Canais de Integração' && (
                                    <div className="space-y-10 max-w-3xl animate-in fade-in duration-700">
                                        {/* VisMed Integration Card */}
                                        <div className="p-8 rounded-[32px] bg-gradient-to-br from-primary/5 to-white border border-primary/10 shadow-sm flex flex-col gap-8 transition-all hover:shadow-xl group">
                                            <div className="flex flex-col sm:flex-row justify-between items-center gap-8">
                                                <div className="flex gap-6">
                                                    <div className="h-16 w-16 bg-white rounded-[24px] shadow-lg flex items-center justify-center border border-slate-50 transition-transform group-hover:-rotate-3">
                                                        <Activity className="h-8 w-8 text-primary" />
                                                    </div>
                                                    <div>
                                                        <h4 className="text-xl font-black text-slate-900 tracking-tighter uppercase">Infrastrutura Central VisMed</h4>
                                                        <div className="flex items-center gap-2 mt-2">
                                                            <div className={`h-1.5 w-1.5 rounded-full ${clinicIntegrations(selectedClinic).vismed ? "bg-primary" : "bg-rose-500"}`}></div>
                                                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[2px]">Bridge: <span className={clinicIntegrations(selectedClinic).vismed ? "text-primary" : "text-rose-500"}>{clinicIntegrations(selectedClinic).vismed ? "Link Estabelecido" : "Offline"}</span></p>
                                                        </div>
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={() => handleTestVismedIntegration(selectedClinic.id)}
                                                    disabled={testingId === `vismed-${selectedClinic.id}`}
                                                    type="button"
                                                    className="w-full sm:w-auto h-14 px-8 rounded-2xl bg-white border-2 border-slate-200 text-slate-900 font-black text-[10px] uppercase tracking-[2px] hover:border-primary hover:text-primary transition-all active:scale-95 disabled:opacity-50"
                                                >
                                                    {testingId === `vismed-${selectedClinic.id}` ? 'Validando...' : 'Checar Fluxo VisMed'}
                                                </button>
                                            </div>

                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-4 border-t border-slate-100/60">
                                                <div className="space-y-2">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px]">ID Empresa Gestora</label>
                                                    <input type="text" name="vismed_clientId" key={selectedClinic.id + '-vismed-client'} defaultValue={selectedClinic.integrations?.find((i: any) => i.provider === 'vismed')?.clientId || ''} className="w-full h-12 rounded-xl border-2 border-slate-100 bg-white px-4 text-xs font-bold focus:border-primary outline-none transition-all" placeholder="Ex: 567" />
                                                </div>
                                                <div className="space-y-2">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px]">Link de Integração (URL)</label>
                                                    <input type="text" name="vismed_domain" key={selectedClinic.id + '-vismed-domain'} defaultValue={selectedClinic.integrations?.find((i: any) => i.provider === 'vismed')?.domain || ''} className="w-full h-12 rounded-xl border-2 border-slate-100 bg-white px-4 text-xs font-bold focus:border-primary outline-none transition-all" placeholder="Ex: api.vismed.com.br" />
                                                </div>
                                            </div>
                                        </div>

                                        {/* Doctoralia Integration Card */}
                                        <div className="p-8 rounded-[32px] bg-white border border-slate-200 shadow-sm flex flex-col gap-8 transition-all hover:shadow-xl group">
                                            <div className="flex flex-col sm:flex-row justify-between items-center gap-8">
                                                <div className="flex gap-6">
                                                    <div className="h-16 w-16 bg-slate-50 rounded-[24px] shadow-sm flex items-center justify-center border border-slate-100 transition-transform group-hover:rotate-3">
                                                        <Globe className="h-8 w-8 text-primary" />
                                                    </div>
                                                    <div>
                                                        <h4 className="text-xl font-black text-slate-900 tracking-tighter uppercase">Doctoralia Ecosystem</h4>
                                                        <div className="flex items-center gap-2 mt-2">
                                                            <div className={`h-1.5 w-1.5 rounded-full ${clinicIntegrations(selectedClinic).doctoralia ? "bg-primary" : "bg-slate-300"}`}></div>
                                                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[2px]">Status: <span className={clinicIntegrations(selectedClinic).doctoralia ? "text-primary" : "text-slate-500"}>{clinicIntegrations(selectedClinic).doctoralia ? "Integrado" : "Não Configurado"}</span></p>
                                                        </div>
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={() => handleTestIntegration(selectedClinic.id)}
                                                    disabled={testingId === selectedClinic.id}
                                                    type="button"
                                                    className="w-full sm:w-auto h-14 px-8 rounded-2xl bg-white border-2 border-slate-200 text-slate-900 font-black text-[10px] uppercase tracking-[2px] hover:border-primary hover:text-primary transition-all active:scale-95 disabled:opacity-50"
                                                >
                                                    {testingId === selectedClinic.id ? 'Testando...' : 'Testar Conexão Doctoralia'}
                                                </button>
                                            </div>

                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 pt-4 border-t border-slate-100">
                                                <div className="space-y-2">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px]">Client ID</label>
                                                    <input type="text" name="doctoralia_clientId" key={selectedClinic.id + '-doc-client'} defaultValue={selectedClinic.integrations?.find((i: any) => i.provider === 'doctoralia')?.clientId || ''} className="w-full h-12 rounded-xl border-2 border-slate-100 bg-white px-4 text-xs font-bold focus:border-primary outline-none transition-all" />
                                                </div>
                                                <div className="space-y-2">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px]">Client Secret</label>
                                                    <input type="password" name="doctoralia_clientSecret" key={selectedClinic.id + '-doc-secret'} defaultValue={selectedClinic.integrations?.find((i: any) => i.provider === 'doctoralia')?.clientSecret || ''} className="w-full h-12 rounded-xl border-2 border-slate-100 bg-white px-4 text-xs font-bold focus:border-primary outline-none transition-all" />
                                                </div>
                                                <div className="space-y-2">
                                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px]">Domínio</label>
                                                    <input type="text" name="doctoralia_domain" key={selectedClinic.id + '-doc-domain'} defaultValue={selectedClinic.integrations?.find((i: any) => i.provider === 'doctoralia')?.domain || 'doctoralia.com.br'} className="w-full h-12 rounded-xl border-2 border-slate-100 bg-white px-4 text-xs font-bold focus:border-primary outline-none transition-all" />
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Global Action Bar */}
                            <div className="p-10 pt-4 border-t border-slate-100 bg-white/40 backdrop-blur-md flex justify-end shrink-0 z-20">
                                <button type="submit" disabled={isLoading} className="bg-primary hover:bg-emerald-600 text-white px-10 h-16 rounded-[24px] text-[11px] font-black shadow-2xl shadow-primary/30 transition-all hover:-translate-y-1 active:scale-95 disabled:opacity-50 flex items-center gap-3 uppercase tracking-[2px]">
                                    {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
                                    Persistir Arquitetura de Dados
                                </button>
                            </div>
                        </form>
                    )}
                </div>

                <div className="pt-10 border-t border-slate-100/40 text-center col-span-12">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-[5px] opacity-30 hover:opacity-100 transition-opacity">Clinic Governance Shield • VisMed v2.4.0 • Enterprise Edition</p>
                </div>
            </div>

            {/* Global Notification Modal */}
            {notification?.show && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300">
                    <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={() => setNotification(null)}></div>
                    <div className="relative bg-white rounded-[40px] shadow-2xl border border-white/20 p-10 max-w-lg w-full transform animate-in zoom-in-95 duration-300">
                        <div className="flex flex-col items-center text-center">
                            <div className={`h-24 w-24 rounded-[32px] flex items-center justify-center mb-8 shadow-2xl ${notification.type === 'success' ? 'bg-primary text-white shadow-primary/40' : 'bg-rose-500 text-white shadow-rose-500/40'}`}>
                                {notification.type === 'success' ? <CheckCircle2 className="h-12 w-12" /> : <AlertCircle className="h-12 w-12" />}
                            </div>
                            <h3 className="text-2xl font-black text-slate-900 uppercase tracking-tighter mb-4">{notification.title}</h3>
                            <p className="text-slate-500 font-bold leading-relaxed mb-10 px-4">{notification.message}</p>
                            <button
                                onClick={() => setNotification(null)}
                                className={`w-full py-5 rounded-[24px] font-black text-[11px] uppercase tracking-[3px] transition-all hover:-translate-y-1 active:scale-95 shadow-xl ${notification.type === 'success'
                                    ? 'bg-slate-900 text-white hover:bg-black shadow-slate-200'
                                    : 'bg-rose-500 text-white hover:bg-rose-600 shadow-rose-100'
                                    }`}
                            >
                                Compreendido
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// Helpers for integration status
function clinicIntegrations(clinic: any) {
    return {
        doctoralia: clinic?.integrations?.some((i: any) => i.provider === 'doctoralia'),
        vismed: clinic?.integrations?.some((i: any) => i.provider === 'vismed')
    };
}
