"use client";

import React, { useState, useEffect } from 'react';
import { Search, Database, Hash, Link2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";

interface DoctoraliaService {
  id: string;
  name: string;
  doctoraliaServiceId: string;
  normalizedName: string;
}

interface CatalogStats {
  totalServices: number;
  totalMapped: number;
  totalPendingReview: number;
}

export default function ServicesCatalogPage() {
  const [query, setQuery] = useState('');
  const [services, setServices] = useState<DoctoraliaService[]>([]);
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchStats = async () => {
    try {
      const res = await api.get('/mappings/catalog/stats');
      setStats(res.data);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      api.get('/mappings/catalog/search', {
        params: { q: query, limit: '100' },
        signal: controller.signal,
      }).then(res => {
        setServices(res.data || []);
      }).catch(e => {
        if (e.name !== 'CanceledError') console.error(e);
      }).finally(() => {
        setLoading(false);
      });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  const statCards = stats ? [
    {
      label: 'Total de Serviços',
      value: stats.totalServices.toLocaleString('pt-BR'),
      icon: Database,
      color: 'bg-blue-500/10',
      iconColor: 'text-blue-500',
      textColor: 'text-blue-700',
    },
    {
      label: 'Mapeados',
      value: stats.totalMapped.toLocaleString('pt-BR'),
      icon: CheckCircle2,
      color: 'bg-emerald-500/10',
      iconColor: 'text-emerald-500',
      textColor: 'text-emerald-700',
    },
    {
      label: 'Aguardando Revisão',
      value: stats.totalPendingReview.toLocaleString('pt-BR'),
      icon: AlertTriangle,
      color: 'bg-amber-500/10',
      iconColor: 'text-amber-500',
      textColor: 'text-amber-700',
    },
  ] : [];

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Catálogo de Serviços <span className="text-emerald-500">Doctoralia</span>
        </h1>
        <p className="text-slate-500 mt-1">
          Pesquise no catálogo global de serviços integrados ao sistema VisMed.
        </p>
      </div>

      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {statCards.map((card) => (
            <div key={card.label} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
              <div className={`${card.color} p-3 rounded-xl`}>
                <card.icon className={`${card.iconColor} w-6 h-6`} />
              </div>
              <div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{card.label}</div>
                <div className={`text-2xl font-bold ${card.textColor}`}>{card.value}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-xl shadow-slate-200/50 border border-slate-100 overflow-hidden">
        <div className="p-6 border-b border-slate-50 bg-slate-50/50">
          <div className="relative group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 group-focus-within:text-emerald-500 transition-colors" />
            <input
              type="text"
              placeholder="Ex: Cardiologia, Exame de Sangue, Cirurgia..."
              className="w-full pl-12 pr-4 py-4 text-lg bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 shadow-sm transition-all"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {!loading && services.length > 0 && (
            <div className="mt-3 text-sm text-slate-500">
              {services.length >= 100 ? '100+ resultados' : `${services.length} resultado${services.length !== 1 ? 's' : ''}`}
              {query && <span> para "<strong className="text-slate-700">{query}</strong>"</span>}
            </div>
          )}
        </div>

        <div className="min-h-[400px] bg-white">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-32 space-y-4">
              <div className="w-10 h-10 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin"></div>
              <p className="text-slate-500 font-medium animate-pulse">Consultando catálogo global...</p>
            </div>
          ) : services.length > 0 ? (
            <div className="divide-y divide-slate-50">
              {services.map((s) => (
                <div
                  key={s.id}
                  className="px-6 py-4 hover:bg-slate-50/80 transition-all group flex items-center justify-between gap-4"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="flex-shrink-0 bg-emerald-500/10 p-2 rounded-lg">
                      <Link2 className="w-4 h-4 text-emerald-500" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-semibold text-slate-800 group-hover:text-emerald-600 transition-colors truncate">
                        {s.name}
                      </h3>
                      <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
                        <span className="inline-flex items-center gap-1">
                          <Hash className="w-3 h-3" />
                          ID: {s.doctoraliaServiceId}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-32 text-center px-6">
              <div className="bg-slate-50 p-6 rounded-full mb-4">
                <Search className="w-12 h-12 text-slate-300" />
              </div>
              <h3 className="text-xl font-semibold text-slate-700">Nenhum serviço encontrado</h3>
              <p className="text-slate-500 max-w-sm mt-1">
                Tente buscar por termos mais genéricos como "Consulta", "Exame" ou "Cirurgia".
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 text-xs text-slate-400 uppercase tracking-widest font-bold">
        <span className="w-12 h-px bg-slate-200"></span>
        vismed health systems integration
        <span className="w-12 h-px bg-slate-200"></span>
      </div>
    </div>
  );
}
