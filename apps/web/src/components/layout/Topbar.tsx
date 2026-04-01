'use client';
import { Bell, Search, RefreshCw, ChevronDown, Building2, Check } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useClinicStore } from '@/lib/clinic-store';

export function Topbar() {
    const { activeClinic, clinics, setActiveClinic } = useClinicStore();
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Close dropdown on outside click
    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setDropdownOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);

    const handleSwitch = (clinic: any) => {
        setActiveClinic({ id: clinic.id, name: clinic.name, cnpj: clinic.cnpj, active: clinic.active });
        setDropdownOpen(false);
        // Reload to refresh all data with new clinic context
        window.location.reload();
    };

    return (
        <header className="h-16 bg-white border-b border-border flex items-center justify-between px-6 shadow-sm z-10 w-full shrink-0">
            <div className="flex items-center gap-4">
                {/* Clinic selector */}
                <div className="relative" ref={dropdownRef}>
                    <button
                        onClick={() => clinics.length > 1 && setDropdownOpen(!dropdownOpen)}
                        className={`flex items-center gap-2 bg-primary/10 text-primary px-3 py-1.5 rounded-md font-medium text-sm transition-colors ${clinics.length > 1 ? 'hover:bg-primary/15 cursor-pointer' : ''}`}
                    >
                        <span className="h-2 w-2 rounded-full bg-primary animate-pulse"></span>
                        {activeClinic?.name || 'Selecione uma Clínica'}
                        <span className="bg-primary text-white text-[10px] uppercase px-1.5 py-0.5 rounded ml-1">
                            {activeClinic?.active ? 'Ativa' : 'Inativa'}
                        </span>
                        {clinics.length > 1 && (
                            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
                        )}
                    </button>

                    {dropdownOpen && clinics.length > 1 && (
                        <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-border rounded-lg shadow-lg z-50 py-1 animate-in fade-in slide-in-from-top-1 duration-150">
                            <div className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                                Trocar Clínica
                            </div>
                            {clinics.map((c) => (
                                <button
                                    key={c.id}
                                    onClick={() => handleSwitch(c)}
                                    className={`w-full flex items-center justify-between px-3 py-2.5 text-sm hover:bg-slate-50 transition-colors ${c.id === activeClinic?.id ? 'bg-primary/5' : ''}`}
                                >
                                    <div className="flex items-center gap-2.5">
                                        <Building2 className="h-4 w-4 text-slate-400" />
                                        <div className="text-left">
                                            <div className="font-medium text-slate-800">{c.name}</div>
                                            {c.cnpj && <div className="text-[10px] text-slate-400">{c.cnpj}</div>}
                                        </div>
                                    </div>
                                    {c.id === activeClinic?.id && (
                                        <Check className="h-4 w-4 text-primary" />
                                    )}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-4">
                <div className="relative">
                    <input
                        type="text"
                        placeholder="Buscar registros..."
                        className="h-9 w-64 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
                    />
                </div>

                <button className="relative p-2 text-muted-foreground hover:bg-accent rounded-full transition-colors">
                    <Bell className="h-5 w-5" />
                    <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-destructive"></span>
                </button>

                <button className="flex items-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md text-sm font-medium shadow-sm transition-colors">
                    <RefreshCw className="h-4 w-4" />
                    Sincronizar Agora
                </button>
            </div>
        </header>
    );
}
