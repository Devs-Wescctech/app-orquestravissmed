/**
 * WP3 — Sincronização de bloqueios administrativos VisMed → breaks Doctoralia.
 *
 * Traduz o diff POR BLOQUEIO individual (chave natural do WP1) para o ciclo de
 * vida de breaks na Doctoralia: criar (addCalendarBreak), mover (moveCalendarBreak)
 * quando o período muda, apagar (deleteCalendarBreak) quando o bloqueio some da
 * VisMed. Um bloqueio gera um break por endereço Doctoralia gerenciado do médico.
 *
 * ─── SALVAGUARDAS INVIOLÁVEIS ─────────────────────────────────────────────────
 * 1. FONTE ÚNICA DE PERÍODO: since/till vêm EXCLUSIVAMENTE do parser estrito do
 *    WP2 (`parseBlockPeriod` via `VismedBlockPeriodAuditService.parseWithAudit`)
 *    aplicado aos campos RAW da VisMed. NUNCA de `periodStart`/`periodEnd`
 *    persistidos pelo snapshot do BlockWatcher (contêm fallback +30min inventado).
 *    Parser null → NENHUM break criado/movido; caso auditado como
 *    BLOCK_PERIOD_UNRECOVERABLE e bloqueio fica "não sincronizável".
 * 2. SEM scheduleDay: este serviço NÃO consulta scheduleDay em nenhum caminho —
 *    nem para inferir, validar ou decidir períodos. Por construção, ele nem
 *    injeta o VismedAvailabilityService.
 * 3. ESCOPO RESTRITO: só opera breaks presentes na tabela AdminBlockBreak com
 *    addressId REAL. Registros-sentinela (addressId='') são snapshots de
 *    observação do BlockWatcher e permanecem intocados. Breaks do BookingSync
 *    (tabela BookingSync) e breaks desconhecidos (criados manualmente na
 *    Doctoralia) NUNCA são apagados: todo DELETE usa exclusivamente o
 *    doctoraliaBreakId persistido nesta tabela.
 * 4. RESILIÊNCIA (padrões provados no break de consultas do BookingSync):
 *    409 → adotar break remoto por match since/till ±60s; timeout/falha de rede
 *    pós-envio → reconciliar por GET antes de re-tentar.
 *
 * ─── FLAGS ────────────────────────────────────────────────────────────────────
 * ADMIN_BLOCK_BREAK_SYNC_MODE: 'off' (default) | 'shadow'
 *   - off:    serviço inerte; BlockWatcher mantém apenas o re-sync de slots atual.
 *   - shadow: computa e loga/audita o que faria, sem NENHUMA escrita na Doctoralia.
 * ADMIN_BLOCK_BREAK_SYNC_ACTIVE_CLINICS: CSV de clinicIds promovidos a 'active'
 *   (escrita real). Só tem efeito quando o modo global NÃO é 'off'.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimiterService } from '../bookings/rate-limiter.service';
import {
    AdminBlockBreakService,
    computeBlockPeriodHash,
} from './admin-block-break.service';
import { VismedBlockPeriodAuditService } from './vismed-block-period-audit.service';
import { isDoctoraliaCircuitOpenError } from '../integrations/doctoralia-circuit-breaker';
import { isDoctoraliaQueueError } from '../integrations/doctoralia-queue.errors';

export type BlockBreakSyncMode = 'off' | 'shadow' | 'active';

/** Tolerância ±60s para adoção de break remoto (mesmo padrão do BookingSync). */
const BREAK_MATCH_TOLERANCE_MS = 60_000;

export interface DoctorBlockSyncInput {
    clinicId: string;
    clinicName: string;
    idprofissional: number;
    /** Bloqueios RAW atuais da VisMed para este médico (pode ser vazio = todos removidos). */
    rawBlocks: any[];
    /** Cliente Doctoralia já criado pelo chamador. */
    client: any;
}

export interface DoctorBlockSyncResult {
    ok: boolean;
    mode: BlockBreakSyncMode;
    planned: { create: number; move: number; delete: number };
    executed: { create: number; move: number; delete: number };
    failures: number;
    skippedUnrecoverable: number;
}

interface DesiredBreak {
    dataagendamento: string;
    horarioagendamento: string;
    rawEndTime: string;
    addressId: string;
    since: string; // "YYYY-MM-DDTHH:mm:00-03:00"
    till: string;
    periodStart: Date;
    periodEnd: Date;
    periodHash: string;
}

const NOOP_RESULT = (mode: BlockBreakSyncMode): DoctorBlockSyncResult => ({
    ok: true,
    mode,
    planned: { create: 0, move: 0, delete: 0 },
    executed: { create: 0, move: 0, delete: 0 },
    failures: 0,
    skippedUnrecoverable: 0,
});

@Injectable()
export class AdminBlockBreakSyncService {
    private readonly logger = new Logger(AdminBlockBreakSyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly adminBlockBreak: AdminBlockBreakService,
        private readonly blockPeriodAudit: VismedBlockPeriodAuditService,
        private readonly rateLimiter: RateLimiterService,
    ) {}

    /**
     * Resolve o modo efetivo para uma clínica, lido do env a cada chamada
     * (permite ligar/desligar sem redeploy de código e facilita testes).
     */
    resolveMode(clinicId: string): BlockBreakSyncMode {
        const globalMode = (process.env.ADMIN_BLOCK_BREAK_SYNC_MODE || 'off').trim().toLowerCase();
        if (globalMode !== 'shadow' && globalMode !== 'active') return 'off';
        const activeList = (process.env.ADMIN_BLOCK_BREAK_SYNC_ACTIVE_CLINICS || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        if (activeList.includes(clinicId)) return 'active';
        // Modo global 'active' sem a clínica na lista continua shadow — ativação é
        // SEMPRE clínica a clínica (salvaguarda do plano).
        return 'shadow';
    }

    /**
     * Sincroniza os breaks Doctoralia de UM médico a partir dos bloqueios RAW atuais.
     * Idempotente: re-executar com o mesmo estado não gera efeitos adicionais
     * (diff vs. vínculos persistidos + adoção de duplicatas remota).
     *
     * Retorna ok=false quando alguma ação falhou de forma re-tentável — o chamador
     * (BlockWatcher) deve manter o médico "pendente" no snapshot para redetecção.
     */
    async syncDoctorBlocks(input: DoctorBlockSyncInput): Promise<DoctorBlockSyncResult> {
        const mode = this.resolveMode(input.clinicId);
        if (mode === 'off') return NOOP_RESULT('off');

        const { clinicId, clinicName, idprofissional, client } = input;

        // ── Resolve médico + mapping Doctoralia ──────────────────────────────
        const doctor = await this.prisma.vismedDoctor.findUnique({
            where: { vismedId: idprofissional },
            include: {
                unifiedMappings: {
                    where: { isActive: true },
                    include: { doctoraliaDoctor: true },
                },
            },
        });
        if (!doctor || !doctor.unifiedMappings?.length) {
            this.logger.debug(`[BLOCK-BREAK-SYNC] idprofissional=${idprofissional} sem vínculo Doctoralia — nada a sincronizar.`);
            return NOOP_RESULT(mode);
        }
        const dDoc = doctor.unifiedMappings[0].doctoraliaDoctor;
        const facilityId: string = dDoc.doctoraliaFacilityId;
        const doctorExternalId: string = dDoc.doctoraliaDoctorId;

        // ── Endereços gerenciados do médico ──────────────────────────────────
        let addressIds: string[];
        try {
            await this.rateLimiter.acquire('doctoralia');
            const res = await client.getAddresses(facilityId, doctorExternalId);
            const items: any[] = res?._items || (Array.isArray(res) ? res : []);
            addressIds = items.map((a: any) => String(a.id)).filter(Boolean);
        } catch (err: any) {
            this.logger.warn(`[BLOCK-BREAK-SYNC] Falha ao buscar endereços (idprofissional=${idprofissional}): ${err?.message} — retry no próximo ciclo.`);
            return { ...NOOP_RESULT(mode), ok: false, failures: 1 };
        }
        if (addressIds.length === 0) return NOOP_RESULT(mode);

        // ── Estado desejado: parser estrito (WP2) sobre campos RAW — fonte ÚNICA ──
        let skippedUnrecoverable = 0;
        const desired = new Map<string, DesiredBreak>(); // key: data|hora|addressId
        // Bloqueios PRESENTES na VisMed mas com período irrecuperável (parser null):
        // ficam "não sincronizáveis" — nem criados/movidos, NEM apagados. Um vínculo
        // real existente com essa chave é preservado até o bloqueio realmente
        // desaparecer da VisMed ou voltar a ter período estritamente parseável.
        const unrecoverablePresent = new Set<string>(); // key: data|hora
        for (const b of input.rawBlocks) {
            const dataagendamento = String(b?.dataagendamento ?? '');
            const date = dataagendamento.substring(0, 10);
            const horarioagendamento = String(b?.horarioagendamento ?? '');
            const rawEndTime = String(b?.horarioagendamentofinal ?? '');
            const period = await this.blockPeriodAudit.parseWithAudit(
                {
                    blockId: b?.idbloqueio ?? undefined,
                    date,
                    startRaw: horarioagendamento,
                    endRaw: rawEndTime,
                },
                { clinicId, clinicName, idprofissional },
            );
            if (period === null) {
                // Irrecuperável: já auditado (BLOCK_PERIOD_UNRECOVERABLE). Fail-safe:
                // nenhum break criado/movido; bloqueio fica "não sincronizável".
                skippedUnrecoverable++;
                unrecoverablePresent.add(`${dataagendamento}|${horarioagendamento}`);
                this.logger.warn(`[BLOCK-BREAK-SYNC] Bloqueio ${date} ${horarioagendamento} idprofissional=${idprofissional} NÃO sincronizável (período irrecuperável) — pulado (vínculo existente preservado).`);
                continue;
            }
            const since = `${date}T${period.sinceHHMM}:00-03:00`;
            const till = `${date}T${period.tillHHMM}:00-03:00`;
            const periodHash = computeBlockPeriodHash({
                horarioagendamento,
                horarioagendamentofinal: rawEndTime,
                dataagendamento,
            });
            for (const addressId of addressIds) {
                desired.set(`${dataagendamento}|${horarioagendamento}|${addressId}`, {
                    dataagendamento,
                    horarioagendamento,
                    rawEndTime,
                    addressId,
                    since,
                    till,
                    periodStart: period.since,
                    periodEnd: period.till,
                    periodHash,
                });
            }
        }

        // ── Estado atual: SOMENTE vínculos reais (addressId != '') ────────────
        // Sentinelas (addressId='') são snapshots do BlockWatcher e ficam intocados.
        const allActive = await this.adminBlockBreak.findActiveByDoctor(clinicId, idprofissional);
        const currentLinks = allActive.filter((r: any) => r.addressId !== '');
        const currentByKey = new Map<string, any>();
        for (const r of currentLinks) {
            currentByKey.set(`${r.dataagendamento}|${r.horarioagendamento}|${r.addressId}`, r);
        }

        // ── Diff por chave natural ───────────────────────────────────────────
        const toCreate: DesiredBreak[] = [];
        const toMove: Array<{ record: any; target: DesiredBreak }> = [];
        const toDelete: any[] = [];
        for (const [key, d] of desired) {
            const cur = currentByKey.get(key);
            if (!cur || !cur.doctoraliaBreakId) toCreate.push(d);
            else if (cur.periodHash !== d.periodHash) toMove.push({ record: cur, target: d });
        }
        for (const [key, r] of currentByKey) {
            if (desired.has(key)) continue;
            // FAIL-SAFE: bloqueio ainda existe na VisMed mas está irrecuperável →
            // NÃO apagar o break; falha de parsing nunca reabre agenda.
            if (unrecoverablePresent.has(`${r.dataagendamento}|${r.horarioagendamento}`)) continue;
            toDelete.push(r);
        }

        const planned = { create: toCreate.length, move: toMove.length, delete: toDelete.length };
        if (planned.create + planned.move + planned.delete === 0) {
            return { ...NOOP_RESULT(mode), skippedUnrecoverable };
        }

        // ── Shadow: apenas logs + auditoria, ZERO escrita na Doctoralia ───────
        if (mode === 'shadow') {
            for (const d of toCreate) {
                this.logger.log(`[BLOCK-BREAK-SYNC][SHADOW] criaria break ${d.since}→${d.till} addr=${d.addressId} idprofissional=${idprofissional} clínica="${clinicName}"`);
            }
            for (const { record, target } of toMove) {
                this.logger.log(`[BLOCK-BREAK-SYNC][SHADOW] moveria break ${record.doctoraliaBreakId} para ${target.since}→${target.till} addr=${target.addressId} idprofissional=${idprofissional}`);
            }
            for (const r of toDelete) {
                this.logger.log(`[BLOCK-BREAK-SYNC][SHADOW] apagaria break ${r.doctoraliaBreakId ?? '(sem id)'} ${r.dataagendamento} ${r.horarioagendamento} addr=${r.addressId} idprofissional=${idprofissional}`);
            }
            try {
                await this.prisma.auditLog.create({
                    data: {
                        action: 'ADMIN_BLOCK_BREAK_SHADOW_PLAN',
                        entity: 'admin_block_break',
                        entityId: `${clinicId}|${idprofissional}`,
                        details: {
                            clinicId,
                            idprofissional,
                            planned,
                            skippedUnrecoverable,
                            creates: toCreate.map(d => ({ addressId: d.addressId, since: d.since, till: d.till })),
                            moves: toMove.map(m => ({ breakId: m.record.doctoraliaBreakId, addressId: m.target.addressId, since: m.target.since, till: m.target.till })),
                            deletes: toDelete.map(r => ({ breakId: r.doctoraliaBreakId, addressId: r.addressId, dataagendamento: r.dataagendamento, horarioagendamento: r.horarioagendamento })),
                        },
                    },
                });
            } catch (err: any) {
                this.logger.warn(`[BLOCK-BREAK-SYNC][SHADOW] Falha ao gravar auditoria (não-crítico): ${err?.message}`);
            }
            return { ok: true, mode, planned, executed: { create: 0, move: 0, delete: 0 }, failures: 0, skippedUnrecoverable };
        }

        // ── Active: executa com os padrões de resiliência do BookingSync ──────
        const executed = { create: 0, move: 0, delete: 0 };
        let failures = 0;

        // DELETE primeiro: libera o período antes de criar novos breaks vizinhos.
        for (const r of toDelete) {
            try {
                if (r.doctoraliaBreakId) {
                    try {
                        await this.rateLimiter.acquire('doctoralia');
                        await client.deleteCalendarBreak(facilityId, doctorExternalId, r.addressId, r.doctoraliaBreakId);
                        this.logger.log(`[BLOCK-BREAK-SYNC] Break ${r.doctoraliaBreakId} apagado (bloqueio removido na VisMed).`);
                    } catch (err: any) {
                        if (!isNotFound(err)) throw err;
                        this.logger.debug(`[BLOCK-BREAK-SYNC] Break ${r.doctoraliaBreakId} já não existe (404) — apenas cancelando vínculo.`);
                    }
                }
                await this.adminBlockBreak.cancel({
                    clinicId, idprofissional,
                    dataagendamento: r.dataagendamento,
                    horarioagendamento: r.horarioagendamento,
                    addressId: r.addressId,
                });
                executed.delete++;
            } catch (err: any) {
                failures++;
                this.logger.warn(`[BLOCK-BREAK-SYNC] Falha ao apagar break ${r.doctoraliaBreakId}: ${err?.message} — retry no próximo ciclo.`);
            }
        }

        // MOVE
        for (const { record, target } of toMove) {
            try {
                const moved = await this.moveWithResilience(client, facilityId, doctorExternalId, record, target);
                if (moved === 'recreate') {
                    toCreate.push(target);
                } else {
                    await this.persistLink(clinicId, idprofissional, target, facilityId, record.doctoraliaBreakId);
                    executed.move++;
                }
            } catch (err: any) {
                failures++;
                this.logger.warn(`[BLOCK-BREAK-SYNC] Falha ao mover break ${record.doctoraliaBreakId}: ${err?.message} — retry no próximo ciclo.`);
            }
        }

        // CREATE
        for (const d of toCreate) {
            try {
                const breakId = await this.createWithResilience(client, facilityId, doctorExternalId, d);
                if (breakId) {
                    await this.persistLink(clinicId, idprofissional, d, facilityId, breakId);
                    executed.create++;
                } else {
                    failures++;
                }
            } catch (err: any) {
                failures++;
                this.logger.warn(`[BLOCK-BREAK-SYNC] Falha ao criar break ${d.since}→${d.till} addr=${d.addressId}: ${err?.message} — retry no próximo ciclo.`);
            }
        }

        this.logger.log(`[BLOCK-BREAK-SYNC] idprofissional=${idprofissional} clínica="${clinicName}": criados=${executed.create} movidos=${executed.move} apagados=${executed.delete} falhas=${failures} irrecuperáveis=${skippedUnrecoverable}`);
        return { ok: failures === 0, mode, planned, executed, failures, skippedUnrecoverable };
    }

    // ─── Resiliência (padrões do BookingSync) ────────────────────────────────

    /** POST com adoção em 409 e reconciliação por GET após timeout/queda pós-envio. */
    private async createWithResilience(client: any, facilityId: string, doctorExternalId: string, d: DesiredBreak): Promise<string | null> {
        try {
            await this.rateLimiter.acquire('doctoralia');
            const created = await client.addCalendarBreak(facilityId, doctorExternalId, d.addressId, { since: d.since, till: d.till });
            const breakId = created?.id ? String(created.id) : null;
            if (breakId) this.logger.log(`[BLOCK-BREAK-SYNC] Break ${breakId} criado ${d.since}→${d.till} addr=${d.addressId}.`);
            return breakId;
        } catch (err: any) {
            if (isConflict(err)) {
                const existingId = await this.findRemoteBreakId(client, facilityId, doctorExternalId, d.addressId, d.since, d.till);
                if (existingId) {
                    this.logger.log(`[BLOCK-BREAK-SYNC] Break remoto ${existingId} adotado (409) ${d.since}→${d.till}.`);
                    return existingId;
                }
                this.logger.warn(`[BLOCK-BREAK-SYNC] 409 ao criar break mas break remoto não localizado — retry no próximo ciclo.`);
                return null;
            }
            if ((isTimeout(err) || isNetworkFailure(err)) && !isPreSendFailure(err)) {
                // Resultado ambíguo: o POST pode ter sido aplicado. Reconciliar por GET.
                const existingId = await this.findRemoteBreakId(client, facilityId, doctorExternalId, d.addressId, d.since, d.till);
                if (existingId) {
                    this.logger.log(`[BLOCK-BREAK-SYNC] Break ${existingId} confirmado após timeout — adotado sem novo POST.`);
                    return existingId;
                }
            }
            throw err;
        }
    }

    /**
     * PATCH com: 422 "Same Date Range" → sucesso; 404 → sinaliza recriação;
     * timeout/queda pós-envio → confirma por GET do próprio break antes de falhar.
     */
    private async moveWithResilience(client: any, facilityId: string, doctorExternalId: string, record: any, target: DesiredBreak): Promise<'moved' | 'recreate'> {
        try {
            await this.rateLimiter.acquire('doctoralia');
            await client.moveCalendarBreak(facilityId, doctorExternalId, target.addressId, record.doctoraliaBreakId, { since: target.since, till: target.till });
            this.logger.log(`[BLOCK-BREAK-SYNC] Break ${record.doctoraliaBreakId} movido para ${target.since}→${target.till}.`);
            return 'moved';
        } catch (err: any) {
            const msg = String(err?.message || err);
            if (/422/.test(msg) && /Same Date Range/i.test(msg)) return 'moved';
            if (isNotFound(err)) {
                this.logger.warn(`[BLOCK-BREAK-SYNC] Break ${record.doctoraliaBreakId} não existe mais (404) — será recriado.`);
                return 'recreate';
            }
            if ((isTimeout(err) || isNetworkFailure(err)) && !isPreSendFailure(err)) {
                const confirmed = await this.confirmMoveApplied(client, facilityId, doctorExternalId, target.addressId, record.doctoraliaBreakId, target.since, target.till);
                if (confirmed) {
                    this.logger.log(`[BLOCK-BREAK-SYNC] Move do break ${record.doctoraliaBreakId} confirmado após timeout.`);
                    return 'moved';
                }
            }
            throw err;
        }
    }

    /**
     * Localiza break remoto que casa since E till dentro de ±60s.
     * 0 candidatos → null; 1 → adota; N>1 → null (ambíguo, conservador).
     */
    private async findRemoteBreakId(client: any, facilityId: string, doctorExternalId: string, addressId: string, since: string, till: string): Promise<string | null> {
        try {
            await this.rateLimiter.acquire('doctoralia');
            const list = await client.getCalendarBreaks(facilityId, doctorExternalId, addressId, since, till);
            const items: any[] = Array.isArray(list) ? list : list?._items || [list].filter(Boolean);
            const sinceTarget = new Date(since).getTime();
            const tillTarget = new Date(till).getTime();
            const candidates = items.filter(
                (b) =>
                    b?.since && Math.abs(new Date(b.since).getTime() - sinceTarget) < BREAK_MATCH_TOLERANCE_MS &&
                    b?.till && Math.abs(new Date(b.till).getTime() - tillTarget) < BREAK_MATCH_TOLERANCE_MS,
            );
            if (candidates.length === 1) return candidates[0].id ? String(candidates[0].id) : null;
            if (candidates.length > 1) {
                this.logger.warn(`[BLOCK-BREAK-SYNC] Ambíguo: ${candidates.length} breaks remotos casam ${since}→${till} — não adotando nenhum.`);
            }
            return null;
        } catch {
            return null;
        }
    }

    private async confirmMoveApplied(client: any, facilityId: string, doctorExternalId: string, addressId: string, breakId: string, since: string, till: string): Promise<boolean> {
        try {
            await this.rateLimiter.acquire('doctoralia');
            const remote = await client.getCalendarBreak(facilityId, doctorExternalId, addressId, breakId);
            if (!remote?.since || !remote?.till) return false;
            return (
                Math.abs(new Date(remote.since).getTime() - new Date(since).getTime()) < BREAK_MATCH_TOLERANCE_MS &&
                Math.abs(new Date(remote.till).getTime() - new Date(till).getTime()) < BREAK_MATCH_TOLERANCE_MS
            );
        } catch {
            return false;
        }
    }

    /** Persiste o vínculo real (addressId real + breakId). Período vem do parser estrito. */
    private async persistLink(clinicId: string, idprofissional: number, d: DesiredBreak, facilityId: string, breakId: string) {
        await this.adminBlockBreak.upsert({
            clinicId,
            idprofissional,
            dataagendamento: d.dataagendamento,
            horarioagendamento: d.horarioagendamento,
            addressId: d.addressId,
            rawEndTime: d.rawEndTime,
            periodStart: d.periodStart,
            periodEnd: d.periodEnd,
            periodHash: d.periodHash,
            facilityId,
            doctoraliaBreakId: breakId,
        });
    }
}

// ─── Classificadores de erro (mesma semântica do BookingSync) ─────────────────

function isConflict(err: any): boolean {
    return /\b409\b/.test(String(err?.message || err));
}
function isNotFound(err: any): boolean {
    return /\b404\b/.test(String(err?.message || err)) || err?.status === 404;
}
function isTimeout(err: any): boolean {
    return err?.name === 'AbortError';
}
function isNetworkFailure(err: any): boolean {
    return !isTimeout(err) && !isConflict(err) && !isNotFound(err) && typeof err?.status !== 'number' && !/\b4\d\d\b|\b5\d\d\b/.test(String(err?.message || err));
}
function isPreSendFailure(err: any): boolean {
    return isDoctoraliaQueueError(err) || isDoctoraliaCircuitOpenError(err);
}
