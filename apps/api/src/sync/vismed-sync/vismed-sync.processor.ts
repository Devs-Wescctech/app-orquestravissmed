import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { VismedService } from '../../integrations/vismed/vismed.service';
import { MatchingEngineService } from '../../mappings/matching-engine.service';

@Processor('vismed-sync')
@Injectable()
export class VismedSyncProcessor extends WorkerHost {
    private readonly logger = new Logger(VismedSyncProcessor.name);

    constructor(
        private prisma: PrismaService,
        private vismedClient: VismedService,
        private matchingEngine: MatchingEngineService
    ) {
        super();
    }

    async process(job: Job<any, any, string>): Promise<any> {
        const { idEmpresaGestora, clinicId, syncRunId } = job.data;

        console.log(`[WORKER] Iniciando Processamento OBRIGATÓRIO do Job: ${job.name} (ID: ${job.id})`);
        this.logger.log(`Iniciando Sincronização VisMed (Empresa: ${idEmpresaGestora}, ClinicLocal: ${clinicId}, RunID: ${syncRunId})`);

        try {
            // Se o syncRunId não vier (fallback), criar um novo, mas o correto é vir do SyncService
            let currentSyncRunId = syncRunId;
            if (!currentSyncRunId) {
                const newSync = await this.prisma.syncRun.create({
                    data: {
                        clinicId,
                        type: 'vismed-full',
                        status: 'running',
                        totalRecords: 0,
                    }
                });
                currentSyncRunId = newSync.id;
            }

            await this.logEvent(currentSyncRunId, 'SYSTEM', 'sync_started', 'Iniciando extração de dados da Central VisMed.');
            let insertedOrUpdated = 0;

            // ----------------------------------------------------
            // PASSO A: Sincronizar Unidades (VismedUnit)
            // ----------------------------------------------------
            this.logger.log('Sincronizando Unidades...');
            await this.logEvent(currentSyncRunId, 'LOCATION', 'fetch_started', 'Buscando unidades geográficas...');
            const unidades = await this.vismedClient.getUnidades(idEmpresaGestora);
            await this.logEvent(currentSyncRunId, 'LOCATION', 'fetch_success', `Encontradas ${unidades.length} unidades.`);

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

                // Garantir Entrada no Mapping
                await this.prisma.mapping.upsert({
                    where: {
                        clinicId_entityType_vismedId: {
                            clinicId,
                            entityType: 'LOCATION',
                            vismedId: unit.id,
                        }
                    },
                    create: {
                        clinicId,
                        entityType: 'LOCATION',
                        vismedId: unit.id,
                        status: 'UNLINKED',
                    },
                    update: {} // Não altera mapping existente
                });
                insertedOrUpdated++;
            }
            await this.prisma.syncRun.update({ where: { id: currentSyncRunId }, data: { totalRecords: insertedOrUpdated } });

            // ----------------------------------------------------
            // PASSO B: Sincronizar Especialidades (VismedSpecialty)
            // ----------------------------------------------------
            this.logger.log('Sincronizando Especialidades/Categorias de Serviço...');
            await this.logEvent(currentSyncRunId, 'SPECIALTY', 'fetch_started', 'Buscando catálogo de especialidades...');
            const especialidades = await this.vismedClient.getEspecialidades(idEmpresaGestora);
            await this.logEvent(currentSyncRunId, 'SPECIALTY', 'fetch_success', `Encontradas ${especialidades.length} especialidades.`);

            for (const e of especialidades) {
                if (!e.idcategoriaservico || !e.nomecategoriaservico) continue;

                const normName = e.nomecategoriaservico.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

                const spec = await this.prisma.vismedSpecialty.upsert({
                    where: { vismedId: Number(e.idcategoriaservico) },
                    create: {
                        vismedId: Number(e.idcategoriaservico),
                        name: e.nomecategoriaservico,
                        normalizedName: normName
                    },
                    update: {
                        name: e.nomecategoriaservico,
                        normalizedName: normName
                    }
                });

                // Dispatch matching run
                await this.matchingEngine.runMatchingForSpecialty(spec.id);
                insertedOrUpdated++;
            }
            await this.prisma.syncRun.update({ where: { id: currentSyncRunId }, data: { totalRecords: insertedOrUpdated } });

            // ----------------------------------------------------
            // PASSO C: Sincronizar Profissionais (VismedDoctor) e Especialidades
            // ----------------------------------------------------
            this.logger.log('Sincronizando Profissionais (Médicos) e vínculos de especialidades...');
            await this.logEvent(currentSyncRunId, 'DOCTOR', 'fetch_started', 'Extraindo profissionais vinculados...');
            const profissionais = await this.vismedClient.getProfissionais(idEmpresaGestora);
            await this.logEvent(currentSyncRunId, 'DOCTOR', 'fetch_success', `Encontrados ${profissionais.length} profissionais.`);

            for (const p of profissionais) {
                if (!p.idprofissional) continue;

                let unitRecord = null;
                if (p.idunidadevinculada) {
                    unitRecord = await this.prisma.vismedUnit.findUnique({
                        where: { vismedId: Number(p.idunidadevinculada) }
                    });
                }

                const doctor = await this.prisma.vismedDoctor.upsert({
                    where: { vismedId: Number(p.idprofissional) },
                    create: {
                        vismedId: Number(p.idprofissional),
                        name: p.nomecompleto,
                        formalName: p.nomeformal,
                        cpf: p.cpf,
                        documentNumber: p.numerodocumento,
                        documentType: p.siglaprofissionaltipodocumento,
                        gender: p.sexo,
                        isActive: p.ativo === "1",
                        unitId: unitRecord ? unitRecord.id : null,
                    },
                    update: {
                        name: p.nomecompleto,
                        formalName: p.nomeformal,
                        cpf: p.cpf,
                        documentNumber: p.numerodocumento,
                        documentType: p.siglaprofissionaltipodocumento,
                        gender: p.sexo,
                        isActive: p.ativo === "1",
                        unitId: unitRecord ? unitRecord.id : null,
                    }
                });

                // Garantir Entrada no Mapping para o dashboard e UI de Mappings
                await this.prisma.mapping.upsert({
                    where: {
                        clinicId_entityType_vismedId: {
                            clinicId,
                            entityType: 'DOCTOR',
                            vismedId: doctor.id,
                        }
                    },
                    create: {
                        clinicId,
                        entityType: 'DOCTOR',
                        vismedId: doctor.id,
                        status: 'UNLINKED',
                    },
                    update: {} // Não altera mapping existente
                });

                // Extração da string de Especialidades e Criação da Tabela Pivô
                if (p.especialidades && typeof p.especialidades === 'string') {
                    const docSpecs = p.especialidades.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);

                    for (const specName of docSpecs) {
                        const normSpecName = specName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

                        // Buscar ID nativo ou registrar especialidade fantasma
                        let matchedSpec = await this.prisma.vismedSpecialty.findFirst({
                            where: { normalizedName: normSpecName }
                        });

                        if (!matchedSpec) {
                            const randomId = Math.floor(Math.random() * 10000000) + 1000000;
                            matchedSpec = await this.prisma.vismedSpecialty.create({
                                data: {
                                    vismedId: randomId,
                                    name: specName,
                                    normalizedName: normSpecName
                                }
                            });
                            await this.matchingEngine.runMatchingForSpecialty(matchedSpec.id);
                        }

                        await this.prisma.vismedProfessionalSpecialty.upsert({
                            where: {
                                vismedDoctorId_vismedSpecialtyId: {
                                    vismedDoctorId: doctor.id,
                                    vismedSpecialtyId: matchedSpec.id
                                }
                            },
                            update: {},
                            create: {
                                vismedDoctorId: doctor.id,
                                vismedSpecialtyId: matchedSpec.id
                            }
                        });
                    }
                }

                insertedOrUpdated++;
            }

            // Finaliza o Run com Sucesso
            await this.prisma.syncRun.update({
                where: { id: currentSyncRunId },
                data: {
                    status: 'completed',
                    endedAt: new Date(),
                    totalRecords: insertedOrUpdated,
                }
            });

            await this.logEvent(currentSyncRunId, 'SYSTEM', 'sync_success', `Sincronização concluída com êxito. Total de ${insertedOrUpdated} registros afetados.`);
            this.logger.log(`Sincronização VisMed Concluída: ${insertedOrUpdated} registros processados.`);

        } catch (e) {
            this.logger.error(`Falha no Job VisMed Sync: ${e ? (e.message || typeof e) : 'Unknown'}`, e ? e.stack : '');

            const { syncRunId } = job.data;
            if (syncRunId) {
                await this.prisma.syncRun.update({
                    where: { id: syncRunId },
                    data: {
                        status: 'failed',
                        endedAt: new Date(),
                        metrics: { error: e ? String(e.message || e) : 'Unknown error' }
                    }
                });
                await this.logEvent(syncRunId, 'SYSTEM', 'sync_error', e ? e.message : 'Unknown error');
            }
            throw e;
        }
    }

    private async logEvent(syncRunId: string, entityType: string, action: string, message: string) {
        await this.prisma.syncEvent.create({
            data: { syncRunId, entityType, action, message }
        });
    }
}
