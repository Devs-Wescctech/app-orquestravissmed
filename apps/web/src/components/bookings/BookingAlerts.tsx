'use client';

import Link from 'next/link';
import { AlertTriangle, ArrowUpRight, Loader2, X } from 'lucide-react';
import { getAlertHeading, getAlertPresentation } from '@/lib/booking-alert-presentation';

export interface SkippedAlertDoctor {
    vismedDoctorId: string;
    doctorName: string | null;
    reason?: string;
    count: number;
    latestAt: string;
    appointments: Array<{
        id: string;
        bookingSyncId?: string;
        startAt: string;
        endAt: string;
        patientName?: string | null;
        errorMessage?: string | null;
        vismedRequestPayload?: any;
        vismedRequestUrl?: string | null;
        vismedResponse?: any;
        vismedAttemptAt?: string | null;
        syncError?: string | null;
    }>;
}

export function BookingAlerts({ skippedAlerts, dismissingAlerts, handleDismissAlerts }: {
    skippedAlerts: { total: number; doctors: SkippedAlertDoctor[] };
    dismissingAlerts: boolean;
    handleDismissAlerts: () => void;
}) {
    return (<>
            {/* Alertas com ações específicas para cada causa */}
            {skippedAlerts.total > 0 && (
                <div className="bg-amber-50/80 backdrop-blur-xl rounded-[32px] p-6 border-2 border-amber-200 shadow-lg shadow-amber-100/40 animate-in fade-in slide-in-from-top-2 duration-500">
                    <div className="flex flex-col sm:flex-row items-start justify-between gap-4">
                        <div className="flex min-w-0 items-start gap-4">
                            <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white shadow-lg shrink-0">
                                <AlertTriangle className="h-6 w-6" />
                            </div>
                            <div>
                                <h3 className="text-sm font-black text-amber-900 uppercase tracking-wide">
                                    {getAlertHeading(skippedAlerts.total, skippedAlerts.doctors)}
                                </h3>
                                <p className="text-xs font-bold text-amber-700 mt-1">
                                    Confira a causa e a ação indicada em cada ocorrência abaixo.
                                </p>
                                <div className="mt-3 flex flex-wrap gap-2">
                                    {skippedAlerts.doctors.map((d) => (
                                        <div key={`${d.vismedDoctorId}:${d.reason || ''}`} className="bg-white/70 border border-amber-200 rounded-2xl px-4 py-2.5">
                                            <div className="flex items-center gap-2">
                                                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                                                <span className="text-xs font-black text-slate-800">{d.doctorName || 'Profissional desconhecido'}</span>
                                                <span className="text-[10px] font-black text-white bg-amber-500 rounded-full px-2 py-0.5">{d.count}</span>
                                            </div>
                                            {getAlertPresentation(d.reason).needsMapping && (
                                                <div className="mt-2 space-y-1">
                                                    <p className="text-xs text-amber-800">Médico sem vínculo com a Doctoralia. Confira o profissional na <Link href="/mapping" className="underline underline-offset-2">Central de Mapeamento</Link>.</p>
                                                    <Link href="/mapping" className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-2 text-xs font-bold text-white hover:bg-amber-600">
                                                        Resolver vínculos <ArrowUpRight className="h-4 w-4" />
                                                    </Link>
                                                </div>
                                            )}
                                            {d.appointments.slice(0, 3).map((a) => {
                                                const presentation = getAlertPresentation(d.reason, `${a.errorMessage || ''} ${a.syncError || ''}`);
                                                return (
                                                <div key={a.id} className="mt-1">
                                                    <div className="text-[10px] font-bold text-amber-800/80 tabular-nums">
                                                        {new Date(a.startAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}
                                                        {a.patientName ? ` · ${a.patientName}` : ''}
                                                    </div>
                                                    <p className="text-[10px] font-black text-red-700 mt-1 uppercase">{presentation.title}</p>
                                                    <p className="text-xs text-amber-900 mt-1 max-w-sm">{presentation.description}</p>
                                                    <details className="mt-2 max-w-sm">
                                                        <summary className="cursor-pointer text-xs font-bold text-amber-800 hover:text-amber-950">Ver agendamento</summary>
                                                        <dl className="mt-2 rounded-xl bg-white p-3 text-xs text-slate-700 space-y-1">
                                                            <dt className="font-bold">Profissional</dt><dd>{d.doctorName || 'Não informado'}</dd>
                                                            <dt className="font-bold">Paciente</dt><dd>{a.patientName || 'Não informado'}</dd>
                                                            <dt className="font-bold">Início</dt><dd>{new Date(a.startAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</dd>
                                                            <dt className="font-bold">Fim</dt><dd>{new Date(a.endAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</dd>
                                                            <dt className="font-bold">Situação</dt><dd>{presentation.title}</dd>
                                                        </dl>
                                                    </details>
                                                    {d.reason === 'VISMED_CREATE_FAILED' && (a.errorMessage || a.syncError || a.vismedRequestPayload || a.vismedResponse || a.vismedAttemptAt) && (
                                                        <details className="mt-1 max-w-xs">
                                                            <summary className="text-[10px] font-black text-amber-700 cursor-pointer uppercase tracking-wide hover:text-amber-900">
                                                                Ver diagnóstico técnico
                                                            </summary>
                                                            <div className="mt-1.5 bg-slate-900 rounded-xl p-3 text-left space-y-2">
                                                                {(a.syncError || a.errorMessage) && <p className="text-[10px] text-red-300 break-words">{a.syncError || a.errorMessage}</p>}
                                                                {a.vismedAttemptAt && (
                                                                    <div className="text-[10px] text-slate-300">
                                                                        <span className="font-black text-slate-400 uppercase">Última tentativa:</span>{' '}
                                                                        {new Date(a.vismedAttemptAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
                                                                    </div>
                                                                )}
                                                                {a.vismedRequestUrl && (
                                                                    <div className="text-[10px] text-slate-300 break-all">
                                                                        <span className="font-black text-slate-400 uppercase">Endpoint:</span> {a.vismedRequestUrl}
                                                                    </div>
                                                                )}
                                                                {a.vismedRequestPayload && (
                                                                    <div>
                                                                        <div className="text-[10px] font-black text-slate-400 uppercase">Dados enviados à VissMed</div>
                                                                        <pre className="text-[9px] text-emerald-300 whitespace-pre-wrap break-all mt-0.5">{JSON.stringify(a.vismedRequestPayload, null, 1)}</pre>
                                                                    </div>
                                                                )}
                                                                {a.vismedResponse && (
                                                                    <div>
                                                                        <div className="text-[10px] font-black text-slate-400 uppercase">Resposta da VissMed</div>
                                                                        <pre className="text-[9px] text-red-300 whitespace-pre-wrap break-all mt-0.5">{JSON.stringify(a.vismedResponse, null, 1)}</pre>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </details>
                                                    )}
                                                </div>
                                            ); })}
                                            {d.count > 3 && (
                                                <div className="text-[10px] font-bold text-amber-600 mt-1">+{d.count - 3} outro{d.count - 3 > 1 ? 's' : ''}</div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-col items-end gap-2 shrink-0">
                            <button
                                onClick={handleDismissAlerts}
                                disabled={dismissingAlerts}
                                className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-amber-600 hover:text-amber-800 px-3 py-1.5 transition-colors disabled:opacity-50"
                            >
                                {dismissingAlerts ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />} Dispensar
                            </button>
                        </div>
                    </div>
                </div>
            )}

    </>);
}
