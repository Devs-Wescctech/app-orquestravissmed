'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
    LayoutDashboard,
    CalendarDays,
    RefreshCw,
    ShieldPlus,
    Settings,
    LogOut,
    Building2,
    ChevronLeft,
    ChevronRight,
    Database
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/lib/store';
import { useClinicStore } from '@/lib/clinic-store';
import Cookies from 'js-cookie';

export function Sidebar() {
    const pathname = usePathname();
    const router = useRouter();
    const user = useAuthStore((state) => state.user);
    const logout = useAuthStore((state) => state.logout);
    const clearClinic = useClinicStore((s) => s.clearClinic);
    const [isCollapsed, setIsCollapsed] = useState(false);

    const isSuperAdmin = user?.roles?.some((r: any) => r.role === 'SUPER_ADMIN');

    const handleLogout = () => {
        Cookies.remove('vismed_auth_token');
        clearClinic();
        logout();
        router.push('/login');
    };

    const mainLinks = [
        { name: 'Dashboard', href: '/', icon: LayoutDashboard },
        { name: 'Agendamentos', href: '/appointments', icon: CalendarDays },
    ];

    const integrationLinks = [
        { name: 'Logs de Sincronização', href: '/sync', icon: RefreshCw },
        { name: 'Central de Mapeamento', href: '/mapping', icon: RefreshCw },
        { name: 'Catálogo de Serviços', href: '/services', icon: Database },
    ];

    const adminLinks = [
        { name: 'Clínicas', href: '/clinics', icon: Building2 },
    ];

    return (
        <aside className={cn(
            "bg-gradient-to-b from-slate-950 to-slate-900 text-slate-300 h-full flex flex-col justify-between border-r border-slate-900 shadow-xl overflow-hidden transition-all duration-300 ease-in-out shrink-0",
            isCollapsed ? "w-20" : "w-64"
        )}>
            <div className="flex flex-col h-full justify-between">
                <div>
                    <div className={cn("h-16 flex items-center border-b border-slate-900 transition-all duration-300", isCollapsed ? "justify-center" : "justify-between px-4")}>
                        <div className={cn("flex items-center gap-2.5 overflow-hidden transition-all duration-300", isCollapsed ? "w-0 opacity-0 hidden" : "w-auto opacity-100 pl-2")}>
                            <ShieldPlus className="text-emerald-500 h-6 w-6 shrink-0" />
                            <div className="font-semibold text-lg tracking-tight text-slate-100 whitespace-nowrap drop-shadow-md">VisMed</div>
                        </div>
                        <button 
                            onClick={() => setIsCollapsed(!isCollapsed)} 
                            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-800 hover:text-slate-200 transition-all flex items-center justify-center group"
                            title={isCollapsed ? "Expandir Menu" : "Recolher Menu"}
                        >
                            {isCollapsed ? <ShieldPlus className="h-6 w-6 text-emerald-500 group-hover:scale-110 transition-transform" /> : <ChevronLeft className="h-5 w-5" />}
                        </button>
                    </div>

                    <nav className="p-3 flex flex-col gap-1 overflow-y-auto custom-scrollbar">
                        {mainLinks.map((link) => {
                            const isActive = pathname === link.href || (pathname.startsWith(link.href) && link.href !== '/');
                            return (
                                <Link
                                    key={link.name}
                                    href={link.href}
                                    className={cn(
                                        "flex items-center gap-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group relative",
                                        isActive
                                            ? "bg-emerald-500/10 text-emerald-400"
                                            : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
                                        isCollapsed ? "justify-center px-0" : "px-3"
                                    )}
                                    title={isCollapsed ? link.name : undefined}
                                >
                                    <link.icon className={cn("h-[18px] w-[18px] shrink-0 transition-transform", isActive ? "text-emerald-400" : "text-slate-500 group-hover:text-slate-300", isCollapsed && "group-hover:scale-110")} />
                                    {!isCollapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">{link.name}</span>}
                                </Link>
                            )
                        })}

                        {!isCollapsed ? (
                            <div className="mt-6 mb-2 px-3 text-[10px] font-bold text-slate-500 tracking-widest uppercase whitespace-nowrap overflow-hidden">
                                Integração
                            </div>
                        ) : (
                            <div className="mt-5 mx-auto w-6 border-t border-slate-800 mb-2"></div>
                        )}

                        {integrationLinks.map((link) => {
                            const isActive = pathname === link.href || pathname.startsWith(`${link.href}/`);
                            return (
                                <Link
                                    key={link.name}
                                    href={link.href}
                                    className={cn(
                                        "flex items-center gap-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group relative",
                                        isActive
                                            ? "bg-emerald-500/10 text-emerald-400"
                                            : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
                                        isCollapsed ? "justify-center px-0" : "px-3"
                                    )}
                                    title={isCollapsed ? link.name : undefined}
                                >
                                    <link.icon className={cn("h-[18px] w-[18px] shrink-0 transition-transform", isActive ? "text-emerald-400" : "text-slate-500 group-hover:text-slate-300", isCollapsed && "group-hover:scale-110")} />
                                    {!isCollapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">{link.name}</span>}
                                </Link>
                            )
                        })}

                        {isSuperAdmin && (
                            <>
                                {!isCollapsed ? (
                                    <div className="mt-6 mb-2 px-3 text-[10px] font-bold text-slate-500 tracking-widest uppercase whitespace-nowrap overflow-hidden">
                                        Administração
                                    </div>
                                ) : (
                                    <div className="mt-5 mx-auto w-6 border-t border-slate-800 mb-2"></div>
                                )}

                                {adminLinks.map((link) => {
                                    const isActive = pathname === link.href || pathname.startsWith(`${link.href}/`);
                                    return (
                                        <Link
                                            key={link.name}
                                            href={link.href}
                                            className={cn(
                                                "flex items-center gap-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group relative",
                                                isActive
                                                    ? "bg-emerald-500/10 text-emerald-400"
                                                    : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
                                                isCollapsed ? "justify-center px-0" : "px-3"
                                            )}
                                            title={isCollapsed ? link.name : undefined}
                                        >
                                            <link.icon className={cn("h-[18px] w-[18px] shrink-0 transition-transform", isActive ? "text-emerald-400" : "text-slate-500 group-hover:text-slate-300", isCollapsed && "group-hover:scale-110")} />
                                            {!isCollapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">{link.name}</span>}
                                        </Link>
                                    )
                                })}
                            </>
                        )}
                    </nav>
                </div>

                <div className="p-3 border-t border-slate-900 flex flex-col items-center">
                    <Link
                        href="/settings"
                        className={cn(
                            "flex items-center gap-3 py-2.5 rounded-lg text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-all duration-200 mb-2 w-full group",
                            isCollapsed ? "justify-center px-0" : "px-3"
                        )}
                        title={isCollapsed ? "Configurações" : undefined}
                    >
                        <Settings className={cn("h-[18px] w-[18px] shrink-0 text-slate-500 group-hover:text-slate-300 transition-transform", isCollapsed && "group-hover:rotate-90")} />
                        {!isCollapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">Configurações</span>}
                    </Link>
                    
                    <div className={cn(
                        "flex items-center justify-between p-2 mt-2 bg-slate-900/50 rounded-xl border border-slate-800/50 w-full transition-all duration-300", 
                        isCollapsed && "flex-col gap-3 px-1 py-3 bg-transparent border-transparent"
                    )}>
                        <div className={cn("flex items-center gap-3 overflow-hidden", isCollapsed && "justify-center")}>
                            <div className="h-8 w-8 shrink-0 rounded-full bg-slate-800 flex items-center justify-center text-[10px] font-bold text-slate-300 uppercase shadow-inner border border-slate-700/50">
                                {user?.name ? user.name.substring(0, 2) : 'AD'}
                            </div>
                            {!isCollapsed && (
                                <div className="flex flex-col truncate">
                                    <span className="text-sm font-medium text-slate-200 truncate">{user?.name || 'Administrador'}</span>
                                    <span className="text-xs text-slate-500 truncate">{user?.email || 'admin@vismed.com'}</span>
                                </div>
                            )}
                        </div>
                        <button
                            onClick={handleLogout}
                            className={cn(
                                "p-1.5 text-slate-500 hover:text-red-400 hover:bg-slate-800 rounded-md transition-all shrink-0",
                                isCollapsed && "mt-1 p-2 bg-slate-900 rounded-full hover:bg-red-500/20"
                            )}
                            title="Sair"
                        >
                            <LogOut className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            </div>
        </aside>
    );
}
