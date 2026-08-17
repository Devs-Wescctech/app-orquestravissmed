'use client';
/**
 * WP-14 — Dashboard Operacional Doctoralia/VisMed (SUPER_ADMIN only)
 *
 * Responde: "a infraestrutura Doctoralia está saudável ou se aproximando de
 * saturação?" — complementar à Central de Sincronização (/sync), que responde
 * "a clínica está sincronizando corretamente?".
 *
 * Fonte única de dados no refresh periódico: GET /metrics/doctoralia-baseline.
 * Sem fan-out por clínica: o status detalhado da clínica só é carregado sob
 * demanda (quando o usuário expande a clínica).
 */
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
    Activity, Loader2, ShieldAlert, Gauge, Timer, ListOrdered, RefreshCw,
    AlertTriangle, WifiOff, Zap, Building2, ChevronDown, ChevronUp,
    ArrowUpRight, CircleSlash, Repeat, Layers, Users, Copy,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/store';

// ───────────────────────────── helpers ──────────────────────────────────────

const fmtNum = (n: number | null | undefined) =>
    n === null || n === undefined ? '—' : n.toLocaleString('pt-BR');

const fmtMs = (ms: number | null | undefined): string => {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const min = Math.floor(ms / 60000);
    if (min < 60) return `${min}m ${Math.floor((ms % 60000) / 1000)}s`;
    const h = Math.floor(min / 60);
    return `${h}h ${min % 60}m`;
};

const fmtDateTime = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }) : '—';

// ───────────────────────────── UI primitives ────────────────────────────────

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
    return (
        <div className={`bg-white/70 backdrop-blur-xl rounded-[32px] p-6 shadow-sm border border-slate-100/60 ${className}`}>
            {children}
        </div>
    );
}

function SectionTitle({ icon: Icon, title, subtitle }: { icon: any; title: string; subtitle?: string }) {
    return (
        <div className="flex items-center gap-3 mb-4">
            <div className="h-9 w-9 rounded-2xl bg-slate-900 text-white flex items-center justify-center shadow-lg shrink-0">
                <Icon className="h-4 w-4" />
            </div>
            <div>
                <h2 className="text-sm font-black text-slate-900 uppercase tracking-[2px]">{title}</h2>
                {subtitle && <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">{subtitle}</p>}
            </div>
        </div>
    );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
    return (
        <div className="bg-slate-50/80 rounded-2xl p-4">
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{label}</div>
            <div className="text-xl font-black text-slate-900 tracking-tight">{value}</div>
            {sub && <div className="text-[10px] font-bold text-slate-400 mt-1">{sub}</div>}
        </div>
    );
}

/** Barra de uso apenas quando há denominador real (limite oficial). */
function UsageBar({ used, limit }: { used: number | null; limit: number }) {
    if (used === null || used === undefined) return null;
    const pct = Math.min(100, Math.round((used / limit) * 100));
    const atLimit = used >= limit;
    return (
        <div className="h-1.5 w-full bg-slate-100 rounded-full mt-2 overflow-hidden">
            <div
                className={`h-full rounded-full transition-all duration-700 ${atLimit ? 'bg-amber-500' : 'bg-slate-400'}`}
                style={{ width: `${pct}%` }}
            />
        </div>
    );
}

// ───────────────────────────── tipos leves ──────────────────────────────────

type Baseline = Record<string, any>;

// ───────────────────────────── página ───────────────────────────────────────

export default function AdminOperationsPage() {
    const user = useAuthStore((s) => s.user);
    const hasHydrated = useAuthStore((s) => s._hasHydrated);
    const isSuperAdmin = user?.roles?.some((r: any) => r.role === 'SUPER_ADMIN');

    const [baseline, setBaseline] = useState<Baseline | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [fetchError, setFetchError] = useState(false);
    const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

    const [clinics, setClinics] = useState<any[]>([]);
    const [expandedClinicId, setExpandedClinicId] = useState<string | null>(null);
    const [clinicStatus, setClinicStatus] = useState<Record<string, any>>({});
    const [clinicStatusLoading, setClinicStatusLoading] = useState<string | null>(null);

    const fetchBaseline = useCallback(async () => {
        if (!isSuperAdmin) return;
        try {
            const res = await api.get(`/metrics/doctoralia-baseline?t=${Date.now()}`);
            setBaseline(res.data);
            setFetchError(false);
            setLastUpdatedAt(new Date());
        } catch (e) {
            console.error('Erro ao carregar baseline operacional:', e);
            setFetchError(true);
        } finally {
            setIsLoading(false);
        }
    }, [isSuperAdmin]);

    // Lista de clínicas: carregada uma única vez (sem fan-out no refresh periódico)
    useEffect(() => {
        if (!isSuperAdmin) return;
        api.get('/clinics').then((res) => setClinics(res.data || [])).catch((e) => console.error(e));
    }, [isSuperAdmin]);

    useEffect(() => { fetchBaseline(); }, [fetchBaseline]);
    useEffect(() => {
        const interval = setInterval(fetchBaseline, 15000);
        return () => clearInterval(interval);
    }, [fetchBaseline]);

    /** Status detalhado da clínica: SOB DEMANDA apenas, ao expandir. */
    const toggleClinic = async (clinicId: string) => {
        if (expandedClinicId === clinicId) { setExpandedClinicId(null); return; }
        setExpandedClinicId(clinicId);
        if (!clinicStatus[clinicId]) {
            setClinicStatusLoading(clinicId);
            try {
                const res = await api.get(`/sync/${clinicId}/status?t=${Date.now()}`);
                setClinicStatus((prev) => ({ ...prev, [clinicId]: res.data }));
            } catch (e) {
                console.error(e);
                setClinicStatus((prev) => ({ ...prev, [clinicId]: { _error: true } }));
            } finally {
                setClinicStatusLoading(null);
            }
        }
    };

    // ── Gate SUPER_ADMIN (client-side; o backend já retorna 403) ──────────────
    if (!hasHydrated) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh]">
                <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
            </div>
        );
    }
    if (!isSuperAdmin) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center animate-in fade-in duration-500">
                <div className="h-16 w-16 rounded-[24px] bg-slate-100 flex items-center justify-center mb-6">
                    <ShieldAlert className="h-8 w-8 text-slate-400" />
                </div>
                <h1 className="text-xl font-black text-slate-900 tracking-tight">Acesso restrito</h1>
                <p className="text-sm text-slate-500 font-bold mt-2 max-w-md">
                    Esta área é exclusiva de administradores globais (SUPER_ADMIN).
                </p>
            </div>
        );
    }

    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] animate-in fade-in duration-700">
                <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
                <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-[4px]">Carregando Operação Doctoralia</h2>
            </div>
        );
    }

    // ── Derivações do baseline (todas fail-safe / estados vazios válidos) ─────
    const b = baseline ?? {};
    const circuitByDomain: Record<string, any> = b.circuitBreaker?.byDomain ?? {};
    const circuitDomains = Object.keys(circuitByDomain);
    const anyBreakerOpen = circuitDomains.some((d) => circuitByDomain[d]?.state === 'OPEN');
    const openDomain = circuitDomains.find((d) => circuitByDomain[d]?.state === 'OPEN');

    const budgetUsed: number | null = b.queue?.DOCTORALIA_RATE_LIMIT_USAGE ?? null;
    const writeBudget = b.writeBudget ?? null;
    const writeUsedMin: number | null = writeBudget?.current?.usedInMinute ?? null;
    const writeAtLimit = writeUsedMin !== null && writeUsedMin >= (writeBudget?.limitPerMinute ?? 40);

    // Status geral: vermelho só em estado técnico comprovado (breaker OPEN);
    // amarelo só quando um limite oficial foi efetivamente atingido; senão verde.
    const overall: 'ok' | 'attention' | 'critical' =
        anyBreakerOpen ? 'critical' : writeAtLimit ? 'attention' : 'ok';
    const overallStyles = {
        ok: { bg: 'bg-primary', label: 'Saudável' },
        attention: { bg: 'bg-amber-500', label: 'Atenção: limite WRITE atingido' },
        critical: { bg: 'bg-rose-500', label: `Circuit breaker ABERTO${openDomain ? ` (${openDomain})` : ''}` },
    }[overall];

    const scope = b.measurementScope ?? {};
    const backpressure = b.backpressure ?? {};
    const retry = b.retry ?? {};
    const lowPacing = b.queue?.lowPacing ?? null;
    const appointments = b.appointments ?? {};
    const cg: Record<string, number> = b.concurrencyGuard ?? {};
    const cgNonZero = Object.entries(cg).filter(([, v]) => v > 0);

    return (
        <div className="max-w-7xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">

            {/* ── 1. Header operacional ─────────────────────────────────────── */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                <div className="flex items-center gap-5">
                    <div className={`h-16 w-16 rounded-[24px] ${overallStyles.bg} flex items-center justify-center shadow-[0_12px_24px_-8px_rgba(31,181,122,0.4)] border border-white/20`}>
                        <Activity className="h-8 w-8 text-white" />
                    </div>
                    <div>
                        <div className="flex items-center gap-3 mb-1 flex-wrap">
                            <h1 className="text-3xl font-black text-slate-900 tracking-tighter">Operação Doctoralia</h1>
                            <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest text-white shadow-sm ${overallStyles.bg}`}>
                                {overallStyles.label}
                            </span>
                        </div>
                        <p className="text-sm text-slate-500 font-bold uppercase tracking-wide">
                            Saúde técnica da integração — dados desde o último restart/reset
                        </p>
                        <p className="text-[10px] font-bold text-slate-400 mt-1 uppercase tracking-widest">
                            Janela de medição: {fmtMs(b.measurementPeriodMs)} · Atualizado: {lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString('pt-BR') : '—'}
                            {scope.scope === 'UNKNOWN' && ' · Métricas desta instância/processo'}
                            {scope.scope === 'MULTI_INSTANCE' && ' · Dados parciais (múltiplas instâncias)'}
                        </p>
                    </div>
                </div>
                <button
                    onClick={fetchBaseline}
                    className="flex items-center gap-2 bg-slate-900 hover:bg-black text-white px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-[2px] shadow-xl transition-all hover:-translate-y-1 active:scale-95"
                >
                    <RefreshCw className="h-4 w-4" />
                    Atualizar agora
                </button>
            </div>

            {fetchError && (
                <div className="bg-rose-50 border-2 border-rose-100 rounded-[24px] p-6 flex items-center gap-4 shadow-sm">
                    <div className="h-10 w-10 bg-rose-100 rounded-2xl flex items-center justify-center shrink-0">
                        <WifiOff className="h-5 w-5 text-rose-600" />
                    </div>
                    <div>
                        <p className="text-sm font-black text-rose-800">Falha ao atualizar métricas operacionais</p>
                        <p className="text-xs text-rose-600 mt-1">Exibindo os últimos dados carregados. Nova tentativa automática em instantes.</p>
                    </div>
                </div>
            )}

            {/* ── 2. Faixa principal de saúde (4 indicadores) ───────────────── */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {/* Circuit breaker */}
                <Card className={`flex flex-col justify-between h-40 ${anyBreakerOpen ? 'border-r-4 border-r-rose-500' : 'border-r-4 border-r-primary'}`}>
                    <div className="flex justify-between items-start">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-tight">Circuit<br />Breaker</h3>
                        <div className={`h-10 w-10 rounded-2xl flex items-center justify-center shadow-lg text-white ${anyBreakerOpen ? 'bg-rose-500' : 'bg-primary'}`}>
                            <CircleSlash className="h-5 w-5" />
                        </div>
                    </div>
                    <div>
                        <div className="text-2xl font-black text-slate-900 tracking-tighter">
                            {circuitDomains.length === 0
                                ? 'CLOSED'
                                : circuitDomains.map((d) => circuitByDomain[d].state).join(' / ')}
                        </div>
                        <p className="text-[10px] font-black text-slate-400 mt-1 uppercase tracking-widest">
                            {circuitDomains.length === 0
                                ? 'Nenhum evento registrado'
                                : openDomain
                                    ? (circuitByDomain[openDomain]?.openReason ?? 'aberto')
                                    : `${circuitDomains.length} domínio(s)`}
                        </p>
                    </div>
                </Card>

                {/* Budget agregado */}
                <Card className="flex flex-col justify-between h-40">
                    <div className="flex justify-between items-start">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-tight">Budget<br />Agregado</h3>
                        <div className="h-10 w-10 bg-slate-50 text-slate-400 rounded-2xl flex items-center justify-center">
                            <Gauge className="h-5 w-5" />
                        </div>
                    </div>
                    <div>
                        <div className="text-3xl font-black text-slate-900 tracking-tighter">
                            {fmtNum(budgetUsed)}<span className="text-lg text-slate-400 ml-1">/400</span>
                        </div>
                        <p className="text-[10px] font-black text-slate-400 mt-1 uppercase tracking-widest">Requisições / 5 min</p>
                        <UsageBar used={budgetUsed} limit={400} />
                    </div>
                </Card>

                {/* WRITE */}
                <Card className={`flex flex-col justify-between h-40 ${writeAtLimit ? 'border-r-4 border-r-amber-500' : ''}`}>
                    <div className="flex justify-between items-start">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-tight">Budget<br />WRITE</h3>
                        <div className={`h-10 w-10 rounded-2xl flex items-center justify-center ${writeAtLimit ? 'bg-amber-500 text-white' : 'bg-slate-50 text-slate-400'}`}>
                            <Zap className="h-5 w-5" />
                        </div>
                    </div>
                    <div>
                        <div className="text-3xl font-black text-slate-900 tracking-tighter">
                            {fmtNum(writeUsedMin)}<span className="text-lg text-slate-400 ml-1">/40</span>
                        </div>
                        <p className="text-[10px] font-black text-slate-400 mt-1 uppercase tracking-widest">
                            {writeBudget
                                ? `Por min · hora: ${fmtNum(writeBudget.current?.usedInHour)}/2.400`
                                : 'Sem escritas registradas ainda'}
                        </p>
                        {writeBudget && <UsageBar used={writeUsedMin} limit={40} />}
                    </div>
                </Card>

                {/* Fila LOW */}
                <Card className="flex flex-col justify-between h-40">
                    <div className="flex justify-between items-start">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-tight">Fila<br />LOW</h3>
                        <div className="h-10 w-10 bg-slate-50 text-slate-400 rounded-2xl flex items-center justify-center">
                            <ListOrdered className="h-5 w-5" />
                        </div>
                    </div>
                    <div>
                        <div className="text-3xl font-black text-slate-900 tracking-tighter">{fmtNum(backpressure.queueLowCurrent ?? 0)}</div>
                        <p className="text-[10px] font-black text-slate-400 mt-1 uppercase tracking-widest">
                            Aguardando · p95 espera: {fmtMs(backpressure.waitLow?.p95WaitMs ?? 0)}
                        </p>
                    </div>
                </Card>
            </div>

            {/* ── 3. Capacidade e pressão ───────────────────────────────────── */}
            <Card>
                <SectionTitle icon={Gauge} title="Capacidade e Pressão" subtitle="Budgets, filas HIGH/LOW e pacing" />
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                    <Stat label="Budget usado (janela)" value={`${fmtNum(b.queue?.rateLimitUsage?.current)} / 400`} sub={`máx ${fmtNum(b.queue?.rateLimitUsage?.max)} · mín ${fmtNum(b.queue?.rateLimitUsage?.min)}`} />
                    <Stat label="Budget restante" value={fmtNum(b.queue?.rateLimitRemaining?.current)} sub={`snapshots: ${fmtNum(b.queue?.snapshotCount)}`} />
                    <Stat label="WRITE / min" value={writeBudget ? `${fmtNum(writeUsedMin)} / 40` : '—'} sub={writeBudget ? `restante: ${fmtNum(writeBudget.current?.remainingInMinute)}` : 'sem escritas ainda'} />
                    <Stat label="WRITE / hora" value={writeBudget ? `${fmtNum(writeBudget.current?.usedInHour)} / 2.400` : '—'} sub={writeBudget ? `restante: ${fmtNum(writeBudget.current?.remainingInHour)}` : 'sem escritas ainda'} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    {(['High', 'Low'] as const).map((p) => (
                        <div key={p} className="bg-slate-50/80 rounded-2xl p-5">
                            <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Fila {p.toUpperCase()}</div>
                            <div className="grid grid-cols-3 gap-3 text-sm">
                                <div><span className="block text-[9px] font-black text-slate-400 uppercase">Atual</span><span className="font-black text-slate-900">{fmtNum(backpressure[`queue${p}Current`] ?? 0)}</span></div>
                                <div><span className="block text-[9px] font-black text-slate-400 uppercase">Pico</span><span className="font-black text-slate-900">{fmtNum(backpressure[`peak${p}`] ?? 0)}</span></div>
                                <div><span className="block text-[9px] font-black text-slate-400 uppercase">Mais antigo</span><span className="font-black text-slate-900">{fmtMs(backpressure[`oldestWaiterAgeMs${p}`] ?? 0)}</span></div>
                                <div><span className="block text-[9px] font-black text-slate-400 uppercase">Grants</span><span className="font-black text-slate-900">{fmtNum(backpressure[`wait${p}`]?.grantedCount ?? 0)}</span></div>
                                <div><span className="block text-[9px] font-black text-slate-400 uppercase">Espera média</span><span className="font-black text-slate-900">{fmtMs(backpressure[`wait${p}`]?.avgWaitMs ?? 0)}</span></div>
                                <div><span className="block text-[9px] font-black text-slate-400 uppercase">Espera p95</span><span className="font-black text-slate-900">{fmtMs(backpressure[`wait${p}`]?.p95WaitMs ?? 0)}</span></div>
                                <div><span className="block text-[9px] font-black text-slate-400 uppercase">QueueFull</span><span className={`font-black ${(backpressure[`queue${p}RejectedFull`] ?? 0) > 0 ? 'text-amber-600' : 'text-slate-900'}`}>{fmtNum(backpressure[`queue${p}RejectedFull`] ?? 0)}</span></div>
                                <div><span className="block text-[9px] font-black text-slate-400 uppercase">QueueTimeout</span><span className={`font-black ${(backpressure[`queue${p}Expired`] ?? 0) > 0 ? 'text-amber-600' : 'text-slate-900'}`}>{fmtNum(backpressure[`queue${p}Expired`] ?? 0)}</span></div>
                            </div>
                        </div>
                    ))}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                    <Stat label="Espera geral p50" value={fmtMs(b.queue?.waitMs?.p50 ?? 0)} />
                    <Stat label="Espera geral p95" value={fmtMs(b.queue?.waitMs?.p95 ?? 0)} />
                    <Stat label="Espera geral p99" value={fmtMs(b.queue?.waitMs?.p99 ?? 0)} />
                    <Stat label="Espera geral máx" value={fmtMs(b.queue?.waitMs?.max ?? 0)} />
                </div>
                {lowPacing && (
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                        <Stat label="Pacing LOW · esperas" value={fmtNum(lowPacing.waitCount)} />
                        <Stat label="Pacing LOW · média" value={fmtMs(lowPacing.avgWaitMs)} />
                        <Stat label="Pacing LOW · máx" value={fmtMs(lowPacing.maxWaitMs)} />
                        <Stat label="Ocupação última" value={lowPacing.waitCount > 0 ? `${lowPacing.lastOccupancyPct}%` : '—'} />
                        <Stat label="Última aplicação" value={fmtDateTime(lowPacing.lastAppliedAt)} />
                    </div>
                )}
            </Card>

            {/* ── 4. Resiliência ────────────────────────────────────────────── */}
            <Card>
                <SectionTitle icon={Repeat} title="Resiliência" subtitle="Retries, erros e circuit breaker" />
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
                    <Stat label="Retries (total)" value={fmtNum(retry.total ?? 0)} />
                    <Stat label="Sucesso após retry" value={fmtNum(retry.succeeded ?? 0)} />
                    <Stat label="Esgotados" value={<span className={(retry.exhausted ?? 0) > 0 ? 'text-amber-600' : ''}>{fmtNum(retry.exhausted ?? 0)}</span>} />
                    <Stat label="Retry-After honrados" value={fmtNum(retry.retryAfterWaits ?? 0)} />
                    <Stat label="Retry-After total" value={fmtMs(retry.retryAfterWaitMsTotal ?? 0)} />
                </div>
                {retry.byClassification && Object.keys(retry.byClassification).length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-4">
                        {Object.entries(retry.byClassification).map(([k, v]) => (
                            <span key={k} className="px-3 py-1.5 rounded-xl bg-slate-100 text-slate-700 text-[10px] font-black uppercase tracking-widest">
                                {k}: {fmtNum(v as number)}
                            </span>
                        ))}
                    </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-slate-50/80 rounded-2xl p-5">
                        <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Erros por status</div>
                        {b.errors && Object.keys(b.errors).length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                                {Object.entries(b.errors).map(([k, v]) => (
                                    <span key={k} className="px-3 py-1.5 rounded-xl bg-rose-50 text-rose-700 border border-rose-100 text-[10px] font-black uppercase tracking-widest">
                                        {k}: {fmtNum(v as number)}
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <p className="text-xs font-bold text-slate-400">Nenhum erro registrado na janela atual.</p>
                        )}
                    </div>
                    <div className="bg-slate-50/80 rounded-2xl p-5">
                        <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Circuit breaker por domínio</div>
                        {circuitDomains.length === 0 ? (
                            <p className="text-xs font-bold text-slate-400">Nenhum evento de breaker — estado efetivo CLOSED.</p>
                        ) : (
                            <div className="space-y-3">
                                {circuitDomains.map((d) => {
                                    const c = circuitByDomain[d];
                                    return (
                                        <div key={d} className="text-xs">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="font-mono font-bold text-slate-700">{d}</span>
                                                <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black uppercase ${c.state === 'OPEN' ? 'bg-rose-500 text-white' : c.state === 'HALF_OPEN' ? 'bg-slate-200 text-slate-700' : 'bg-primary/10 text-primary'}`}>
                                                    {c.state}
                                                </span>
                                                {c.openReason && <span className="text-slate-500 font-bold">{c.openReason}</span>}
                                            </div>
                                            <div className="text-slate-400 font-bold mt-1">
                                                falhas consecutivas: {fmtNum(c.consecutiveFailures)} · fast-fails: {fmtNum(c.fastFails)} ·
                                                probes: {fmtNum(c.probesStarted)} ({fmtNum(c.probesSucceeded)} ok / {fmtNum(c.probesFailed)} falha)
                                                {c.cooldownMs != null && ` · cooldown: ${fmtMs(c.cooldownMs)}`}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </Card>

            {/* ── 5. Sincronização ──────────────────────────────────────────── */}
            <Card>
                <SectionTitle icon={Layers} title="Sincronização" subtitle="Polling, guard de concorrência, slot sync, dedup e duplicatas" />
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
                    <Stat label="Clínicas em polling" value={fmtNum(b.polling?.clinicsPolled ?? 0)} />
                    <Stat label="Polls concluídos" value={fmtNum(b.polling?.totalCompletedPolls ?? 0)} />
                    <Stat label="Polls ativos" value={fmtNum(b.polling?.totalActivePolls ?? 0)} />
                    <Stat label="Sobreposições" value={<span className={(b.polling?.OVERLAPPING_POLL_COUNT ?? 0) > 0 ? 'text-amber-600' : ''}>{fmtNum(b.polling?.OVERLAPPING_POLL_COUNT ?? 0)}</span>} />
                    <Stat label="Máx. concorrentes" value={fmtNum(b.polling?.MAX_CONCURRENT_POLLS ?? 0)} />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                    <Stat label="Slot Sync total" value={fmtNum(b.slotSync?.totalEvents ?? 0)} />
                    <Stat label="Slot Sync enviados" value={fmtNum(b.slotSync?.pushed ?? 0)} />
                    <Stat label="Slot Sync sem mudança" value={fmtNum(b.slotSync?.skippedUnchanged ?? 0)} />
                    <Stat label="GETs deduplicados" value={fmtNum(b.dedup?.DOCTORALIA_DEDUPED_GET_COUNT ?? 0)} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-slate-50/80 rounded-2xl p-5">
                        <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Guard de concorrência (skips)</div>
                        {cgNonZero.length === 0 ? (
                            <p className="text-xs font-bold text-slate-400">Nenhum bloqueio por concorrência na janela atual.</p>
                        ) : (
                            <div className="flex flex-wrap gap-2">
                                {cgNonZero.map(([k, v]) => (
                                    <span key={k} className="px-3 py-1.5 rounded-xl bg-slate-100 text-slate-700 text-[10px] font-black tracking-wide font-mono">
                                        {k}: {fmtNum(v)}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                    <div className="bg-slate-50/80 rounded-2xl p-5">
                        <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                            <Copy className="h-3 w-3" /> Duplicatas potenciais: {fmtNum(b.duplicates?.POTENTIAL_DUPLICATE_REQUEST_COUNT ?? 0)}
                        </div>
                        {(b.duplicates?.recentDuplicates ?? []).length === 0 ? (
                            <p className="text-xs font-bold text-slate-400">Nenhuma duplicata detectada na janela atual.</p>
                        ) : (
                            <ul className="space-y-1 max-h-40 overflow-auto">
                                {b.duplicates.recentDuplicates.map((d: any, i: number) => (
                                    <li key={i} className="text-[10px] font-mono text-slate-500 break-all">
                                        {d.method} {d.operation} · {d.origin} · {fmtDateTime(new Date(d.recordedAt).toISOString())}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            </Card>

            {/* ── 6. Experiência do usuário ─────────────────────────────────── */}
            <Card>
                <SectionTitle icon={Users} title="Experiência do Usuário" subtitle="Chamadas USER_INTERACTIVE (agendamentos e ações na UI)" />
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4">
                    <Stat label="Requests" value={fmtNum(appointments.totalRequests ?? 0)} />
                    <Stat label="Espera média" value={fmtMs(appointments.avgWaitMs ?? 0)} />
                    <Stat label="Espera p95" value={fmtMs(appointments.p95WaitMs ?? 0)} />
                    <Stat label="Espera p99" value={fmtMs(appointments.p99WaitMs ?? 0)} />
                    <Stat label="Execução média" value={fmtMs(appointments.avgExecMs ?? 0)} />
                    <Stat label="Execução p95" value={fmtMs(appointments.p95ExecMs ?? 0)} />
                    <Stat label="Timeouts" value={<span className={(appointments.timeouts ?? 0) > 0 ? 'text-rose-600' : ''}>{fmtNum(appointments.timeouts ?? 0)}</span>} />
                    <Stat label="Erros" value={<span className={(appointments.errors ?? 0) > 0 ? 'text-rose-600' : ''}>{fmtNum(appointments.errors ?? 0)}</span>} />
                </div>
                {(appointments.totalRequests ?? 0) === 0 && (
                    <p className="text-xs font-bold text-slate-400 mt-4">Nenhuma chamada interativa registrada na janela atual — estado normal fora de horário de uso.</p>
                )}
            </Card>

            {/* ── 7. Clínicas (drill-down sob demanda) ──────────────────────── */}
            <Card>
                <SectionTitle icon={Building2} title="Clínicas" subtitle="Status detalhado carregado sob demanda — drill-down na Central de Sincronização" />
                {clinics.length === 0 ? (
                    <p className="text-xs font-bold text-slate-400">Nenhuma clínica cadastrada.</p>
                ) : (
                    <div className="divide-y divide-slate-100">
                        {clinics.map((clinic) => {
                            const expanded = expandedClinicId === clinic.id;
                            const st = clinicStatus[clinic.id];
                            return (
                                <div key={clinic.id} className="py-3">
                                    <div className="flex items-center justify-between gap-4">
                                        <button onClick={() => toggleClinic(clinic.id)} className="flex items-center gap-3 text-left flex-1 group">
                                            <div className="h-10 w-10 rounded-2xl bg-white shadow-sm border border-slate-100 flex items-center justify-center text-primary shrink-0">
                                                <Building2 className="h-5 w-5" />
                                            </div>
                                            <div>
                                                <span className="font-black text-slate-900 tracking-tight text-sm">{clinic.name}</span>
                                                <span className={`ml-3 inline-flex px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest ${clinic.active ? 'bg-emerald-50 text-primary' : 'bg-slate-100 text-slate-400'}`}>
                                                    {clinic.active ? 'Ativa' : 'Desativada'}
                                                </span>
                                            </div>
                                            {expanded ? <ChevronUp className="h-4 w-4 text-slate-400 ml-auto" /> : <ChevronDown className="h-4 w-4 text-slate-400 ml-auto" />}
                                        </button>
                                        <Link
                                            href="/sync"
                                            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest transition-colors shrink-0"
                                        >
                                            Central de Sincronização <ArrowUpRight className="h-3.5 w-3.5" />
                                        </Link>
                                    </div>
                                    {expanded && (
                                        <div className="mt-3 ml-13 pl-13">
                                            {clinicStatusLoading === clinic.id ? (
                                                <div className="flex items-center gap-2 text-xs font-bold text-slate-400 py-2">
                                                    <Loader2 className="h-4 w-4 animate-spin" /> Carregando status da clínica...
                                                </div>
                                            ) : st?._error ? (
                                                <p className="text-xs font-bold text-rose-500 py-2">Falha ao carregar o status desta clínica.</p>
                                            ) : st ? (
                                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                                    <Stat label="Saúde" value={<span className="uppercase text-sm">{st.health === 'healthy' ? 'Saudável' : st.health === 'warning' ? 'Atenção' : st.health === 'error' ? 'Erro' : 'Nunca sincronizada'}</span>} />
                                                    <Stat label="Taxa de sucesso" value={`${st.successRate ?? 0}%`} />
                                                    <Stat label="Médicos pareados" value={fmtNum(st.doctors?.mapped ?? 0)} />
                                                    <Stat label="Última sync" value={<span className="text-sm">{st.lastSync ? fmtDateTime(st.lastSync.startedAt) : '—'}</span>} />
                                                </div>
                                            ) : null}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </Card>

            {/* Nota de escopo de instância */}
            {scope.note && (
                <p className="text-[10px] font-bold text-slate-400 text-center px-4 pb-4">
                    <Timer className="h-3 w-3 inline mr-1" />
                    {scope.note} As métricas não são um histórico permanente — representam a janela desde o último restart ou reset.
                </p>
            )}
        </div>
    );
}
