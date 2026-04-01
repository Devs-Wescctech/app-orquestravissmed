'use client';
import { useState, useEffect } from 'react';
import { Building2, Plus, Pencil, Trash2, Plug, Loader2, Search, Check, X, TestTube2, ExternalLink, Mail, Phone, MapPin, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/store';

export default function AdminClinicsPage() {
    const { user } = useAuthStore();
    const [clinics, setClinics] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [editingClinic, setEditingClinic] = useState<any>(null);
    const [testingId, setTestingId] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<any>(null);
    const [search, setSearch] = useState('');

    // Form state
    const [formName, setFormName] = useState('');
    const [formCnpj, setFormCnpj] = useState('');
    const [formActive, setFormActive] = useState(true);
    const [formVismedNotes, setFormVismedNotes] = useState('');
    const [formVismedActive, setFormVismedActive] = useState(false);
    const [formEmail, setFormEmail] = useState('');
    const [formPhone, setFormPhone] = useState('');
    // Address fields
    const [formAddrStreet, setFormAddrStreet] = useState('');
    const [formAddrNumber, setFormAddrNumber] = useState('');
    const [formAddrComplement, setFormAddrComplement] = useState('');
    const [formAddrNeighborhood, setFormAddrNeighborhood] = useState('');
    const [formAddrCity, setFormAddrCity] = useState('');
    const [formAddrState, setFormAddrState] = useState('');
    const [formAddrZipCode, setFormAddrZipCode] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const fetchClinics = async () => {
        setIsLoading(true);
        try {
            const res = await api.get('/clinics');
            setClinics(res.data || []);
        } catch (e) { console.error(e); }
        finally { setIsLoading(false); }
    };

    useEffect(() => { if (user) fetchClinics(); }, [user]);

    const openCreate = () => {
        setEditingClinic(null);
        setFormName(''); setFormCnpj(''); setFormActive(true);
        setFormVismedNotes(''); setFormVismedActive(false);
        setFormEmail(''); setFormPhone('');
        setFormAddrStreet(''); setFormAddrNumber(''); setFormAddrComplement(''); setFormAddrNeighborhood('');
        setFormAddrCity(''); setFormAddrState(''); setFormAddrZipCode('');
        setTestResult(null);
        setShowModal(true);
    };

    const openEdit = (clinic: any) => {
        setEditingClinic(clinic);
        setFormName(clinic.name);
        setFormCnpj(clinic.cnpj || '');
        setFormEmail(clinic.email || '');
        setFormPhone(clinic.phone || '');
        setFormAddrStreet(clinic.addressStreet || '');
        setFormAddrNumber(clinic.addressNumber || '');
        setFormAddrComplement(clinic.addressComplement || '');
        setFormAddrNeighborhood(clinic.addressNeighborhood || '');
        setFormAddrCity(clinic.addressCity || '');
        setFormAddrState(clinic.addressState || '');
        setFormAddrZipCode(clinic.addressZipCode || '');
        setFormActive(clinic.active);
        const vismed = (clinic.integrations || []).find((i: any) => i.provider === 'vismed');
        setFormVismedNotes(vismed?.clientId || ''); // storing idEmpresaGestora in clientId
        setFormVismedActive(vismed?.status === 'connected');
        setTestResult(null);
        setShowModal(true);
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const payload: any = {
                name: formName,
                cnpj: formCnpj || null,
                email: formEmail || null,
                phone: formPhone || null,
                addressStreet: formAddrStreet || null,
                addressNumber: formAddrNumber || null,
                addressComplement: formAddrComplement || null,
                addressNeighborhood: formAddrNeighborhood || null,
                addressCity: formAddrCity || null,
                addressState: formAddrState || null,
                addressZipCode: formAddrZipCode || null,
                active: formActive,
            };

            if (editingClinic) {
                await api.put(`/clinics/${editingClinic.id}`, payload);
                // Save VisMed integration
                if (formVismedNotes || formVismedActive) {
                    await api.put(`/clinics/${editingClinic.id}`, {
                        integrationArgs: {
                            provider: 'vismed',
                            clientId: formVismedNotes, // storing idEmpresaGestora here
                            status: formVismedActive ? 'connected' : 'disconnected',
                        },
                    });
                }
            } else {
                await api.post('/clinics', payload);
            }
            setShowModal(false);
            fetchClinics();
        } catch (e) { console.error(e); }
        finally { setIsSaving(false); }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Tem certeza que deseja excluir esta clínica?')) return;
        try {
            await api.delete(`/clinics/${id}`);
            fetchClinics();
        } catch (e) { console.error(e); }
    };

    const handleTestVismedIntegration = async (clinicId: string) => {
        setTestingId(`vismed-${clinicId}`);
        setTestResult(null);
        try {
            const res = await api.post(`/clinics/${clinicId}/test-vismed`);
            setTestResult(res.data);
        } catch (e: any) {
            setTestResult({ success: false, message: e.response?.data?.message || e.message });
        } finally {
            setTestingId(null);
            fetchClinics();
        }
    };

    const filtered = clinics.filter(c =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        (c.cnpj || '').includes(search)
    );

    return (
        <div className="max-w-7xl mx-auto space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="flex justify-between items-end px-4">
                <div className="space-y-2">
                    <div className="flex items-center gap-2 bg-emerald-50 text-primary px-3 py-1 rounded-full w-fit border border-emerald-100 shadow-sm animate-pulse">
                        <Building2 className="h-4 w-4" />
                        <span className="text-[10px] font-black uppercase tracking-[2px]">Governança de Master Data</span>
                    </div>
                    <h1 className="text-5xl font-black tracking-tighter text-slate-900 uppercase">Clínicas</h1>
                    <p className="text-slate-400 font-bold uppercase text-[10px] tracking-[4px]">
                        Gerenciamento completo do cluster de unidades e hubs VisMed.
                    </p>
                </div>
                <button
                    onClick={openCreate}
                    className="flex items-center gap-3 bg-slate-900 hover:bg-black text-white px-8 py-4 rounded-[24px] text-[11px] font-black uppercase tracking-[2px] shadow-2xl transition-all hover:-translate-y-1 active:scale-95 group"
                >
                    <Plus className="h-5 w-5 transition-transform group-hover:rotate-90" />
                    Expandir Cluster
                </button>
            </div>

            {/* Search Glassmorphism */}
            <div className="relative px-4">
                <Search className="absolute left-10 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-300 pointer-events-none" />
                <input
                    type="text"
                    placeholder="Filtrar por nome corporativo ou registro fiscal..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full h-16 pl-14 pr-6 bg-white/70 backdrop-blur-xl rounded-[28px] border-2 border-slate-100/60 text-[14px] font-black tracking-tight focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/5 transition-all shadow-sm placeholder:font-normal placeholder:text-slate-300"
                />
            </div>

            {/* Tabela Administrativa Glassmorphism */}
            <div className="bg-white/70 backdrop-blur-xl rounded-[40px] shadow-sm border border-slate-100/80 overflow-hidden mx-4">
                <table className="w-full text-sm text-left border-separate border-spacing-0">
                    <thead className="bg-slate-50/50 text-[10px] text-slate-400 uppercase font-black tracking-[3px] border-b border-slate-100">
                        <tr>
                            <th className="px-10 py-6 font-black">Cluster Clínico</th>
                            <th className="px-10 py-6 font-black">Cadastro Fiscal</th>
                            <th className="px-10 py-6 text-center font-black">Status Operacional</th>
                            <th className="px-10 py-6 text-center font-black">Ecossistema VisMed</th>
                            <th className="px-10 py-6 text-right font-black">Ações</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50/80">
                        {isLoading ? (
                            <tr>
                                <td colSpan={5} className="px-10 py-24 text-center">
                                    <div className="flex flex-col items-center gap-4">
                                        <Loader2 className="h-12 w-12 animate-spin text-primary" />
                                        <p className="text-[10px] font-black text-slate-300 uppercase tracking-[4px]">Localizando Master Data...</p>
                                    </div>
                                </td>
                            </tr>
                        ) : filtered.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-10 py-24 text-center text-slate-400 font-bold uppercase text-[10px] tracking-widest">
                                    Nenhuma unidade cadastrada no cluster.
                                </td>
                            </tr>
                        ) : (
                            filtered.map((clinic) => {
                                const vismed = (clinic.integrations || []).find((i: any) => i.provider === 'vismed');
                                return (
                                    <tr key={clinic.id} className="group hover:bg-emerald-50/30 transition-all duration-300">
                                        <td className="px-10 py-6">
                                            <div className="flex items-center gap-4">
                                                <div className="h-12 w-12 rounded-2xl bg-white shadow-sm border border-slate-100 flex items-center justify-center text-primary group-hover:scale-110 group-hover:rotate-3 transition-all duration-500">
                                                    <Building2 className="h-6 w-6" />
                                                </div>
                                                <div className="flex flex-col">
                                                    <span className="font-black text-slate-900 tracking-tight text-[15px]">{clinic.name}</span>
                                                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">ID: {clinic.id.split('-')[0]}</span>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-10 py-6">
                                            <span className="text-[13px] font-mono text-slate-600 font-bold">{clinic.cnpj || '---'}</span>
                                        </td>
                                        <td className="px-10 py-6 text-center">
                                            <div className="flex justify-center">
                                                <span className={`inline-flex items-center px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest ${clinic.active ? 'bg-emerald-50 text-primary border border-emerald-100' : 'bg-slate-100 text-slate-400'}`}>
                                                    <div className={`h-1.5 w-1.5 rounded-full mr-2 ${clinic.active ? 'bg-primary animate-pulse' : 'bg-slate-300'}`}></div>
                                                    {clinic.active ? 'Ativa' : 'Desativada'}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-10 py-6 text-center">
                                            <div className="flex items-center justify-center gap-3">
                                                {vismed ? (
                                                    <span className={`inline-flex items-center px-3 py-1 rounded-xl text-[10px] font-black uppercase tracking-widest ${vismed.status === 'connected' ? 'bg-primary/10 text-primary border border-primary/20' : 'bg-orange-50 text-orange-600 border border-orange-100'}`}>
                                                        {vismed.status === 'connected' ? 'Conexão OK' : 'Offline'}
                                                    </span>
                                                ) : (
                                                    <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest">Não Integrada</span>
                                                )}
                                                <button
                                                    onClick={() => handleTestVismedIntegration(clinic.id)}
                                                    disabled={testingId === `vismed-${clinic.id}`}
                                                    className="p-2 bg-white rounded-xl border border-slate-100 text-slate-400 hover:text-primary hover:border-primary/30 hover:shadow-lg transition-all active:scale-90"
                                                    title="Validar Bridge VisMed"
                                                >
                                                    {testingId === `vismed-${clinic.id}` ? (
                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                    ) : (
                                                        <TestTube2 className="h-4 w-4" />
                                                    )}
                                                </button>
                                            </div>
                                        </td>
                                        <td className="px-10 py-6 text-right">
                                            <div className="flex items-center justify-end gap-3 opacity-0 group-hover:opacity-100 transition-all duration-300 -translate-x-2 group-hover:translate-x-0">
                                                <button onClick={() => openEdit(clinic)} className="h-10 w-10 flex items-center justify-center bg-white rounded-xl border border-slate-100 text-slate-400 hover:text-primary hover:border-primary/30 hover:shadow-lg transition-all" title="Editar Configurações">
                                                    <Pencil className="h-4 w-4" />
                                                </button>
                                                <button onClick={() => handleDelete(clinic.id)} className="h-10 w-10 flex items-center justify-center bg-white rounded-xl border border-slate-100 text-slate-400 hover:text-rose-500 hover:border-rose-100 hover:shadow-lg transition-all" title="Remover Unidade">
                                                    <Trash2 className="h-4 w-4" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>

            {/* Test Result Banner */}
            {testResult && (
                <div className="px-4">
                    <div className={`rounded-[24px] p-6 flex items-center gap-6 border shadow-xl ${testResult.success ? 'bg-emerald-50 border-emerald-100 shadow-emerald-100/30' : 'bg-rose-50 border-rose-100 shadow-rose-100/30'}`}>
                        <div className={`h-12 w-12 rounded-2xl flex items-center justify-center shrink-0 border ${testResult.success ? 'bg-white text-primary border-emerald-200' : 'bg-white text-rose-600 border-rose-200'}`}>
                            {testResult.success ? <Check className="h-6 w-6" /> : <X className="h-6 w-6" />}
                        </div>
                        <div className="flex-1">
                            <h4 className={`text-[11px] font-black uppercase tracking-[3px] ${testResult.success ? 'text-primary' : 'text-rose-800'}`}>
                                {testResult.success ? 'Integridade da Rede: OK' : 'Anomalia na Validação'}
                            </h4>
                            <p className={`text-sm font-bold mt-1 ${testResult.success ? 'text-emerald-700/80' : 'text-rose-700/80'}`}>{testResult.message}</p>
                        </div>
                        <button onClick={() => setTestResult(null)} className="h-10 w-10 flex items-center justify-center rounded-full bg-white/50 text-slate-400 hover:text-slate-600 transition-colors">
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            )}

            {/* Create/Edit Modal - Refatorado Premium */}
            {showModal && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-50 p-6 animate-in fade-in duration-300">
                    <div className="bg-white rounded-[48px] shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col border border-white/20">
                        <div className="p-10 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                            <div>
                                <h2 className="text-3xl font-black text-slate-900 tracking-tighter uppercase transition-all duration-700">
                                    {editingClinic ? 'Ajustar Master Data' : 'Nova Unidade no Cluster'}
                                </h2>
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[3px] mt-1">Configuração de arquitetura e integridade</p>
                            </div>
                            <button onClick={() => setShowModal(false)} className="h-12 w-12 rounded-2xl bg-white border border-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-900 transition-all">
                                <X className="h-6 w-6" />
                            </button>
                        </div>

                        <div className="p-10 space-y-10 overflow-y-auto custom-scrollbar flex-1">
                            {/* Basic Info */}
                            <div className="space-y-6">
                                <div className="flex items-center gap-3">
                                    <div className="h-8 w-8 rounded-lg bg-emerald-50 flex items-center justify-center text-primary">
                                        <Building2 className="h-4 w-4" />
                                    </div>
                                    <h3 className="text-[12px] font-black text-slate-900 uppercase tracking-[2px]">Informações Corporativas</h3>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px] ml-1">Razão Social / Nome Fantasia *</label>
                                        <input value={formName} onChange={(e) => setFormName(e.target.value)} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all" placeholder="Ex: Matriz VisMed" />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px] ml-1">CNPJ / Registro Fiscal</label>
                                        <input value={formCnpj} onChange={(e) => setFormCnpj(e.target.value)} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all" placeholder="00.000.000/0000-00" />
                                    </div>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px] ml-1">E-mail de Contato</label>
                                        <input type="email" value={formEmail} onChange={(e) => setFormEmail(e.target.value)} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all" placeholder="contato@empresa.com" />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px] ml-1">Telefone Principal</label>
                                        <input type="tel" value={formPhone} onChange={(e) => setFormPhone(e.target.value)} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all" placeholder="(00) 00000-0000" />
                                    </div>
                                </div>
                                <label className="flex items-center gap-3 cursor-pointer group">
                                    <div className="relative">
                                        <input type="checkbox" checked={formActive} onChange={(e) => setFormActive(e.target.checked)} className="sr-only peer" />
                                        <div className="w-12 h-6 bg-slate-200 rounded-full peer peer-checked:bg-primary transition-all duration-300"></div>
                                        <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full transition-all duration-300 peer-checked:translate-x-6 shadow-sm"></div>
                                    </div>
                                    <span className="text-[11px] font-black text-slate-500 uppercase tracking-[2px] group-hover:text-slate-900 transition-colors">Operação Ativada no Cluster</span>
                                </label>
                            </div>

                            {/* Address */}
                            <div className="space-y-6 border-t border-slate-100 pt-10">
                                <div className="flex items-center gap-3">
                                    <div className="h-8 w-8 rounded-lg bg-emerald-50 flex items-center justify-center text-primary">
                                        <MapPin className="h-4 w-4" />
                                    </div>
                                    <h3 className="text-[12px] font-black text-slate-900 uppercase tracking-[2px]">Arquitetura de Endereço</h3>
                                </div>
                                <div className="space-y-4">
                                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-6">
                                        <div className="sm:col-span-8 space-y-2">
                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px] ml-1">Logradouro</label>
                                            <input value={formAddrStreet} onChange={(e) => setFormAddrStreet(e.target.value)} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all" placeholder="Rua / Avenida" />
                                        </div>
                                        <div className="sm:col-span-4 space-y-2">
                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px] ml-1">Número</label>
                                            <input value={formAddrNumber} onChange={(e) => setFormAddrNumber(e.target.value)} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all" placeholder="123" />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px] ml-1">Complemento</label>
                                            <input value={formAddrComplement} onChange={(e) => setFormAddrComplement(e.target.value)} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all" placeholder="Sala, Andar..." />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px] ml-1">Bairro</label>
                                            <input value={formAddrNeighborhood} onChange={(e) => setFormAddrNeighborhood(e.target.value)} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all" placeholder="Distrito" />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px] ml-1">Cidade</label>
                                            <input value={formAddrCity} onChange={(e) => setFormAddrCity(e.target.value)} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all" placeholder="Município" />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px] ml-1">Estado</label>
                                            <select value={formAddrState} onChange={(e) => setFormAddrState(e.target.value)} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[13px] font-black uppercase shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all">
                                                <option value="">UF</option>
                                                {['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'].map(uf => (
                                                    <option key={uf} value={uf}>{uf}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px] ml-1">CEP</label>
                                            <input value={formAddrZipCode} onChange={(e) => setFormAddrZipCode(e.target.value)} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all" placeholder="00000-000" />
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* VisMed Integration Hub */}
                            <div className="space-y-6 border-t border-slate-100 pt-10">
                                <div className="flex items-center gap-3">
                                    <div className="h-8 w-8 rounded-lg bg-emerald-50 flex items-center justify-center text-primary">
                                        <Plug className="h-4 w-4" />
                                    </div>
                                    <h3 className="text-[12px] font-black text-slate-900 uppercase tracking-[2px]">Hub de Integração VisMed Central</h3>
                                </div>
                                <div className="bg-emerald-50/50 border border-emerald-100 rounded-[24px] p-6 space-y-6">
                                    <label className="flex items-center gap-3 cursor-pointer group">
                                        <div className="relative">
                                            <input type="checkbox" checked={formVismedActive} onChange={(e) => setFormVismedActive(e.target.checked)} className="sr-only peer" />
                                            <div className="w-12 h-6 bg-slate-200 rounded-full peer peer-checked:bg-primary transition-all duration-300"></div>
                                            <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full transition-all duration-300 peer-checked:translate-x-6 shadow-sm"></div>
                                        </div>
                                        <span className="text-[11px] font-black text-primary uppercase tracking-[2px] group-hover:text-emerald-800 transition-colors">Vínculo de Sincronismo Autorizado</span>
                                    </label>

                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-[2px] ml-1">ID Empresa Gestora *</label>
                                        <input type="number" value={formVismedNotes} onChange={(e) => setFormVismedNotes(e.target.value)} className="w-full h-14 rounded-[20px] border-2 border-slate-100 bg-white px-5 text-[15px] font-black shadow-sm focus:border-primary focus:ring-4 focus:ring-primary/5 outline-none transition-all" placeholder="Ex: 286" />
                                        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-2 px-1">Chave primária para extração de Profissionais, Unidades e Especialidades.</p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="p-10 border-t border-slate-100 bg-slate-50/50 flex justify-end gap-4">
                            <button onClick={() => setShowModal(false)} className="px-8 py-4 text-[11px] font-black uppercase tracking-[2px] text-slate-400 hover:text-slate-900 transition-all">
                                Cancelar
                            </button>
                            <button onClick={handleSave} disabled={isSaving || !formName} className="bg-primary hover:bg-emerald-600 text-white px-10 py-4 rounded-[24px] text-[11px] font-black shadow-2xl shadow-primary/20 transition-all hover:-translate-y-1 active:scale-95 disabled:opacity-50 flex items-center gap-3 uppercase tracking-[2px]">
                                {isSaving ? <Loader2 className="h-5 w-5 animate-spin" /> : <ShieldCheck className="h-5 w-5" />}
                                {editingClinic ? 'Persistir Ajustes' : 'Criar Unidade'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
