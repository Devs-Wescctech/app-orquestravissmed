import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from './sync.service';
import { runWithDoctoraliaContext } from '../metrics/doctoralia-call-context';

/**
 * Task 136 — Stagger determinístico da Global Sync.
 *
 * Janela útil de distribuição: 24 min dentro do ciclo de 30 min (folga ≥6 min
 * antes do próximo cron). Slot por clínica: min(3 min, floor(24 min / n)),
 * recalculado a cada ciclo a partir da quantidade de clínicas ativas — sem
 * nenhum limite fixo de quantidade.
 *
 * Best-effort em restart/deploy: os timers vivem só em memória. Se o processo
 * reinicia no meio da janela, os disparos ainda pendentes daquela janela são
 * perdidos; a próxima janela de 30 min recalcula tudo e recupera naturalmente.
 * onModuleDestroy cancela os timers pendentes E resolve as Promises
 * correspondentes (status 'cancelled') para que o ciclo finalize sem Promise
 * pendurada.
 */
const STAGGER_WINDOW_MS = 24 * 60 * 1000;
const MAX_SLOT_MS = 3 * 60 * 1000;
/** Piso prático: abaixo disso o stagger perde efeito contra rajadas (apenas alerta em log). */
const MIN_PRACTICAL_SLOT_MS = 10 * 1000;

export type StaggerDispatchStatus = 'dispatched' | 'skipped' | 'failed' | 'cancelled';

/**
 * Função pura: calcula o slot e os offsets determinísticos para uma lista de
 * clínicas, ordenando por clinicId (independente da ordem do banco).
 */
export function computeStaggerPlan<T extends { id: string }>(clinics: T[]): {
    slotMs: number;
    entries: Array<{ clinic: T; offsetMs: number }>;
} {
    const sorted = [...clinics].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const n = sorted.length;
    if (n === 0) return { slotMs: 0, entries: [] };
    const slotMs = Math.min(MAX_SLOT_MS, Math.floor(STAGGER_WINDOW_MS / n));
    return {
        slotMs,
        entries: sorted.map((clinic, i) => ({ clinic, offsetMs: i * slotMs })),
    };
}

interface PendingDispatch {
    timer: NodeJS.Timeout;
    resolve: (status: StaggerDispatchStatus) => void;
}

@Injectable()
export class SyncSchedulerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SyncSchedulerService.name);
    private readonly disabled: boolean;
    private isRunning = false;
    private isShuttingDown = false;
    private pendingDispatches = new Set<PendingDispatch>();

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
            this.logger.log('[SCHEDULER] Sync cron ATIVO — global sync VisMed↔Doctoralia executa a cada 30 minutos (cron: */30 * * * *), com stagger determinístico entre clínicas.');
        }
        // Limpeza na subida: um restart/redeploy no meio de uma execução deixa o registro
        // órfão em 'running' para sempre (o processo que o finalizaria morreu). Marca como
        // failed logo no boot, sem esperar o próximo ciclo do cron.
        this.cleanupStaleRuns('boot').catch(err =>
            this.logger.warn(`[SCHEDULER] Falha na limpeza de runs órfãos no boot: ${err?.message}`));
    }

    /**
     * Shutdown limpo: cancela todos os timers pendentes E resolve as Promises
     * associadas (status 'cancelled'), permitindo que o Promise.allSettled do
     * ciclo termine e isRunning seja liberado no finally.
     */
    onModuleDestroy() {
        this.isShuttingDown = true;
        if (this.pendingDispatches.size > 0) {
            this.logger.warn(`[SCHEDULER] Shutdown: cancelando ${this.pendingDispatches.size} disparo(s) staggered pendente(s).`);
        }
        for (const pending of [...this.pendingDispatches]) {
            clearTimeout(pending.timer);
            pending.resolve('cancelled');
        }
        this.pendingDispatches.clear();
    }

    /**
     * Marca como 'failed' execuções presas em 'running' há mais de 90min, em TODAS as
     * clínicas (independente de estarem ativas/pausadas — antes a limpeza só rodava
     * dentro do loop de clínicas ativas, e clínicas puladas ficavam com runs órfãos
     * congelados em "processando" indefinidamente).
     */
    private async cleanupStaleRuns(context: string): Promise<number> {
        const STALE_THRESHOLD_MS = 90 * 60 * 1000;
        const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
        const stale = await this.prisma.syncRun.updateMany({
            where: { status: 'running', startedAt: { lt: staleCutoff } },
            data: { status: 'failed', endedAt: new Date(), metrics: { error: `abandoned — running >90min (cleanup: ${context})` } },
        });
        if (stale.count > 0) {
            this.logger.warn(`[SCHEDULER] ${stale.count} sync(s) órfão(s) (>90min em running) marcado(s) como failed (${context}).`);
        }
        return stale.count;
    }

    @Cron('*/30 * * * *', { name: 'global-sync-every-30min', timeZone: 'America/Sao_Paulo' })
    async runGlobalSyncForAllClinics() {
        if (this.disabled || this.isShuttingDown) {
            return;
        }
        if (this.isRunning) {
            this.logger.warn('[SCHEDULER] Execução anterior ainda em andamento — pulando esta janela.');
            return;
        }

        // WP-01: propagate SCHEDULER context for all Doctoralia calls within this cron cycle
        return runWithDoctoraliaContext({ origin: 'SCHEDULER' }, () => this._runGlobalSyncForAllClinicsInner());
    }

    private async _runGlobalSyncForAllClinicsInner() {
        this.isRunning = true;
        const startedAt = new Date();
        this.logger.log(`[SCHEDULER] >>> Iniciando ciclo automático de sync global (${startedAt.toISOString()})`);

        await this.cleanupSkippedBookingAlerts();
        // Limpeza global de runs órfãos ANTES do loop de clínicas — cobre também clínicas
        // que serão puladas (pausadas/em erro) e não passariam pela limpeza por-clínica.
        await this.cleanupStaleRuns('cycle').catch(err =>
            this.logger.warn(`[SCHEDULER] Falha na limpeza de runs órfãos: ${err?.message}`));

        try {
            const clinics = await this.prisma.clinic.findMany({
                where: { active: true },
                select: { id: true, name: true },
            });

            if (clinics.length === 0) {
                this.logger.warn('[SCHEDULER] Nenhuma clínica ativa encontrada — nada a fazer.');
                return;
            }

            const { slotMs, entries } = computeStaggerPlan(clinics);
            this.logger.log(
                `[SCHEDULER] ${entries.length} clínica(s) ativa(s) — stagger: slot=${slotMs}ms, ` +
                `plano: ${entries.map(e => `"${e.clinic.name}"@+${Math.round(e.offsetMs / 1000)}s`).join(', ')}`,
            );
            if (entries.length > 1 && slotMs < MIN_PRACTICAL_SLOT_MS) {
                this.logger.warn(`[SCHEDULER] ALERTA: slot de ${slotMs}ms abaixo do piso prático (${MIN_PRACTICAL_SLOT_MS}ms) com ${entries.length} clínicas — stagger com efeito reduzido; proteção real fica com o rate limiter e a reserva de prioridade.`);
            }

            const results = await Promise.allSettled(
                entries.map(({ clinic, offsetMs }) => this.scheduleClinicDispatch(clinic, offsetMs)),
            );

            let dispatched = 0, skipped = 0, failed = 0, cancelled = 0;
            for (const r of results) {
                const status: StaggerDispatchStatus = r.status === 'fulfilled' ? r.value : 'failed';
                if (status === 'dispatched') dispatched++;
                else if (status === 'skipped') skipped++;
                else if (status === 'cancelled') cancelled++;
                else failed++;
            }

            const elapsedMs = Date.now() - startedAt.getTime();
            this.logger.log(`[SCHEDULER] <<< Ciclo concluído em ${elapsedMs}ms — dispatched=${dispatched}, skipped=${skipped}, failed=${failed}, cancelled=${cancelled}.`);
        } catch (err: any) {
            this.logger.error(`[SCHEDULER] Erro inesperado no ciclo: ${err?.message}`, err?.stack);
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Agenda o disparo de uma clínica no seu offset. Retorna uma Promise que
     * SEMPRE resolve (dispatched/skipped/failed/cancelled) — nunca rejeita e
     * nunca fica pendente após shutdown.
     */
    private scheduleClinicDispatch(clinic: { id: string; name: string }, offsetMs: number): Promise<StaggerDispatchStatus> {
        return new Promise<StaggerDispatchStatus>((resolve) => {
            const pending: PendingDispatch = { timer: null as any, resolve: undefined as any };
            let settled = false;
            const settle = (status: StaggerDispatchStatus) => {
                if (settled) return;
                settled = true;
                this.pendingDispatches.delete(pending);
                resolve(status);
            };
            pending.resolve = settle;

            if (this.isShuttingDown) {
                settle('cancelled');
                return;
            }

            pending.timer = setTimeout(async () => {
                // Guard contra corrida entre disparo do timer e cancelamento no shutdown.
                if (this.isShuttingDown || settled) {
                    settle('cancelled');
                    return;
                }
                try {
                    const status = await this.dispatchClinicNow(clinic, offsetMs);
                    settle(status);
                } catch (err: any) {
                    // dispatchClinicNow já captura; cinto e suspensório.
                    this.logger.error(`[SCHEDULER] Falha inesperada no disparo staggered de "${clinic.name}": ${err?.message}`, err?.stack);
                    settle('failed');
                }
            }, offsetMs);
            this.pendingDispatches.add(pending);
        });
    }

    /** Disparo real de uma clínica: checagem de SyncRun running NO MOMENTO do disparo. */
    private async dispatchClinicNow(clinic: { id: string; name: string }, offsetMs: number): Promise<StaggerDispatchStatus> {
        try {
            // Anti-overlap: pula se já existe sync rodando para essa clínica.
            // (Runs órfãos >90min já foram marcados como failed pela limpeza global do ciclo.)
            const inFlight = await this.prisma.syncRun.count({
                where: { clinicId: clinic.id, status: 'running' },
            });
            if (inFlight > 0) {
                this.logger.warn(`[SCHEDULER] Clínica "${clinic.name}" tem ${inFlight} sync(s) ativo(s) recente(s) — pulando (offset +${Math.round(offsetMs / 1000)}s).`);
                return 'skipped';
            }

            const { vismedRunId, doctoraliaRunId } = await this.syncService.triggerGlobalSync(clinic.id);
            this.logger.log(`[SCHEDULER] Clínica "${clinic.name}" (offset +${Math.round(offsetMs / 1000)}s): disparado vismedRun=${vismedRunId} + doctoraliaRun=${doctoraliaRunId}`);
            return 'dispatched';
        } catch (err: any) {
            this.logger.error(`[SCHEDULER] Falha ao disparar sync para "${clinic.name}": ${err?.message}`, err?.stack);
            return 'failed';
        }
    }

    /**
     * Limpeza automática dos alertas de agendamentos pulados:
     * 1. Auto-resolve alertas cujo startAt já passou (risco de overbooking acabou).
     * 2. Apaga alertas resolvidos há mais de 30 dias.
     */
    private async cleanupSkippedBookingAlerts(): Promise<void> {
        try {
            const now = new Date();
            const expired = await this.prisma.skippedBookingAlert.updateMany({
                where: { resolved: false, startAt: { lt: now } },
                data: { resolved: true, resolvedAt: now },
            });
            if (expired.count > 0) {
                this.logger.log(`[SKIPPED-ALERT] ${expired.count} alerta(s) auto-resolvido(s) — agendamento já passou.`);
            }

            const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            const purged = await this.prisma.skippedBookingAlert.deleteMany({
                where: { resolved: true, resolvedAt: { lt: cutoff } },
            });
            if (purged.count > 0) {
                this.logger.log(`[SKIPPED-ALERT] ${purged.count} alerta(s) resolvidos há mais de 30 dias apagado(s).`);
            }
        } catch (err: any) {
            this.logger.warn(`[SKIPPED-ALERT] Falha na limpeza de alertas antigos: ${err?.message}`);
        }
    }
}
