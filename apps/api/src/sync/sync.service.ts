import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { VismedService } from '../integrations/vismed/vismed.service';
import { DocplannerService } from '../integrations/docplanner.service';
import { StableDataCacheService, STABLE_DATA_TTLS } from '../integrations/stable-data-cache.service';
import { MatchingEngineService } from '../mappings/matching-engine.service';
import { PushSyncService } from './push-sync.service';
import { getDoctoraliaContext, runWithDoctoraliaContext } from '../metrics/doctoralia-call-context';
import { ClinicConcurrencyGuard } from '../bookings/clinic-concurrency-guard';
import { getDoctoraliaMetricsService, concurrencyActorOf } from '../metrics/doctoralia-metrics.service';
import { isDoctoraliaCircuitOpenError } from '../integrations/doctoralia-circuit-breaker';
import { buildDoctoraliaDoctorUpsertData } from '../mappings/license.util';
import { resolveVismedConnection } from './vismed-sync/vismed-connection.resolver';

@Injectable()
export class SyncService {
    private readonly logger = new Logger(SyncService.name);

    constructor(
        @InjectQueue('vismed-sync') private vismedQueue: Queue,
        @InjectQueue('sync-queue') private doctoraliaQueue: Queue,
        private prisma: PrismaService,
        private vismedClient: VismedService,
        private docplanner: DocplannerService,
        private matchingEngine: MatchingEngineService,
        private pushSync: PushSyncService,
        private concurrencyGuard: ClinicConcurrencyGuard,
        private stableCache: StableDataCacheService,
    ) { }

    private async isQueuePaused(clinicId: string): Promise<boolean> {
        const connections = await this.prisma.integrationConnection.findMany({
            where: { clinicId, provider: { in: ['doctoralia', 'vismed'] } },
            select: { status: true },
        });
        return connections.some(c => c.status === 'paused');
    }

    async triggerManualSync(clinicId: string, type: 'full' | 'doctors' | 'services' | 'vismed-full' = 'full', idEmpresaGestora?: number) {
        const paused = await this.isQueuePaused(clinicId);
        if (paused) {
            this.logger.warn(`Sync queue is paused for clinic ${clinicId}, rejecting ${type} sync`);
            return { id: null, status: 'rejected', reason: 'Queue is paused' };
        }

        await this.prisma.auditLog.create({
            data: {
                action: 'MANUAL_SYNC_TRIGGERED',
                entity: 'Clinic',
                entityId: clinicId,
                details: { type }
            }
        });

        const syncRun = await this.prisma.syncRun.create({
            data: {
                clinicId,
                type,
                status: 'running',
            }
        });

        if (type === 'vismed-full') {
            // RESOLUÇÃO FAIL-CLOSED: nunca cair no default global nem na empresa 286.
            let resolvedEmpresa: number;
            try {
                const resolved = await resolveVismedConnection(this.prisma, clinicId);
                resolvedEmpresa = resolved.idEmpresaGestora;

                // Se o caller forneceu idEmpresaGestora explicitamente, deve coincidir
                // com o clientId da conexão — divergência implica configuração incorreta.
                if (idEmpresaGestora !== undefined && Number(idEmpresaGestora) !== resolvedEmpresa) {
                    throw new Error(
                        `idEmpresaGestora divergente: caller=${idEmpresaGestora}, conexão=${resolvedEmpresa} para clinicId=${clinicId}.`,
                    );
                }
            } catch (resolveErr) {
                const msg = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
                this.logger.error(`[VISMED-ROUTING] ${msg}`);
                await this.prisma.syncRun.update({
                    where: { id: syncRun.id },
                    data: { status: 'failed', endedAt: new Date(), metrics: { error: msg } },
                });
                return syncRun;
            }

            try {
                await this.vismedQueue.add('vismed-sync', {
                    syncRunId: syncRun.id,
                    clinicId,
                    idEmpresaGestora: resolvedEmpresa,
                }, { attempts: 1 });
                this.logger.log(`Dispatched VISMED sync job for clinic ${clinicId} (idEmpresaGestora=${resolvedEmpresa})`);
            } catch (e) {
                if (this.isRedisUnavailable(e)) {
                    this.logger.warn(`Redis unavailable, running VISMED sync directly for clinic ${clinicId}`);
                    this.runVismedSyncDirect(syncRun.id, clinicId, resolvedEmpresa).catch(err =>
                        this.logger.error(`Direct VISMED sync failed: ${err.message}`)
                    );
                } else {
                    this.logger.error(`Queue dispatch failed (non-Redis): ${e.message}`);
                    await this.prisma.syncRun.update({ where: { id: syncRun.id }, data: { status: 'failed', endedAt: new Date(), metrics: { error: e.message } } });
                }
            }
        } else {
            try {
                // WP-01: serialize the current ALS context origin into the job payload so the
                // BullMQ processor (new async context) can reconstruct it for observability.
                const _observabilityOrigin = getDoctoraliaContext()?.origin ?? 'SCHEDULER';
                await this.doctoraliaQueue.add('process-sync', {
                    syncRunId: syncRun.id,
                    clinicId,
                    type,
                    _observabilityOrigin,
                }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
                this.logger.log(`Dispatched DOCTORALIA sync job for clinic ${clinicId}`);
            } catch (e) {
                if (this.isRedisUnavailable(e)) {
                    this.logger.warn(`Redis unavailable, running DOCTORALIA sync directly for clinic ${clinicId}`);
                    const _directOrigin = getDoctoraliaContext()?.origin ?? 'SCHEDULER';
                    this.runDoctoraliaSyncDirect(syncRun.id, clinicId, _directOrigin).catch(err =>
                        this.logger.error(`Direct DOCTORALIA sync failed: ${err.message}`)
                    );
                } else {
                    this.logger.error(`Queue dispatch failed (non-Redis): ${e.message}`);
                    await this.prisma.syncRun.update({ where: { id: syncRun.id }, data: { status: 'failed', endedAt: new Date(), metrics: { error: e.message } } });
                }
            }
        }

        return syncRun;
    }

    /**
     * Task 133: re-disparo de um Global Sync adiado por reserva de prioridade.
     * Chamado pelo callback opaco registrado no ClinicConcurrencyGuard quando a
     * clínica fica livre. Revalida clínica ativa e ausência de run em andamento,
     * cria um NOVO SyncRun correlacionado ao adiado e enfileira (ou executa
     * direto no fallback sem Redis).
     */
    async resumeDeferredGlobalSync(clinicId: string, deferredFromRunId: string): Promise<void> {
        try {
            const clinic = await this.prisma.clinic.findUnique({
                where: { id: clinicId },
                select: { active: true },
            });
            if (!clinic?.active) {
                this.logger.warn(`[DEFERRED-SYNC] Clínica ${clinicId} inexistente/desativada — reserva de prioridade descartada`);
                this.concurrencyGuard.clearPriority(clinicId);
                return;
            }
            // Um run Doctoralia 'running' pode estar EXECUTANDO (guard ativo) ou
            // apenas ENFILEIRADO (BullMQ ainda não fez o acquire). Em ambos os
            // casos ele consumirá a reserva no finally e correlacionará o run
            // adiado — a reserva é MANTIDA, nunca descartada aqui (descarte só em
            // caso terminal comprovado: clínica desativada; TTL cobre abandono).
            // Runs VisMed não tocam o guard nem conflitam com o Global Sync
            // Doctoralia (o próprio triggerGlobalSync dispara ambos juntos).
            const doctoraliaInFlight = await this.prisma.syncRun.count({
                where: { clinicId, status: 'running', type: { not: 'vismed-full' } },
            });
            if (doctoraliaInFlight > 0) {
                this.logger.log(`[DEFERRED-SYNC] Clínica ${clinicId} já tem ${doctoraliaInFlight} run(s) Doctoralia em andamento/enfileirado(s) — reserva mantida para consumo/correlação por esse run`);
                return;
            }

            const newRun = await this.prisma.syncRun.create({
                data: {
                    clinicId,
                    type: 'full',
                    status: 'running',
                    metrics: { deferredFromRunId },
                },
            });
            // Correlação reversa no run adiado (merge preservando metrics existentes)
            await this.correlateSatisfiedReservation(deferredFromRunId, newRun.id);

            this.logger.log(`[DEFERRED-SYNC] Re-disparando Global Sync adiado clinicId=${clinicId} — run ${newRun.id} (adiado: ${deferredFromRunId})`);
            const _observabilityOrigin = getDoctoraliaContext()?.origin ?? 'SCHEDULER';
            try {
                await this.doctoraliaQueue.add('process-sync', {
                    syncRunId: newRun.id,
                    clinicId,
                    type: 'full',
                    _observabilityOrigin,
                }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
            } catch (e: any) {
                if (this.isRedisUnavailable(e)) {
                    this.logger.warn(`[DEFERRED-SYNC] Redis indisponível — executando direto clinicId=${clinicId}`);
                    this.runDoctoraliaSyncDirect(newRun.id, clinicId, _observabilityOrigin).catch(err =>
                        this.logger.error(`[DEFERRED-SYNC] Execução direta falhou: ${err?.message}`));
                } else {
                    this.logger.error(`[DEFERRED-SYNC] Falha ao enfileirar (não-Redis): ${e?.message}`);
                    this.concurrencyGuard.clearPriority(clinicId);
                    await this.prisma.syncRun.update({
                        where: { id: newRun.id },
                        data: { status: 'failed', endedAt: new Date(), metrics: { deferredFromRunId, error: e?.message } },
                    }).catch(() => {});
                }
            }
        } catch (err: any) {
            // Nunca deixar a clínica permanentemente bloqueada: em exceção,
            // descarta a reserva — a próxima janela do cron cobre.
            this.logger.error(`[DEFERRED-SYNC] Erro no re-disparo clinicId=${clinicId}: ${err?.message}`);
            this.concurrencyGuard.clearPriority(clinicId);
            throw err;
        }
    }

    /**
     * Task 133: grava metrics.resumedByRunId no run adiado, apontando para o run
     * que satisfez a reserva (o re-disparo OU um Global Sync independente que
     * consumiu a reserva ao terminar). Merge preserva metrics existentes.
     * Fail-safe: nunca lança (correlação é observabilidade, não fluxo).
     */
    async correlateSatisfiedReservation(deferredRunId: string, satisfiedByRunId: string): Promise<void> {
        try {
            const deferred = await this.prisma.syncRun.findUnique({ where: { id: deferredRunId }, select: { metrics: true } });
            const prevMetrics = (deferred?.metrics && typeof deferred.metrics === 'object') ? deferred.metrics as Record<string, any> : {};
            await this.prisma.syncRun.update({
                where: { id: deferredRunId },
                data: { metrics: { ...prevMetrics, resumedByRunId: satisfiedByRunId } },
            });
        } catch (err: any) {
            this.logger.warn(`[DEFERRED-SYNC] Falha ao correlacionar run adiado ${deferredRunId} → ${satisfiedByRunId}: ${err?.message}`);
        }
    }

    async triggerGlobalSync(clinicId: string, idEmpresaGestora?: number) {
        const vismedRun = await this.triggerManualSync(clinicId, 'vismed-full', idEmpresaGestora);
        const doctoraliaRun = await this.triggerManualSync(clinicId, 'full');
        return { vismedRunId: vismedRun.id, doctoraliaRunId: doctoraliaRun.id };
    }

    async getVismedStats() {
        const [units, doctors, specialties, insurances] = await Promise.all([
            this.prisma.vismedUnit.count(),
            this.prisma.vismedDoctor.count(),
            this.prisma.vismedSpecialty.count(),
            this.prisma.vismedInsurance.count()
        ]);
        return { units, doctors, specialties, insurances };
    }

    private async runVismedSyncDirect(syncRunId: string, clinicId: string, idEmpresaGestora: number) {
        this.logger.log(`[DIRECT] Starting VisMed sync (Empresa: ${idEmpresaGestora}, Clinic: ${clinicId})`);
        try {
            // RESOLUÇÃO FAIL-CLOSED idêntica ao processor — garante paridade nos dois caminhos.
            // Nunca usa conn?.domain || undefined (que caía no default global api-vissmed-7).
            let baseUrl: string;
            let resolvedEmpresa: number;
            try {
                const resolved = await resolveVismedConnection(this.prisma, clinicId);
                baseUrl = resolved.baseUrl;
                resolvedEmpresa = resolved.idEmpresaGestora;
            } catch (resolveErr) {
                const msg = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
                this.logger.error(`[VISMED-ROUTING][DIRECT] Falha ao resolver conexão VisMed — clinicId=${clinicId}: ${msg}`);
                await this.prisma.syncRun.update({
                    where: { id: syncRunId },
                    data: { status: 'failed', endedAt: new Date(), metrics: { error: msg } },
                });
                await this.logEvent(syncRunId, 'SYSTEM', 'sync_error', msg);
                return;
            }

            // Verificação de consistência: idEmpresaGestora passado por triggerManualSync deve bater.
            if (Number(idEmpresaGestora) !== resolvedEmpresa) {
                const msg = `[DIRECT] idEmpresaGestora divergente: recebido=${idEmpresaGestora}, conexão=${resolvedEmpresa} para clinicId=${clinicId}.`;
                this.logger.error(`[VISMED-ROUTING] ${msg}`);
                await this.prisma.syncRun.update({
                    where: { id: syncRunId },
                    data: { status: 'failed', endedAt: new Date(), metrics: { error: msg } },
                });
                await this.logEvent(syncRunId, 'SYSTEM', 'sync_error', msg);
                return;
            }

            const host = (() => { try { return new URL(baseUrl).host; } catch (_) { return baseUrl; } })();
            this.logger.log(`[VISMED-ROUTING][DIRECT] clinicId=${clinicId} idEmpresaGestora=${resolvedEmpresa} host=${host}`);

            await this.logEvent(syncRunId, 'SYSTEM', 'sync_started', `Iniciando extração de dados da Central VisMed (execução direta). idEmpresaGestora=${resolvedEmpresa} host=${host}`);
            let insertedOrUpdated = 0;

            this.logger.log('Sincronizando Unidades...');
            await this.logEvent(syncRunId, 'LOCATION', 'fetch_started', 'Buscando unidades geográficas...');
            const unidades = await this.vismedClient.getUnidades(idEmpresaGestora, baseUrl);
            await this.logEvent(syncRunId, 'LOCATION', 'fetch_success', `Encontradas ${unidades.length} unidades.`);

            for (const u of unidades) {
                const unit = await this.prisma.vismedUnit.upsert({
                    where: { vismedId: Number(u.idunidade) },
                    create: {
                        vismedId: Number(u.idunidade),
                        codUnidade: u.codunidade ? Number(u.codunidade) : null,
                        name: u.nomeunidade,
                        cnpj: u.cnpj,
                        cityName: u.nomecidade,
                        isActive: true,
                    },
                    update: {
                        codUnidade: u.codunidade ? Number(u.codunidade) : null,
                        name: u.nomeunidade,
                        cnpj: u.cnpj,
                        cityName: u.nomecidade,
                    }
                });

                await this.prisma.mapping.upsert({
                    where: {
                        clinicId_entityType_vismedId: { clinicId, entityType: 'LOCATION', vismedId: unit.id }
                    },
                    create: { clinicId, entityType: 'LOCATION', vismedId: unit.id, status: 'UNLINKED' },
                    update: {}
                });
                insertedOrUpdated++;
            }
            await this.prisma.syncRun.update({ where: { id: syncRunId }, data: { totalRecords: insertedOrUpdated } });

            this.logger.log('Sincronizando Especialidades...');
            await this.logEvent(syncRunId, 'SPECIALTY', 'fetch_started', 'Buscando catálogo de especialidades...');
            const especialidades = await this.vismedClient.getEspecialidades(idEmpresaGestora, baseUrl);
            await this.logEvent(syncRunId, 'SPECIALTY', 'fetch_success', `Encontradas ${especialidades.length} especialidades.`);

            const empresaScope = Number(idEmpresaGestora);
            for (const e of especialidades) {
                if (!e.idcategoriaservico || !e.nomecategoriaservico) continue;
                const normName = e.nomecategoriaservico.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
                const vid = Number(e.idcategoriaservico);
                // Upsert ESCOPADO por empresa gestora; registros legados sem escopo são
                // reivindicados pelo vismedId (catálogos disjuntos entre empresas na VisMed).
                let spec = await this.prisma.vismedSpecialty.findFirst({
                    where: { idEmpresaGestora: empresaScope, vismedId: vid },
                });
                if (spec) {
                    spec = await this.prisma.vismedSpecialty.update({
                        where: { id: spec.id },
                        data: { name: e.nomecategoriaservico, normalizedName: normName },
                    });
                } else {
                    const unscoped = await this.prisma.vismedSpecialty.findFirst({
                        where: { idEmpresaGestora: null, vismedId: vid },
                    });
                    if (unscoped) {
                        spec = await this.prisma.vismedSpecialty.update({
                            where: { id: unscoped.id },
                            data: { idEmpresaGestora: empresaScope, name: e.nomecategoriaservico, normalizedName: normName },
                        });
                        await this.logEvent(syncRunId, 'SPECIALTY', 'specialty_claimed',
                            `Especialidade "${e.nomecategoriaservico}" (idcategoriaservico=${vid}) reivindicada pela empresa gestora ${empresaScope} (registro legado sem escopo).`);
                    } else {
                        spec = await this.prisma.vismedSpecialty.create({
                            data: { idEmpresaGestora: empresaScope, vismedId: vid, name: e.nomecategoriaservico, normalizedName: normName },
                        });
                    }
                }
                await this.matchingEngine.runMatchingForSpecialty(spec.id);
                insertedOrUpdated++;
            }
            await this.prisma.syncRun.update({ where: { id: syncRunId }, data: { totalRecords: insertedOrUpdated } });

            this.logger.log('Sincronizando Profissionais...');
            await this.logEvent(syncRunId, 'DOCTOR', 'fetch_started', 'Extraindo profissionais vinculados...');
            const profissionais = await this.vismedClient.getProfissionais(idEmpresaGestora, baseUrl);
            await this.logEvent(syncRunId, 'DOCTOR', 'fetch_success', `Encontrados ${profissionais.length} profissionais.`);

            for (const p of profissionais) {
                if (!p.idprofissional) continue;
                let unitRecord = null;
                if (p.idunidadevinculada) {
                    unitRecord = await this.prisma.vismedUnit.findUnique({
                        where: { vismedId: Number(p.idunidadevinculada) }
                    });
                }

                const turnoM = (p.turno_m && p.turno_m.trim() !== '-' && p.turno_m.trim() !== '') ? p.turno_m.trim() : null;
                const turnoT = (p.turno_t && p.turno_t.trim() !== '-' && p.turno_t.trim() !== '') ? p.turno_t.trim() : null;
                const turnoN = (p.turno_n && p.turno_n.trim() !== '-' && p.turno_n.trim() !== '') ? p.turno_n.trim() : null;

                const doctor = await this.prisma.vismedDoctor.upsert({
                    where: { vismedId: Number(p.idprofissional) },
                    create: {
                        vismedId: Number(p.idprofissional),
                        name: p.nomecompleto, formalName: p.nomeformal,
                        cpf: p.cpf, documentNumber: p.numerodocumento,
                        documentType: p.siglaprofissionaltipodocumento,
                        gender: p.sexo, isActive: p.ativo === "1",
                        unitId: unitRecord ? unitRecord.id : null,
                        turnoM, turnoT, turnoN,
                    },
                    update: {
                        name: p.nomecompleto, formalName: p.nomeformal,
                        cpf: p.cpf, documentNumber: p.numerodocumento,
                        documentType: p.siglaprofissionaltipodocumento,
                        gender: p.sexo, isActive: p.ativo === "1",
                        unitId: unitRecord ? unitRecord.id : null,
                        turnoM, turnoT, turnoN,
                    }
                });

                // Attempt tenant-safe creation while Mapping is truly absent.
                // The later upsert has update={} and preserves LINKED/UNLINKED.
                if (typeof this.matchingEngine.runMatchingForDoctor === 'function') {
                    await this.matchingEngine.runMatchingForDoctor(doctor.id, clinicId);
                }
                await this.prisma.mapping.upsert({
                    where: {
                        clinicId_entityType_vismedId: { clinicId, entityType: 'DOCTOR', vismedId: doctor.id }
                    },
                    create: { clinicId, entityType: 'DOCTOR', vismedId: doctor.id, status: 'UNLINKED' },
                    update: {}
                });

                if (p.especialidades && typeof p.especialidades === 'string') {
                    const docSpecs = p.especialidades.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
                    const expectedSpecIds = new Set<string>();
                    for (const specName of docSpecs) {
                        const normSpecName = specName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
                        // TODAS as homônimas DO ESCOPO desta empresa gestora, ordenadas
                        // (determinístico) — nunca vincular a categoria de outra empresa.
                        let matchedSpecs = await this.prisma.vismedSpecialty.findMany({
                            where: { normalizedName: normSpecName, idEmpresaGestora: empresaScope },
                            orderBy: { vismedId: 'asc' },
                        });
                        if (matchedSpecs.length === 0) {
                            const randomId = Math.floor(Math.random() * 10000000) + 1000000;
                            const ghost = await this.prisma.vismedSpecialty.create({
                                data: { vismedId: randomId, idEmpresaGestora: empresaScope, name: specName, normalizedName: normSpecName }
                            });
                            await this.matchingEngine.runMatchingForSpecialty(ghost.id);
                            matchedSpecs = [ghost];
                        }
                        for (const matchedSpec of matchedSpecs) {
                            expectedSpecIds.add(matchedSpec.id);
                            await this.prisma.vismedProfessionalSpecialty.upsert({
                                where: {
                                    vismedDoctorId_vismedSpecialtyId: {
                                        vismedDoctorId: doctor.id, vismedSpecialtyId: matchedSpec.id
                                    }
                                },
                                update: {},
                                create: { vismedDoctorId: doctor.id, vismedSpecialtyId: matchedSpec.id, source: 'SYNC' }
                            });
                        }
                    }
                    // Remove vínculos SYNC obsoletos (categoria não consta mais nas especialidades);
                    // vínculos MANUAL são preservados.
                    // ESCOPADO: só remove vínculos a categorias DESTA empresa (ou legadas sem
                    // escopo) — nunca apaga vínculo apontando ao catálogo de outra empresa.
                    const staleLinks = await this.prisma.vismedProfessionalSpecialty.findMany({
                        where: {
                            vismedDoctorId: doctor.id,
                            source: 'SYNC',
                            vismedSpecialtyId: { notIn: Array.from(expectedSpecIds) },
                            specialty: { OR: [{ idEmpresaGestora: empresaScope }, { idEmpresaGestora: null }] },
                        },
                        include: { specialty: true },
                    });
                    for (const link of staleLinks) {
                        await this.prisma.vismedProfessionalSpecialty.delete({ where: { id: link.id } });
                        const msg = `Vínculo obsoleto removido: ${doctor.name} × "${link.specialty?.name}" (idcategoriaservico=${link.specialty?.vismedId}) — categoria não consta mais nas especialidades do profissional.`;
                        this.logger.log(`[SPECIALTY-LINK-CLEANUP] ${msg}`);
                        await this.logEvent(syncRunId, 'DOCTOR', 'specialty_link_removed', msg);
                    }
                }
                insertedOrUpdated++;
            }

            this.logger.log('Sincronizando Convênios...');
            await this.logEvent(syncRunId, 'INSURANCE', 'fetch_started', 'Buscando convênios cadastrados...');
            const convenios = await this.vismedClient.getConvenios(idEmpresaGestora, baseUrl);
            await this.logEvent(syncRunId, 'INSURANCE', 'fetch_success', `Encontrados ${convenios.length} convênios.`);

            for (const c of convenios) {
                if (!c.idconvenio) continue;
                const ins = await this.prisma.vismedInsurance.upsert({
                    where: { vismedId: Number(c.idconvenio) },
                    create: {
                        vismedId: Number(c.idconvenio),
                        name: c.nomeconvenio,
                        isActive: c.ativo === "1",
                        idConvenioTipo: c.idconveniotipo ? Number(c.idconveniotipo) : null,
                        razaoSocial: c.razaosocialconveniado,
                        cnpj: c.cnpjconveniado,
                        dataInicio: c.datainicio,
                        dataFinal: c.datafinal,
                        agendamentoOnline: c.agendamentoonline,
                    },
                    update: {
                        name: c.nomeconvenio,
                        isActive: c.ativo === "1",
                        idConvenioTipo: c.idconveniotipo ? Number(c.idconveniotipo) : null,
                        razaoSocial: c.razaosocialconveniado,
                        cnpj: c.cnpjconveniado,
                        dataInicio: c.datainicio,
                        dataFinal: c.datafinal,
                        agendamentoOnline: c.agendamentoonline,
                    }
                });

                await this.prisma.mapping.upsert({
                    where: {
                        clinicId_entityType_vismedId: { clinicId, entityType: 'INSURANCE', vismedId: ins.id }
                    },
                    create: { clinicId, entityType: 'INSURANCE', vismedId: ins.id, status: 'UNLINKED' },
                    update: {}
                });
                insertedOrUpdated++;
            }
            await this.prisma.syncRun.update({ where: { id: syncRunId }, data: { totalRecords: insertedOrUpdated } });

            await this.prisma.syncRun.update({
                where: { id: syncRunId },
                data: { status: 'completed', endedAt: new Date(), totalRecords: insertedOrUpdated }
            });
            await this.logEvent(syncRunId, 'SYSTEM', 'sync_success', `Sincronização VisMed concluída. ${insertedOrUpdated} registros.`);
            this.logger.log(`[DIRECT] VisMed sync completed: ${insertedOrUpdated} records.`);
        } catch (e) {
            this.logger.error(`[DIRECT] VisMed sync failed: ${e.message}`, e.stack);
            await this.prisma.syncRun.update({
                where: { id: syncRunId },
                data: { status: 'failed', endedAt: new Date(), metrics: { error: e.message } }
            });
            await this.logEvent(syncRunId, 'SYSTEM', 'sync_error', e.message);
        }
    }

    private async runDoctoraliaSyncDirect(syncRunId: string, clinicId: string, observabilityOrigin: string = 'SCHEDULER') {
        // WP-04: exclusão mútua por clínica — GLOBAL_SYNC (caminho direto sem Redis)
        // nunca roda junto com POLLING/SAFETY_SWEEP/SLOT_SYNC (ou outro GLOBAL_SYNC).
        // Política SKIP: finaliza o run como 'skipped' para não deixar órfão em 'running'.
        if (!this.concurrencyGuard.tryAcquire(clinicId, 'GLOBAL_SYNC')) {
            // Task 133: em vez de perder a janela, registra reserva de prioridade —
            // quando o subsistema atual liberar a clínica, o sync é re-disparado.
            const blocker = concurrencyActorOf(this.concurrencyGuard.getActiveSubsystem(clinicId) ?? 'GLOBAL_SYNC');
            const skipReason = `GLOBAL_SYNC_DEFERRED_${blocker}_ACTIVE`;
            this.logger.warn(`[DIRECT] ${skipReason} clinicId=${clinicId} — ${blocker} em andamento, sync global ADIADO (reserva de prioridade registrada)`);
            try { getDoctoraliaMetricsService()?.recordConcurrencySkip(`GLOBAL_SYNC_SKIPPED_${blocker}_ACTIVE`, clinicId); } catch (_e) {}
            this.concurrencyGuard.requestPriority(
                clinicId,
                () => {
                    this.resumeDeferredGlobalSync(clinicId, syncRunId).catch(err =>
                        this.logger.error(`[DIRECT] Re-disparo do sync adiado falhou clinicId=${clinicId}: ${err?.message}`));
                },
                {
                    tag: syncRunId,
                    onExpire: () => { try { getDoctoraliaMetricsService()?.recordConcurrencySkip('GLOBAL_SYNC_RESERVATION_EXPIRED', clinicId); } catch (_e) {} },
                },
            );
            await this.prisma.syncRun.update({
                where: { id: syncRunId },
                data: { status: 'skipped', endedAt: new Date(), metrics: { skipReason } }
            }).catch(err => this.logger.error(`[DIRECT] Falha ao finalizar SyncRun adiado ${syncRunId}: ${err?.message}`));
            return;
        }
        try {
            this.logger.log(`[DIRECT] Starting Doctoralia sync for clinic ${clinicId}`);
            // WP-01: reconstruct Doctoralia context (ALS doesn't propagate across async fire-and-forget)
            return await runWithDoctoraliaContext({ origin: observabilityOrigin as any, clinicId }, () => this._runDoctoraliaSyncDirectBody(syncRunId, clinicId));
        } finally {
            // Task 133: qualquer execução GLOBAL_SYNC CONSOME a reserva de prioridade
            // — consumo ANTES do release para não re-disparar a reserva já satisfeita.
            // Se a reserva era de OUTRO run adiado, correlaciona (nunca silencioso).
            const consumed = this.concurrencyGuard.consumePriority(clinicId);
            // WP-04: liberar guard em qualquer cenário
            this.concurrencyGuard.release(clinicId, 'GLOBAL_SYNC');
            if (consumed?.tag && consumed.tag !== syncRunId) {
                this.logger.log(`[DIRECT] Reserva de prioridade do run adiado ${consumed.tag} satisfeita por este run ${syncRunId} clinicId=${clinicId}`);
                await this.correlateSatisfiedReservation(consumed.tag, syncRunId);
            }
        }
    }

    private async _runDoctoraliaSyncDirectBody(syncRunId: string, clinicId: string) {
        try {
            const conn = await this.prisma.integrationConnection.findFirst({
                where: { clinicId, provider: 'doctoralia' }
            });
            if (!conn || !conn.clientId) {
                throw new Error('Integration not fully configured or missing credentials');
            }

            const client = this.docplanner.createClient(conn.domain || 'www.doctoralia.com.br', conn.clientId, conn.clientSecret || '');

            await this.updateSyncStatus(syncRunId, 'syncing_facilities');
            // WP-06: cache TTL para dados estáveis (caminho fallback direto, sem Redis).
            const facilitiesInfo = await this.stableCache.getOrFetch(
                `${client.getCacheIdentity()}|facilities`,
                STABLE_DATA_TTLS.facilities,
                () => client.getFacilities(),
            );
            const facilitiesList = facilitiesInfo._items || [];
            await this.logEvent(syncRunId, 'FACILITY', 'fetch_success', `Found ${facilitiesList.length} facilities`);
            let totalProcessed = facilitiesList.length;

            if (facilitiesList.length === 0) {
                await this.completeSyncRun(syncRunId);
                return;
            }

            const facilityId = String(facilitiesList[0].id);

            for (const fac of facilitiesList) {
                await this.saveGenericMapping(clinicId, 'LOCATION', String(fac.id), fac, syncRunId);
            }

            await this.updateSyncStatus(syncRunId, 'syncing_doctors_services');
            const docsRes = await this.stableCache.getOrFetch(
                `${client.getCacheIdentity()}|doctors|${facilityId}`,
                STABLE_DATA_TTLS.doctors,
                () => client.getDoctors(facilityId),
            );
            const doctorsList = docsRes._items || [];
            await this.logEvent(syncRunId, 'DOCTOR', 'fetch_success', `Found ${doctorsList.length} doctors`);
            const activeDoctorIds: string[] = [];
            const activeServiceIds: string[] = [];
            const allServicesMap = new Map<string, any>();

            for (const doc of doctorsList) {
                const docId = String(doc.id);
                activeDoctorIds.push(docId);
                await this.saveGenericMapping(clinicId, 'DOCTOR', docId, doc, syncRunId);
                totalProcessed++;

                const doctorUpsert = buildDoctoraliaDoctorUpsertData(doc, facilityId);
                const doctoraliaDoctor = await this.prisma.doctoraliaDoctor.upsert({
                    where: { doctoraliaDoctorId: docId },
                    create: doctorUpsert.create,
                    update: doctorUpsert.update,
                });

                try {
                    const addrsRes = await this.stableCache.getOrFetch(
                        `${client.getCacheIdentity()}|addresses|${facilityId}|${docId}`,
                        STABLE_DATA_TTLS.addresses,
                        () => client.getAddresses(facilityId, docId),
                    );
                    for (const addr of (addrsRes._items || [])) {
                        const addrId = String(addr.id);
                        try {
                            const srvRes = await this.stableCache.getOrFetch(
                                `${client.getCacheIdentity()}|services|${facilityId}|${docId}|${addrId}`,
                                STABLE_DATA_TTLS.services,
                                () => client.getServices(facilityId, docId, addrId),
                            );
                            for (const srv of (srvRes._items || [])) {
                                // srv.id é o id do VÍNCULO serviço↔endereço (address_service id).
                                // srv.service_id é o id do DICIONÁRIO global de serviços.
                                // O dicionário local (DoctoraliaService) deve usar SOMENTE service_id;
                                // gravar srv.id ali cria entradas falsas que a Doctoralia rejeita com 404 no push.
                                const linkId = String(srv.id);
                                if (srv.service_id === undefined || srv.service_id === null) {
                                    this.logger.warn(`Serviço "${srv.name || linkId}" (address_service ${linkId}) sem service_id do dicionário — pulado para não gravar id inválido.`);
                                    continue;
                                }
                                const srvId = String(srv.service_id);
                                activeServiceIds.push(srvId);
                                allServicesMap.set(srvId, srv);
                                const normName = (srv.name || `Service #${srvId}`).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
                                const doctoraliaService = await this.prisma.doctoraliaService.upsert({
                                    where: { doctoraliaServiceId: srvId },
                                    create: { doctoraliaServiceId: srvId, name: srv.name || `Service #${srvId}`, normalizedName: normName },
                                    update: { name: srv.name || `Service #${srvId}`, normalizedName: normName }
                                });
                                const addrServiceId = linkId;
                                await this.prisma.doctoraliaAddressService.upsert({
                                    where: { doctoraliaAddressServiceId: addrServiceId },
                                    update: {
                                        price: srv.price, isPriceFrom: srv.is_price_from || false,
                                        description: srv.description, defaultDuration: srv.default_duration,
                                        syncedAt: new Date(), isVisible: true
                                    },
                                    create: {
                                        doctoraliaAddressServiceId: addrServiceId,
                                        doctoraliaAddressId: addrId,
                                        doctorId: doctoraliaDoctor.id, serviceId: doctoraliaService.id,
                                        price: srv.price, isPriceFrom: srv.is_price_from || false,
                                        description: srv.description, defaultDuration: srv.default_duration,
                                        syncedAt: new Date(), isVisible: true
                                    }
                                });
                            }
                        } catch (e) { }

                        try {
                            const insRes = await client.getAddressInsuranceProviders(facilityId, docId, addrId);
                            const addressInsProviders = insRes._items || [];
                            if (addressInsProviders.length > 0) {
                                this.logger.log(`Doctor ${doc.name || doc.surname || docId}: ${addressInsProviders.length} convênio(s) no endereço ${addrId}`);
                                for (const aip of addressInsProviders) {
                                    const aipId = aip.insurance_provider_id || aip.id;
                                    const aipName = aip.name || aip.insurance_provider_name;
                                    if (!aipId || !aipName) continue;
                                    const normName = (aipName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
                                    await this.prisma.doctoraliaInsuranceProvider.upsert({
                                        where: { doctoraliaId: Number(aipId) },
                                        create: { doctoraliaId: Number(aipId), name: aipName, normalizedName: normName },
                                        update: { name: aipName, normalizedName: normName }
                                    });
                                }
                            }
                        } catch (insAddrErr: any) {
                            this.logger.debug(`Falha ao buscar convênios do endereço ${addrId}: ${insAddrErr?.message?.substring(0, 100)}`);
                        }
                    }
                } catch (e) { }
            }

            for (const [srvId, srv] of allServicesMap.entries()) {
                await this.saveGenericMapping(clinicId, 'SERVICE', srvId, srv, syncRunId);
            }

            this.logger.log('Importando dicionário global de Serviços da Doctoralia...');
            await this.updateSyncStatus(syncRunId, 'importing_services_dictionary');
            try {
                const dictRes = await this.stableCache.getOrFetch(
                    `${client.getCacheIdentity()}|servicesDictionary`,
                    STABLE_DATA_TTLS.servicesDictionary,
                    () => client.getServicesDictionary(),
                );
                const dictItems = dictRes._items || [];
                this.logger.log(`Dicionário de Serviços: ${dictItems.length} encontrados.`);
                await this.logEvent(syncRunId, 'SERVICE_CATALOG', 'fetch_success', `Dicionário global: ${dictItems.length} serviços encontrados.`);

                let savedSvcCount = 0;
                const BATCH = 500;
                for (let i = 0; i < dictItems.length; i += BATCH) {
                    const slice = dictItems.slice(i, i + BATCH);
                    const values: string[] = [];
                    const params: any[] = [];
                    let p = 1;
                    for (const item of slice) {
                        const svcId = String(item.id);
                        const svcName = item.name || `Service #${svcId}`;
                        const normName = svcName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
                        values.push(`($${p++}, $${p++}, $${p++}, NOW(), NOW())`);
                        params.push(svcId, svcName, normName);
                    }
                    const sql = `
                        INSERT INTO "DoctoraliaService" ("id", "doctoraliaServiceId", "name", "normalizedName", "createdAt", "updatedAt")
                        SELECT gen_random_uuid(), v.sid, v.nm, v.norm, NOW(), NOW()
                        FROM (VALUES ${values.join(',')}) AS v(sid, nm, norm, c, u)
                        ON CONFLICT ("doctoraliaServiceId")
                        DO UPDATE SET "name" = EXCLUDED."name", "normalizedName" = EXCLUDED."normalizedName", "updatedAt" = NOW()
                    `;
                    try {
                        await this.prisma.$executeRawUnsafe(sql, ...params);
                        savedSvcCount += slice.length;
                    } catch (batchErr: any) {
                        this.logger.warn(`Falha em batch de ${slice.length} serviços (offset ${i}): ${batchErr?.message}`);
                    }
                    if (savedSvcCount > 0 && (savedSvcCount % 2000 === 0 || (i + BATCH) >= dictItems.length)) {
                        this.logger.log(`Dicionário de Serviços: ${savedSvcCount}/${dictItems.length} salvos...`);
                    }
                }
                totalProcessed += savedSvcCount;
                this.logger.log(`Dicionário de Serviços: ${savedSvcCount} salvos no dicionário local.`);
            } catch (catalogError: any) {
                this.logger.warn(`Falha ao importar dicionário de serviços: ${catalogError.message}`);
                await this.logEvent(syncRunId, 'SERVICE_CATALOG', 'fetch_error', `Erro: ${catalogError.message}`);
            }

            this.logger.log('Importando dicionário global de Insurance Providers da Doctoralia...');
            await this.updateSyncStatus(syncRunId, 'syncing_insurance_providers');
            try {
                const insProvidersRes = await this.stableCache.getOrFetch(
                    `${client.getCacheIdentity()}|insuranceProviders`,
                    STABLE_DATA_TTLS.insuranceProviders,
                    () => client.getInsuranceProviders(),
                );
                const insProviders = insProvidersRes._items || [];
                this.logger.log(`Insurance Providers: ${insProviders.length} encontrados no dicionário global.`);
                await this.logEvent(syncRunId, 'INSURANCE', 'fetch_success', `Dicionário global: ${insProviders.length} insurance providers encontrados.`);

                let savedCount = 0;
                const IP_BATCH = 500;
                const validItems = insProviders.filter((ip: any) => {
                    const ipId = ip.insurance_provider_id || ip.id;
                    const ipName = ip.name || ip.insurance_provider_name;
                    return ipId && ipName;
                });
                for (let i = 0; i < validItems.length; i += IP_BATCH) {
                    const slice = validItems.slice(i, i + IP_BATCH);
                    const values: string[] = [];
                    const params: any[] = [];
                    let p = 1;
                    for (const ip of slice) {
                        const ipId = Number(ip.insurance_provider_id || ip.id);
                        const ipName = ip.name || ip.insurance_provider_name;
                        const normName = (ipName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
                        values.push(`($${p++}::int, $${p++}, $${p++})`);
                        params.push(ipId, ipName, normName);
                    }
                    const sql = `
                        INSERT INTO "DoctoraliaInsuranceProvider" ("id", "doctoraliaId", "name", "normalizedName", "createdAt", "updatedAt")
                        SELECT gen_random_uuid(), v.did, v.nm, v.norm, NOW(), NOW()
                        FROM (VALUES ${values.join(',')}) AS v(did, nm, norm)
                        ON CONFLICT ("doctoraliaId")
                        DO UPDATE SET "name" = EXCLUDED."name", "normalizedName" = EXCLUDED."normalizedName", "updatedAt" = NOW()
                    `;
                    try {
                        await this.prisma.$executeRawUnsafe(sql, ...params);
                        savedCount += slice.length;
                    } catch (batchErr: any) {
                        this.logger.warn(`Falha em batch de ${slice.length} insurance providers (offset ${i}): ${batchErr?.message}`);
                    }
                    if (savedCount > 0 && (savedCount % 1000 === 0 || (i + IP_BATCH) >= validItems.length)) {
                        this.logger.log(`Insurance Providers: ${savedCount}/${validItems.length} salvos...`);
                    }
                }
                totalProcessed += savedCount;
                this.logger.log(`Insurance Providers: ${savedCount} salvos no dicionário local.`);
            } catch (insErr: any) {
                this.logger.warn(`Falha ao importar insurance providers: ${insErr.message}`);
                await this.logEvent(syncRunId, 'INSURANCE', 'fetch_error', `Erro: ${insErr.message}`);
            }

            await this.updateSyncStatus(syncRunId, 'running_matching_engine');
            await this.matchingEngine.runMatchingForUnmatched(clinicId);

            this.logger.log('Iniciando envio bidirecional para Doctoralia...');
            await this.updateSyncStatus(syncRunId, 'push_to_doctoralia');
            await this.pushSync.pushToDoctoralia(clinicId, syncRunId, client);

            await this.cleanupOrphans(clinicId, syncRunId, activeDoctorIds, activeServiceIds);
            await this.completeSyncRun(syncRunId, totalProcessed);
            this.logger.log(`[DIRECT] Doctoralia sync completed: ${totalProcessed} records.`);
        } catch (e) {
            // WP-08A: circuito Doctoralia aberto → finaliza o run como SKIPPED explícito
            // (não é falha da clínica; a próxima janela do scheduler cobre). Nunca
            // altera o status da integração.
            if (isDoctoraliaCircuitOpenError(e)) {
                this.logger.log(`[DIRECT] Doctoralia sync pulado — circuito aberto (${e.message})`);
                await this.prisma.syncRun.update({
                    where: { id: syncRunId },
                    data: { status: 'skipped', endedAt: new Date(), metrics: { skipReason: 'DOCTORALIA_CIRCUIT_OPEN', error: e.message } }
                });
                return;
            }
            this.logger.error(`[DIRECT] Doctoralia sync failed: ${e.message}`, e.stack);
            await this.prisma.syncRun.update({
                where: { id: syncRunId },
                data: { status: 'failed', endedAt: new Date(), metrics: { error: e.message } }
            });
        }
    }

    private async saveGenericMapping(clinicId: string, type: any, externalId: string, item: any, syncRunId: string) {
        const name = item.name || item.title || (item.surname ? `${item.name} ${item.surname}` : `Item #${externalId}`);
        await this.prisma.mapping.upsert({
            where: { clinicId_entityType_externalId: { clinicId, entityType: type, externalId } },
            create: { clinicId, entityType: type, externalId, status: 'UNLINKED', conflictData: { ...item, name, externalId } },
            update: {
                conflictData: { ...item, name, externalId },
            }
        }).then(async (mapping) => {
            if (mapping.status === 'ORPHAN') {
                await this.prisma.mapping.update({
                    where: { id: mapping.id },
                    data: { status: mapping.vismedId ? 'LINKED' : 'UNLINKED' }
                });
            }
        });
    }

    private async cleanupOrphans(clinicId: string, syncRunId: string, activeDoctorIds: string[], activeServiceIds: string[]) {
        await this.logEvent(syncRunId, 'MAPPING', 'cleanup_started', 'Identifying orphaned records...');
        const types = [
            { type: 'DOCTOR' as const, ids: activeDoctorIds },
            { type: 'SERVICE' as const, ids: activeServiceIds },
        ];
        for (const { type, ids } of types) {
            if (ids.length === 0) continue;
            const orphaned = await this.prisma.mapping.updateMany({
                where: { clinicId, entityType: type, externalId: { notIn: ids }, status: { not: 'ORPHAN' } },
                data: { status: 'ORPHAN', lastError: 'Registro não encontrado na última sincronização.' }
            });
            if (orphaned.count > 0) {
                await this.logEvent(syncRunId, type, 'cleanup_orphans', `Marked ${orphaned.count} ${type.toLowerCase()}(s) as ORPHAN`);
            }
        }
    }

    private isRedisUnavailable(error: any): boolean {
        const msg = (error?.message || '').toLowerCase();
        return msg.includes('econnrefused') || msg.includes('redis') || msg.includes('connection') || msg.includes('timeout') || msg.includes('enotfound');
    }

    private async updateSyncStatus(id: string, status: string) {
        await this.prisma.syncRun.update({ where: { id }, data: { status } });
    }

    private async completeSyncRun(id: string, totalRecords = 0) {
        await this.prisma.syncRun.update({
            where: { id },
            data: { status: 'completed', endedAt: new Date(), totalRecords }
        });
    }

    private async logEvent(syncRunId: string, entityType: string, action: string, message: string) {
        await this.prisma.syncEvent.create({
            data: { syncRunId, entityType, action, message }
        });
    }
}
