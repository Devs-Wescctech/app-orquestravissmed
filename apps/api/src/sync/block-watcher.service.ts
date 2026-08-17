import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { VismedService } from '../integrations/vismed/vismed.service';
import { DocplannerService } from '../integrations/docplanner.service';
import { SlotSyncService } from './slot-sync.service';
import { runWithDoctoraliaContext } from '../metrics/doctoralia-call-context';
import { ClinicConcurrencyGuard } from '../bookings/clinic-concurrency-guard';
import { getDoctoraliaMetricsService, concurrencyActorOf } from '../metrics/doctoralia-metrics.service';
import { AdminBlockBreakService } from './admin-block-break.service';
import { VismedBlockPeriodAuditService } from './vismed-block-period-audit.service';
import { VismedAvailabilityService } from './vismed-availability.service';
import type { BlockPeriod } from './vismed-block-period-parser';

/**
 * Vigia leve de bloqueios de agenda (fast-lane, a cada 10min).
 *
 * Por que existe: o sync global (cron 30min) é pesado (full VisMed + full Doctoralia +
 * dicionários + matching + ~especialidades×30dias chamadas scheduleDay). Rodá-lo a cada 10min
 * seria caro. Já o endpoint `bloqueios-profissional` é 1 chamada baratíssima por clínica, então
 * serve como DETECTOR DE MUDANÇA de bloqueios: a cada 10min comparamos o snapshot dos bloqueios
 * e, só quando algo muda para um médico, disparamos um re-sync de slots DIRECIONADO àquele médico
 * (que recalcula a disponibilidade real via scheduleDay — fonte limpa). Assim ganhamos
 * responsividade de ~10min para bloqueios sem o custo do sync completo.
 *
 * WP1: o snapshot é agora persistido no banco (AdminBlockBreak com addressId='').
 * Na recuperação pós-restart, o primeiro ciclo restaura o snapshot do banco, evitando
 * que todos os médicos bloqueados sejam tratados como "alterados" desnecessariamente.
 *
 * Kill switch: env DISABLE_BLOCK_WATCHER=true.
 */
@Injectable()
export class BlockWatcherService implements OnModuleInit {
    private readonly logger = new Logger(BlockWatcherService.name);

    private readonly disabled: boolean;

    private isRunning = false;

    // clinicId -> (idprofissional -> hash dos bloqueios desse médico)
    private snapshots = new Map<string, Map<number, string>>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly vismed: VismedService,
        private readonly docplanner: DocplannerService,
        private readonly slotSync: SlotSyncService,
        private readonly concurrencyGuard: ClinicConcurrencyGuard,
        private readonly adminBlockBreak: AdminBlockBreakService,
        private readonly blockPeriodAudit: VismedBlockPeriodAuditService,
        private readonly availabilityService: VismedAvailabilityService,
    ) {
        this.disabled = process.env.DISABLE_BLOCK_WATCHER === 'true';
    }

    async onModuleInit() {
        if (this.disabled) {
            this.logger.warn('[BLOCK-WATCHER] Vigia de bloqueios DESATIVADO via DISABLE_BLOCK_WATCHER=true.');
            return;
        }
        this.logger.log('[BLOCK-WATCHER] Vigia de bloqueios ATIVO — checa bloqueios VisMed a cada 10 minutos (cron: */10 * * * *) e dispara re-sync direcionado de slots.');
        // WP1: restaura snapshot persistido para evitar falso-positivo pós-restart.
        try {
            this.snapshots = await this.adminBlockBreak.loadAllSnapshots();
            const clinicCount = this.snapshots.size;
            let doctorCount = 0;
            for (const m of this.snapshots.values()) doctorCount += m.size;
            this.logger.log(`[BLOCK-WATCHER] Snapshot restaurado do banco: ${clinicCount} clínica(s), ${doctorCount} médico(s) com bloqueios activos.`);
        } catch (err: any) {
            this.logger.warn(`[BLOCK-WATCHER] Falha ao restaurar snapshot do banco (continuando sem restauração): ${err?.message}`);
        }
    }

    @Cron('*/10 * * * *', { name: 'block-watcher-every-10min', timeZone: 'America/Sao_Paulo' })
    async watchAllClinics() {
        if (this.disabled) return;
        if (this.isRunning) {
            this.logger.warn('[BLOCK-WATCHER] Ciclo anterior ainda em andamento — pulando esta janela.');
            return;
        }

        this.isRunning = true;
        const startedAt = Date.now();
        try {
            const clinics = await this.prisma.clinic.findMany({
                where: { active: true },
                select: { id: true, name: true },
            });
            for (const clinic of clinics) {
                try {
                    await this.watchClinic(clinic.id, clinic.name);
                } catch (err: any) {
                    this.logger.error(`[BLOCK-WATCHER] Falha na clínica "${clinic.name}": ${err?.message}`);
                }
            }
        } catch (err: any) {
            this.logger.error(`[BLOCK-WATCHER] Erro inesperado no ciclo: ${err?.message}`, err?.stack);
        } finally {
            this.isRunning = false;
            this.logger.debug(`[BLOCK-WATCHER] Ciclo concluído em ${Date.now() - startedAt}ms.`);
        }
    }

    /** Hash estável do conjunto de bloqueios de UM médico (ordenado p/ determinismo). */
    private hashBlocks(blocks: any[]): string {
        const norm = blocks
            .map(b => ({
                d: String(b.dataagendamento ?? ''),
                i: String(b.horarioagendamento ?? ''),
                f: String(b.horarioagendamentofinal ?? ''),
            }))
            .sort((a, b) => (a.d + a.i + a.f).localeCompare(b.d + b.i + b.f));
        return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex');
    }

    /**
     * Analisa o período de um bloqueio VisMed raw em datas normalizadas.
     * - Início malformado → retorna null (bloco ignorado).
     * - Fim malformado → fallback de +30 min sobre o início.
     * Nota: parsing detalhado (WP2) refinará esta lógica; aqui usamos inline guard básico.
     */
    private parseBlockPeriod(block: any): { start: Date; end: Date } | null {
        const date = String(block.dataagendamento ?? '');
        const timeI = String(block.horarioagendamento ?? '');
        const timeF = String(block.horarioagendamentofinal ?? '');

        const start = new Date(`${date}T${timeI}:00-03:00`);
        if (isNaN(start.getTime())) return null;

        const end = new Date(`${date}T${timeF}:00-03:00`);
        return { start, end: isNaN(end.getTime()) ? new Date(start.getTime() + 30 * 60_000) : end };
    }

    private async watchClinic(clinicId: string, clinicName: string) {
        // Não competir com o sync global em andamento — ele já recalcula slots dessa clínica.
        const running = await this.prisma.syncRun.count({ where: { clinicId, status: 'running' } });
        if (running > 0) {
            this.logger.debug(`[BLOCK-WATCHER] Clínica "${clinicName}": sync global em andamento — pulando vigia.`);
            return;
        }

        const vismedConn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'vismed' },
        });
        const doctoraliaConn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia' },
        });
        // Sem integração completa não há o que sincronizar.
        if (!vismedConn || !doctoraliaConn) return;

        // Respeita a pausa da Central de Sincronização: clínica pausada não deve gerar
        // NENHUMA requisição à Doctoralia (inclusive OAuth) até ser retomada.
        if (vismedConn.status === 'paused' || doctoraliaConn.status === 'paused') {
            this.logger.debug(`[BLOCK-WATCHER] Clínica "${clinicName}": fila pausada — pulando vigia de bloqueios.`);
            return;
        }

        const idEmpresaGestora = vismedConn.clientId ? Number(vismedConn.clientId) : 286;
        const baseUrl = vismedConn.domain || undefined;

        // WP-04: exclusão mútua por clínica — SLOT_SYNC nunca roda junto com
        // GLOBAL_SYNC/POLLING/SAFETY_SWEEP (ou outro SLOT_SYNC) da mesma clínica.
        // O acquire cobre do fetch de bloqueios ao commit do snapshot. No SKIP não
        // tocamos o snapshot: o próximo ciclo (10min) redetecta e tenta de novo.
        // O check de syncRun 'running' acima permanece como pré-filtro barato.
        // NÃO adquirir dentro do SlotSyncService — o Global Sync o chama internamente
        // e se auto-bloquearia.
        if (!this.concurrencyGuard.tryAcquire(clinicId, 'SLOT_SYNC')) {
            // Task 133: reserva de prioridade do Global Sync tem motivo próprio
            const blockReason = this.concurrencyGuard.getBlockReason(clinicId);
            if (blockReason === 'GLOBAL_SYNC_PENDING') {
                this.logger.warn(`[BLOCK-WATCHER] SLOT_SYNC_SKIPPED_GLOBAL_SYNC_PENDING clinicId=${clinicId} — Global Sync aguardando prioridade, vigia descartado (snapshot intacto)`);
                try { getDoctoraliaMetricsService()?.recordConcurrencySkip('SLOT_SYNC_SKIPPED_GLOBAL_SYNC_PENDING', clinicId); } catch (_e) {}
                return;
            }
            const blocker = concurrencyActorOf(blockReason ?? 'SLOT_SYNC');
            this.logger.warn(`[BLOCK-WATCHER] SLOT_SYNC_SKIPPED_${blocker}_ACTIVE clinicId=${clinicId} — ${blocker} em andamento, vigia descartado (snapshot intacto)`);
            try { getDoctoraliaMetricsService()?.recordConcurrencySkip(`SLOT_SYNC_SKIPPED_${blocker}_ACTIVE`, clinicId); } catch (_e) {}
            return;
        }
        try {
            await this.watchClinicLocked(clinicId, clinicName, idEmpresaGestora, baseUrl, doctoraliaConn);
        } finally {
            // WP-04: liberar guard em qualquer cenário
            this.concurrencyGuard.release(clinicId, 'SLOT_SYNC');
        }
    }

    /** Corpo do vigia executado JÁ com o guard SLOT_SYNC adquirido. */
    private async watchClinicLocked(clinicId: string, clinicName: string, idEmpresaGestora: number, baseUrl: string | undefined, doctoraliaConn: any) {
        // Se o fetch falhar, lança → o try/catch do chamador pula a clínica SEM atualizar o
        // snapshot (evita tratar erro de rede como "bloqueios removidos").
        const blocks = await this.vismed.getBloqueiosProfissional(idEmpresaGestora, baseUrl);

        // WP2: Audita períodos irrecuperáveis de cada bloqueio fetched.
        // O parser puro detecta malformações em horarioagendamento/horarioagendamentofinal
        // (ex.: "011:0", "012:0"). Períodos inválidos ficam visíveis no AuditLog
        // (action=BLOCK_PERIOD_UNRECOVERABLE) em vez de serem silenciados.
        // Dedup em memória evita INSERTs repetidos a cada ciclo de 10min.
        //
        // Para bloqueios com período VÁLIDO, também colhemos a faixa normalizada
        // para o verificador auxiliar de consistência (vs. scheduleDay).
        // validByProfDate: Map<idprofissional, { date, period, blockId }[]>
        const validByProfDate = new Map<number, Array<{ date: string; period: BlockPeriod; blockId?: any }>>();

        for (const b of blocks) {
            const idprofissional = Number(b?.idprofissional);
            if (!Number.isFinite(idprofissional)) continue;
            const date = String(b?.dataagendamento ?? '').substring(0, 10); // YYYY-MM-DD
            const parsedPeriod = await this.blockPeriodAudit.parseWithAudit(
                {
                    blockId: b?.idbloqueio ?? undefined,
                    date,
                    startRaw: String(b?.horarioagendamento ?? ''),
                    endRaw: String(b?.horarioagendamentofinal ?? ''),
                },
                { clinicId, clinicName, idprofissional },
            );
            if (parsedPeriod !== null) {
                if (!validByProfDate.has(idprofissional)) validByProfDate.set(idprofissional, []);
                validByProfDate.get(idprofissional)!.push({ date, period: parsedPeriod, blockId: b?.idbloqueio });
            }
        }

        // Agrupa por idprofissional e calcula hash por médico.
        const byDoctor = new Map<number, any[]>();
        for (const b of blocks) {
            const id = Number(b?.idprofissional);
            if (!Number.isFinite(id)) continue;
            if (!byDoctor.has(id)) byDoctor.set(id, []);
            byDoctor.get(id)!.push(b);
        }
        const currentHashes = new Map<number, string>();
        for (const [id, list] of byDoctor) currentHashes.set(id, this.hashBlocks(list));

        const prevHashes = this.snapshots.get(clinicId) ?? new Map<number, string>();

        // Médicos afetados = qualquer um cujo hash mudou (inclui bloqueio adicionado E removido).
        const affected = new Set<number>();
        for (const [id, h] of currentHashes) {
            if (prevHashes.get(id) !== h) affected.add(id);
        }
        for (const [id, h] of prevHashes) {
            if (currentHashes.get(id) !== h) affected.add(id);
        }

        if (affected.size === 0) {
            this.snapshots.set(clinicId, currentHashes);
            return;
        }

        this.logger.log(`[BLOCK-WATCHER] Clínica "${clinicName}": ${affected.size} médico(s) com mudança de bloqueio — re-sync direcionado de slots.`);

        const client = this.docplanner.createClient(
            doctoraliaConn.domain || 'www.doctoralia.com.br',
            doctoraliaConn.clientId,
            doctoraliaConn.clientSecret || '',
        );

        // Estado-alvo do snapshot. Só commitamos a mudança de um médico se o disparo do re-sync
        // não estourar exceção; numa exceção (transitório/inesperado) mantemos o hash ANTERIOR para
        // que a mudança seja redetectada e re-tentada no próximo ciclo (10min). Falhas "graciosas"
        // de push (success:false, ex.: endereço Doctoralia falhou) NÃO estouram aqui — já são
        // re-tentadas pelo SlotPushState no sync global (o estado de push só avança em sucesso).
        const committed = new Map(currentHashes);

        // WP-01-A: envolve chamadas Doctoralia do re-sync com contexto ALS SLOT_SYNC
        // para que apareçam como origem correta no baseline (não como OTHER).
        for (const idprofissional of affected) {
            try {
                const doctor = await this.prisma.vismedDoctor.findUnique({
                    where: { vismedId: idprofissional },
                    select: { id: true, name: true },
                });
                if (!doctor) {
                    this.logger.warn(`[BLOCK-WATCHER] idprofissional ${idprofissional} sem VismedDoctor correspondente — pulando.`);
                    continue;
                }
                const res = await runWithDoctoraliaContext(
                    { origin: 'SLOT_SYNC', clinicId },
                    () => this.slotSync.syncSlotsForDoctor(doctor.id, client, undefined, 30, clinicId),
                );
                this.logger.log(`[BLOCK-WATCHER] ${doctor.name}: ${res.message}`);
            } catch (err: any) {
                this.logger.error(`[BLOCK-WATCHER] Falha re-sync idprofissional ${idprofissional}: ${err?.message} — manterá detecção no próximo ciclo.`);
                this.rollbackForRetry(committed, currentHashes, prevHashes, idprofissional);
            }
        }

        this.snapshots.set(clinicId, committed);

        // WP1: persiste e reconcilia o snapshot no banco.
        // É aguardado (não fire-and-forget) para garantir que uma escrita de um ciclo
        // anterior não sobrescreva o estado de um ciclo posterior.
        // Falha na persistência não afeta o fluxo de re-sync: apenas loga o erro.
        try {
            await this.persistBlockSnapshot(clinicId, doctoraliaConn, byDoctor, committed, prevHashes);
        } catch (err: any) {
            this.logger.error(`[BLOCK-WATCHER] Falha ao persistir snapshot no banco: ${err?.message}`);
        }

        // WP2: verificador auxiliar de consistência (best-effort, não bloqueia o fluxo).
        if (validByProfDate.size > 0) {
            this.runConsistencyChecks(clinicId, idEmpresaGestora, baseUrl, validByProfDate).catch(
                (err: any) => this.logger.warn(`[BLOCK-WATCHER] Falha no verificador de consistência (não-crítico): ${err?.message}`),
            );
        }
    }

    /**
     * WP1 — Usa addressId='' como sentinela: esses registros representam o snapshot do
     * BlockWatcher e ainda não têm endereço Doctoralia vinculado (WP3 fará isso).
     */
    private async persistBlockSnapshot(
        clinicId: string,
        doctoraliaConn: any,
        byDoctor: Map<number, any[]>,
        committed: Map<number, string>,
        prevHashes: Map<number, string>,
    ): Promise<void> {
        const facilityId = doctoraliaConn?.facilityId || '';

        // Upsert blocos de médicos ativos no committed + reconcilia chaves obsoletas.
        for (const [idprofissional, doctorBlocks] of byDoctor) {
            if (!committed.has(idprofissional)) continue; // re-sync falhou — não persistir

            const validBlocks: Array<{ dataagendamento: string; horarioagendamento: string }> = [];

            for (const block of doctorBlocks) {
                const period = this.parseBlockPeriod(block);
                if (!period) continue; // início malformado — pular
                const dataagendamento = String(block.dataagendamento ?? '');
                const horarioagendamento = String(block.horarioagendamento ?? '');
                await this.adminBlockBreak.upsert({
                    clinicId,
                    idprofissional,
                    dataagendamento,
                    horarioagendamento,
                    addressId: '',
                    rawEndTime: String(block.horarioagendamentofinal ?? ''),
                    periodStart: period.start,
                    periodEnd: period.end,
                    facilityId,
                });
                validBlocks.push({ dataagendamento, horarioagendamento });
            }

            // Cancela blocos individuais que desapareceram mas o médico ainda tem outros activos
            // (ex.: A+B→B+C: A deve ser cancelado sem remover B e C).
            await this.adminBlockBreak.reconcileSnapshotForDoctor(clinicId, idprofissional, validBlocks);
        }

        // Cancela snapshot inteiro de médicos que saíram completamente (sem nenhum bloco).
        for (const [idprofissional] of prevHashes) {
            if (committed.has(idprofissional)) continue; // ainda ativo
            await this.adminBlockBreak.cancelSnapshotForDoctor(clinicId, idprofissional);
        }
    }

    /**
     * WP2 — Verificador auxiliar de consistência (não-árbitro).
     *
     * Para cada médico com bloqueios de período válido, constrói o snapshot de
     * disponibilidade real (scheduleDay) para as datas relevantes e emite alerta
     * de anomalia quando o período normalizado ainda aparece coberto.
     *
     * Nunca altera períodos, nunca bloqueia o fluxo principal (best-effort).
     * Execução envolve chamadas ao scheduleDay VisMed — proporcional ao número
     * de datas únicas com bloqueios válidos (tipicamente 1-3 por médico).
     */
    private async runConsistencyChecks(
        clinicId: string,
        _idEmpresaGestora: number,
        _baseUrl: string | undefined,
        validByProfDate: Map<number, Array<{ date: string; period: BlockPeriod; blockId?: any }>>,
    ): Promise<void> {
        for (const [idprofissional, entries] of validByProfDate) {
            try {
                // Busca as categorias (idcategoriaservico) do médico via especialidades VisMed.
                // Necessário para chamar scheduleDay, que é indexado por categoria.
                const doctor = await this.prisma.vismedDoctor.findFirst({
                    where: { vismedId: idprofissional },
                    select: {
                        id: true,
                        specialties: {
                            select: { specialty: { select: { vismedId: true } } },
                        },
                    },
                });
                if (!doctor) continue;

                const categoryIds: number[] = [
                    ...new Set(
                        (doctor.specialties || [])
                            .map((ps: any) => ps?.specialty?.vismedId)
                            .filter((v: any): v is number => Number.isInteger(v)),
                    ),
                ];
                if (categoryIds.length === 0) continue;

                // Datas únicas com bloqueios válidos para este médico
                const uniqueDates = [...new Set(entries.map(e => e.date))];

                // Constrói disponibilidade real apenas para essas datas (chamada mínima)
                const avail = await this.availabilityService.buildForCategories(
                    clinicId,
                    categoryIds,
                    uniqueDates,
                );
                if (!avail) continue;

                // Para cada bloqueio com período válido, verifica consistência vs scheduleDay
                for (const { date, period, blockId } of entries) {
                    const ranges = avail.getRanges(idprofissional, date);
                    this.blockPeriodAudit.checkAndLogConsistency(period, ranges, {
                        blockId,
                        clinicId,
                        idprofissional,
                    });
                }
            } catch (err: any) {
                this.logger.warn(
                    `[BLOCK-WATCHER] Verificador de consistência falhou para idprofissional=${idprofissional}: ${err?.message}`,
                );
            }
        }
    }

    /**
     * Após uma exceção inesperada no re-sync de um médico, mantém esse médico "pendente" no snapshot
     * para que a mudança de bloqueio seja redetectada (e re-tentada) no próximo ciclo.
     */
    private rollbackForRetry(
        committed: Map<number, string>,
        current: Map<number, string>,
        prev: Map<number, string>,
        id: number,
    ) {
        if (current.has(id)) {
            // Bloqueio presente agora: remover do committed faz o diff voltar a acusar mudança.
            committed.delete(id);
        } else {
            // Bloqueio foi removido: restaura o hash anterior para redetectar a remoção.
            const prevHash = prev.get(id);
            if (prevHash !== undefined) committed.set(id, prevHash);
            else committed.delete(id);
        }
    }
}
