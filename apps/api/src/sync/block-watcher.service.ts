import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { VismedService } from '../integrations/vismed/vismed.service';
import { DocplannerService } from '../integrations/docplanner.service';
import { SlotSyncService } from './slot-sync.service';

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
 * O snapshot é em memória: após um restart, o primeiro ciclo trata os médicos atualmente
 * bloqueados como "mudados" e re-sincroniza uma vez (barato e seguro). A lógica incremental
 * por hash do slot-sync (SlotPushState) evita pushes redundantes quando os slots finais não mudam.
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
    ) {
        this.disabled = process.env.DISABLE_BLOCK_WATCHER === 'true';
    }

    onModuleInit() {
        if (this.disabled) {
            this.logger.warn('[BLOCK-WATCHER] Vigia de bloqueios DESATIVADO via DISABLE_BLOCK_WATCHER=true.');
        } else {
            this.logger.log('[BLOCK-WATCHER] Vigia de bloqueios ATIVO — checa bloqueios VisMed a cada 10 minutos (cron: */10 * * * *) e dispara re-sync direcionado de slots.');
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

        const idEmpresaGestora = vismedConn.clientId ? Number(vismedConn.clientId) : 286;
        const baseUrl = vismedConn.domain || undefined;

        // Se o fetch falhar, lança → o try/catch do chamador pula a clínica SEM atualizar o
        // snapshot (evita tratar erro de rede como "bloqueios removidos").
        const blocks = await this.vismed.getBloqueiosProfissional(idEmpresaGestora, baseUrl);

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
                const res = await this.slotSync.syncSlotsForDoctor(doctor.id, client, undefined, 30, clinicId);
                this.logger.log(`[BLOCK-WATCHER] ${doctor.name}: ${res.message}`);
            } catch (err: any) {
                this.logger.error(`[BLOCK-WATCHER] Falha re-sync idprofissional ${idprofissional}: ${err?.message} — manterá detecção no próximo ciclo.`);
                this.rollbackForRetry(committed, currentHashes, prevHashes, idprofissional);
            }
        }

        this.snapshots.set(clinicId, committed);
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
