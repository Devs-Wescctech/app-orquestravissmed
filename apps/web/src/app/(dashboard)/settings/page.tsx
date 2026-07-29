'use client';
import { useState, useEffect } from 'react';
import { User, KeyRound, SlidersHorizontal, ServerCog, Loader2, Save, Info } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { useUIStore } from '@/lib/ui-store';
import { toast } from 'sonner';

interface SystemSetting {
    key: string;
    label: string;
    value: string;
    description: string;
}

export default function SettingsPage() {
    const { user, token, login } = useAuthStore();
    const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
    const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);

    const isSuperAdmin = user?.roles?.some((r: any) => r.role === 'SUPER_ADMIN');

    // Profile
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [isSavingProfile, setIsSavingProfile] = useState(false);

    // Password
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [isSavingPassword, setIsSavingPassword] = useState(false);

    // System
    const [systemSettings, setSystemSettings] = useState<SystemSetting[] | null>(null);
    const [isLoadingSystem, setIsLoadingSystem] = useState(false);

    useEffect(() => {
        const fetchProfile = async () => {
            try {
                const res = await api.get('/users/me/profile');
                setName(res.data?.name || '');
                setEmail(res.data?.email || '');
            } catch {
                setName(user?.name || '');
                setEmail(user?.email || '');
            }
        };
        if (user) fetchProfile();
    }, [user]);

    useEffect(() => {
        if (!isSuperAdmin) return;
        const fetchSystem = async () => {
            setIsLoadingSystem(true);
            try {
                const res = await api.get('/settings/system');
                setSystemSettings(res.data?.settings || []);
            } catch (e) {
                console.error(e);
            } finally {
                setIsLoadingSystem(false);
            }
        };
        fetchSystem();
    }, [isSuperAdmin]);

    const handleSaveProfile = async () => {
        if (!name.trim()) {
            toast.error('O nome não pode ficar vazio.');
            return;
        }
        setIsSavingProfile(true);
        try {
            const res = await api.put('/users/me/profile', { name: name.trim() });
            if (user && token) {
                login({ ...user, name: res.data?.name || name.trim() }, token);
            }
            toast.success('Perfil atualizado com sucesso.');
        } catch (e: any) {
            toast.error(e.message || 'Erro ao atualizar o perfil.');
        } finally {
            setIsSavingProfile(false);
        }
    };

    const handleChangePassword = async () => {
        if (!currentPassword || !newPassword || !confirmPassword) {
            toast.error('Preencha todos os campos de senha.');
            return;
        }
        if (newPassword.length < 6) {
            toast.error('A nova senha deve ter pelo menos 6 caracteres.');
            return;
        }
        if (newPassword !== confirmPassword) {
            toast.error('A confirmação não confere com a nova senha.');
            return;
        }
        setIsSavingPassword(true);
        try {
            await api.put('/users/me/password', { currentPassword, newPassword });
            toast.success('Senha alterada com sucesso.');
            setCurrentPassword('');
            setNewPassword('');
            setConfirmPassword('');
        } catch (e: any) {
            toast.error(e.message || 'Erro ao alterar a senha.');
        } finally {
            setIsSavingPassword(false);
        }
    };

    const inputClass = "w-full h-10 rounded-md border border-input bg-background px-3 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:bg-slate-50 disabled:text-slate-500";
    const labelClass = "text-xs font-semibold text-slate-600 uppercase tracking-wide";

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            <div className="mb-8">
                <h1 className="text-3xl font-bold tracking-tight text-slate-900">Configurações</h1>
                <p className="text-muted-foreground mt-1 text-sm">Gerencie seu perfil, preferências de interface e visualize as configurações do sistema.</p>
            </div>

            {/* Perfil */}
            <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
                <div className="p-5 border-b border-border bg-slate-50/50 flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                        <User className="h-5 w-5" />
                    </div>
                    <div>
                        <h2 className="font-semibold text-slate-900">Perfil</h2>
                        <p className="text-xs text-muted-foreground">Seus dados de acesso ao sistema.</p>
                    </div>
                </div>
                <div className="p-6 space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                            <label className={labelClass}>Nome</label>
                            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="Seu nome" />
                        </div>
                        <div className="space-y-1.5">
                            <label className={labelClass}>E-mail</label>
                            <input value={email} disabled className={inputClass} />
                        </div>
                    </div>
                    <div className="flex justify-end">
                        <button
                            onClick={handleSaveProfile}
                            disabled={isSavingProfile}
                            className="flex items-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md text-sm font-medium shadow-sm transition-colors disabled:opacity-60"
                        >
                            {isSavingProfile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            Salvar Perfil
                        </button>
                    </div>

                    <div className="border-t border-border pt-5 space-y-4">
                        <div className="flex items-center gap-2 text-slate-700">
                            <KeyRound className="h-4 w-4" />
                            <h3 className="text-sm font-semibold">Alterar Senha</h3>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <div className="space-y-1.5">
                                <label className={labelClass}>Senha Atual</label>
                                <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className={inputClass} autoComplete="current-password" />
                            </div>
                            <div className="space-y-1.5">
                                <label className={labelClass}>Nova Senha</label>
                                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={inputClass} autoComplete="new-password" />
                            </div>
                            <div className="space-y-1.5">
                                <label className={labelClass}>Confirmar Nova Senha</label>
                                <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={inputClass} autoComplete="new-password" />
                            </div>
                        </div>
                        <div className="flex justify-end">
                            <button
                                onClick={handleChangePassword}
                                disabled={isSavingPassword}
                                className="flex items-center gap-2 bg-slate-900 hover:bg-black text-white px-4 py-2 rounded-md text-sm font-medium shadow-sm transition-colors disabled:opacity-60"
                            >
                                {isSavingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                                Alterar Senha
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Preferências */}
            <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
                <div className="p-5 border-b border-border bg-slate-50/50 flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                        <SlidersHorizontal className="h-5 w-5" />
                    </div>
                    <div>
                        <h2 className="font-semibold text-slate-900">Preferências</h2>
                        <p className="text-xs text-muted-foreground">Preferências de interface, salvas neste navegador e mantidas entre sessões.</p>
                    </div>
                </div>
                <div className="p-6 space-y-4">
                    <label className="flex items-center justify-between cursor-pointer group">
                        <div>
                            <div className="text-sm font-medium text-slate-900">Menu lateral recolhido</div>
                            <div className="text-xs text-muted-foreground">Iniciar com o menu lateral compacto (apenas ícones).</div>
                        </div>
                        <div className="relative">
                            <input type="checkbox" checked={sidebarCollapsed} onChange={(e) => setSidebarCollapsed(e.target.checked)} className="sr-only peer" />
                            <div className="w-11 h-6 bg-slate-200 rounded-full peer peer-checked:bg-primary transition-all duration-300"></div>
                            <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full transition-all duration-300 peer-checked:translate-x-5 shadow-sm"></div>
                        </div>
                    </label>
                </div>
            </div>

            {/* Sistema (SUPER_ADMIN) */}
            {isSuperAdmin && (
                <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
                    <div className="p-5 border-b border-border bg-slate-50/50 flex items-center gap-3">
                        <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                            <ServerCog className="h-5 w-5" />
                        </div>
                        <div>
                            <h2 className="font-semibold text-slate-900">Sistema</h2>
                            <p className="text-xs text-muted-foreground">Estado das chaves operacionais. Somente leitura.</p>
                        </div>
                    </div>
                    <div className="p-6 space-y-4">
                        <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 text-blue-800 rounded-lg p-3 text-xs">
                            <Info className="h-4 w-4 shrink-0 mt-0.5" />
                            Estas configurações são controladas por variáveis de ambiente no servidor e não podem ser alteradas pela interface.
                        </div>
                        {isLoadingSystem ? (
                            <div className="py-8 text-center text-muted-foreground">
                                <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
                                Carregando configurações...
                            </div>
                        ) : systemSettings && systemSettings.length > 0 ? (
                            <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
                                {systemSettings.map((s) => (
                                    <div key={s.key} className="p-4 flex items-center justify-between gap-4 bg-white">
                                        <div>
                                            <div className="text-sm font-medium text-slate-900">{s.label}</div>
                                            <div className="text-xs text-muted-foreground mt-0.5">{s.description}</div>
                                            <div className="text-[10px] font-mono text-slate-400 mt-1">{s.key}</div>
                                        </div>
                                        <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-slate-100 text-slate-700 font-mono shrink-0">
                                            {s.value}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="py-6 text-center text-sm text-muted-foreground">
                                Não foi possível carregar as configurações do sistema.
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
