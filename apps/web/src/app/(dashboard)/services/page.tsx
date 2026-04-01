
"use client";

import React, { useState, useEffect } from 'react';
import { Search, Info, Database, Hash } from "lucide-react";
import { callEdgeFunction } from "@/lib/supabase";

interface DoctoraliaService {
  id: string;
  name: string;
  doctoralia_service_id: string;
  normalized_name: string;
}

export default function ServicesCatalogPage() {
  const [query, setQuery] = useState('');
  const [services, setServices] = useState<DoctoraliaService[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchServices = async (q: string) => {
    setLoading(true);
    try {
      const data = await callEdgeFunction('api-mappings', {
        method: 'GET',
        path: '/catalog/search',
        params: { q, limit: '100' }
      });
      setServices(data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchServices(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="p-6 space-y-8 max-w-7xl mx-auto animate-in fade-in duration-500">
      {/* Header section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Catálogo de Serviços <span className="text-emerald-500">Doctoralia</span>
          </h1>
          <p className="text-slate-500 mt-1">
            Pesquise por mais de 10.000 serviços globais integrados ao sistema VisMed.
          </p>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="bg-emerald-500/10 p-2 rounded-lg">
            <Database className="text-emerald-500 w-6 h-6" />
          </div>
          <div>
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Banco de Dados</div>
            <div className="text-lg font-bold text-slate-800">~10.792 serviços</div>
          </div>
        </div>
      </div>

      {/* Search and Results Section */}
      <div className="bg-white rounded-2xl shadow-xl shadow-slate-200/50 border border-slate-100 overflow-hidden">
        {/* Search Bar */}
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
        </div>

        {/* Results area */}
        <div className="min-h-[500px] bg-white">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-32 space-y-4">
              <div className="w-10 h-10 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin"></div>
              <p className="text-slate-500 font-medium animate-pulse">Consultando catálogo global...</p>
            </div>
          ) : services.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-0">
              {services.map((s) => (
                <div 
                  key={s.id} 
                  className="p-5 border-b border-r border-slate-50 hover:bg-slate-50/80 transition-all group flex flex-col justify-between"
                >
                  <div className="space-y-2">
                    <div className="flex justify-between items-start gap-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500 uppercase">
                        ID: {s.doctoralia_service_id}
                      </span>
                      <button className="text-slate-300 hover:text-emerald-500 transition-colors">
                        <Info className="w-4 h-4" />
                      </button>
                    </div>
                    <h3 className="font-semibold text-slate-800 text-lg group-hover:text-emerald-600 transition-colors leading-snug">
                      {s.name}
                    </h3>
                  </div>
                  
                  <div className="mt-6 flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
                      <Hash className="w-3 h-3" />
                      <span className="truncate max-w-[120px]">{s.id}</span>
                    </div>
                    <div className="h-1 w-12 bg-slate-100 rounded-full group-hover:bg-emerald-500 transition-all duration-500"></div>
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

      {/* Footer Info */}
      <div className="flex items-center justify-center gap-2 text-xs text-slate-400 uppercase tracking-widest font-bold">
        <span className="w-12 h-px bg-slate-200"></span>
        vissmed health systems integration
        <span className="w-12 h-px bg-slate-200"></span>
      </div>
    </div>
  );
}
