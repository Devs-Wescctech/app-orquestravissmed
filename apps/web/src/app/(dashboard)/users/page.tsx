'use client';
import { useState, useEffect } from 'react';
import { Search, Plus, MoreHorizontal, ShieldCheck, Mail, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

interface User {
    id: string;
    name: string;
    email: string;
    status: string;
    active: boolean;
    role: string;
    clinics: number;
}

export default function UsersManagement() {
    const [users, setUsers] = useState<User[]>([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const fetchUsers = async () => {
            try {
                const response = await api.get('/users');
                const data = response.data;
                const formattedUsers = data.map((u: any) => ({
                    id: u.id,
                    name: u.name,
                    email: u.email,
                    status: u.active ? 'Ativo' : 'Inativo',
                    active: u.active,
                    role: u.roles && u.roles.length > 0 ? u.roles[0].role : 'OPERATOR',
                    clinics: u.roles ? u.roles.length : 0
                }));
                setUsers(formattedUsers);
            } catch (error) {
                console.error('Error fetching users:', error);
            } finally {
                setIsLoading(false);
            }
        };

        fetchUsers();
    }, []);

    const filteredUsers = users.filter((u) => u.name.toLowerCase().includes(searchTerm.toLowerCase()));

    return (
        <div className="max-w-6xl mx-auto space-y-6">
            <div className="flex justify-between items-start mb-8">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-slate-900">Usuários</h1>
                    <p className="text-muted-foreground mt-1 text-sm">Gerencie usuários do sistema, acesso às clínicas e permissões por cargo.</p>
                </div>
                <button className="flex items-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md text-sm font-medium shadow-sm transition-colors">
                    <Plus className="h-4 w-4" />
                    Adicionar Usuário
                </button>
            </div>

            <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
                <div className="p-4 border-b border-border flex justify-between items-center bg-slate-50/50">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <input
                            type="text"
                            placeholder="Buscar usuários..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-9 h-9 w-64 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                        />
                    </div>
                    <div className="flex gap-2">
                        <select className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary text-slate-600">
                            <option value="">Todos os Cargos</option>
                            <option value="SUPER_ADMIN">Super Admin</option>
                            <option value="CLINIC_ADMIN">Administrador da Clínica</option>
                            <option value="OPERATOR">Operador</option>
                        </select>
                    </div>
                </div>

                <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-xs text-muted-foreground uppercase font-semibold border-b border-border">
                        <tr>
                            <th className="px-6 py-4">Usuário</th>
                            <th className="px-6 py-4">Contato</th>
                            <th className="px-6 py-4">Cargo & Acesso</th>
                            <th className="px-6 py-4 text-center">Status</th>
                            <th className="px-6 py-4 text-right">Ações</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {isLoading ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                                    <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
                                    Carregando usuários...
                                </td>
                            </tr>
                        ) : filteredUsers.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                                    Nenhum usuário encontrado.
                                </td>
                            </tr>
                        ) : (
                            filteredUsers.map((user) => (
                                <tr key={user.id} className="hover:bg-slate-50 transition-colors">
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-3">
                                            <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm">
                                                {user.name.split(' ').map(n => n[0]).join('').substring(0, 2)}
                                            </div>
                                            <div className="font-medium text-slate-900">{user.name}</div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-slate-600">
                                        <div className="flex items-center gap-2">
                                            <Mail className="h-4 w-4 text-slate-400" />
                                            {user.email}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex flex-col gap-1">
                                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide bg-slate-100 text-slate-700 w-fit">
                                                <ShieldCheck className="h-3 w-3" />
                                                {user.role}
                                            </span>
                                            <span className="text-[11px] text-muted-foreground">
                                                Acesso a {user.clinics} clínica{user.clinics !== 1 ? 's' : ''}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-center">
                                        {user.active ? (
                                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-50 text-green-700">
                                                Ativo
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
                                                Inativo
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <button className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition-colors">
                                            <MoreHorizontal className="h-5 w-5" />
                                        </button>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>

                <div className="p-4 border-t border-border flex justify-between items-center text-sm text-muted-foreground bg-white">
                    Exibindo {filteredUsers.length} usuários
                </div>
            </div>
        </div>
    );
}
