import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from './sync.service';

@Injectable()
export class SyncSchedulerService implements OnModuleInit {
    private readonly logger = new Logger(SyncSchedulerService.name);
    private readonly disabled: boolean;
    private isRunning = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly syncService: SyncService,
    ) {
        this.disabled = process.env.DISABLE_SYNC_CRON === 'true';
    }

    onModuleInit() {
        if (this.disabled) {
            this.logger.warn('[SCHEDULER] Sync cron DESATIVADO via DISABLE_SYNC_CRON=true.');
        } else {
            this.logger.log('[SCHEDULER] Sync cron ATIVO — global sync VisMed↔Doctoralia executa a cada 2 horas (cron: 0 */2 * * *).');
        }
    }

    @Cron('0 */2 * * *', { name: 'global-sync-every-2h', timeZone: 'America/Sao_Paulo' })
    async runGlobalSyncForAllClinics() {
        if (this.disabled) {
            return;
        }
        if (this.isRunning) {
            this.logger.warn('[SCHEDULER] Execução anterior ainda em andamento — pulando esta janela.');
            return;
        }

        this.isRunning = true;
        const startedAt = new Date();
        this.logger.log(`[SCHEDULER] >>> Iniciando ciclo automático de sync global (${startedAt.toISOString()})`);

        try {
            const clinics = await this.prisma.clinic.findMany({
                where: { active: true },
                select: { id: true, name: true },
            });

            if (clinics.length === 0) {
                this.logger.warn('[SCHEDULER] Nenhuma clínica ativa encontrada — nada a fazer.');
                return;
            }

            this.logger.log(`[SCHEDULER] ${clinics.length} clínica(s) ativa(s) na fila: ${clinics.map(c => c.name).join(', ')}`);

            let dispatched = 0;
            let skipped = 0;
            let failed = 0;

            for (const clinic of clinics) {
                try {
                    // Anti-overlap: pula se já existe sync rodando para essa clínica.
                    // Stale-lock recovery: runs travados em 'running' há mais de 90min são considerados
                    // abandonados (provável crash/timeout sem cleanup) e marcados como 'failed' antes
                    // de avaliar o anti-overlap, para que a clínica não fique bloqueada eternamente.
                    const STALE_THRESHOLD_MS = 90 * 60 * 1000;
                    const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
                    const stale = await this.prisma.syncRun.updateMany({
                        where: { clinicId: clinic.id, status: 'running', startedAt: { lt: staleCutoff } },
                        data: { status: 'failed', endedAt: new Date(), metrics: { error: 'abandoned by scheduler — running >90min' } },
                    });
                    if (stale.count > 0) {
                        this.logger.warn(`[SCHEDULER] Clínica "${clinic.name}": ${stale.count} sync(s) órfão(s) (>90min em running) marcado(s) como failed.`);
                    }

                    const inFlight = await this.prisma.syncRun.count({
                        where: { clinicId: clinic.id, status: 'running' },
                    });
                    if (inFlight > 0) {
                        this.logger.warn(`[SCHEDULER] Clínica "${clinic.name}" tem ${inFlight} sync(s) ativo(s) recente(s) — pulando.`);
                        skipped++;
                        continue;
                    }

                    const { vismedRunId, doctoraliaRunId } = await this.syncService.triggerGlobalSync(clinic.id);
                    this.logger.log(`[SCHEDULER] Clínica "${clinic.name}": disparado vismedRun=${vismedRunId} + doctoraliaRun=${doctoraliaRunId}`);
                    dispatched++;
                } catch (err: any) {
                    failed++;
                    this.logger.error(`[SCHEDULER] Falha ao disparar sync para "${clinic.name}": ${err?.message}`, err?.stack);
                }
            }

            const elapsedMs = Date.now() - startedAt.getTime();
            this.logger.log(`[SCHEDULER] <<< Ciclo concluído em ${elapsedMs}ms — dispatched=${dispatched}, skipped=${skipped}, failed=${failed}.`);
        } catch (err: any) {
            this.logger.error(`[SCHEDULER] Erro inesperado no ciclo: ${err?.message}`, err?.stack);
        } finally {
            this.isRunning = false;
        }
    }
}
