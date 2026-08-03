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

            // vismedIds retornados pela API nesta execução + índice por nome normalizado,
            // para detectar/migrar registros cujo código mudou na VisMed (ex.: 180 → 3472).
            const returnedVismedIds = new Set<number>();
            const currentSpecTargetByNorm = new Map<string, { id: string; vismedId: number }>(); // normalizedName -> registro atual de menor vismedId

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

                returnedVismedIds.add(Number(e.idcategoriaservico));
                // Determinístico: entre homônimas, o alvo de migração é sempre a de MENOR vismedId,
                // independente da ordem em que a API retorna as categorias.
                const prevTarget = currentSpecTargetByNorm.get(normName);
                if (!prevTarget || Number(e.idcategoriaservico) < prevTarget.vismedId) {
                    currentSpecTargetByNorm.set(normName, { id: spec.id, vismedId: Number(e.idcategoriaservico) });
                }

                // Dispatch matching run
                await this.matchingEngine.runMatchingForSpecialty(spec.id);
                insertedOrUpdated++;
            }

            // ----------------------------------------------------
            // PASSO B2: Migrar/alertar especialidades obsoletas
            // (código sumiu do retorno da API — VisMed trocou o idcategoriaservico)
            // ----------------------------------------------------
            if (returnedVismedIds.size > 0) {
                const currentSpecIdsByNorm = new Map<string, string>();
                for (const [norm, t] of currentSpecTargetByNorm) currentSpecIdsByNorm.set(norm, t.id);
                await this.migrateObsoleteSpecialties(currentSyncRunId, returnedVismedIds, currentSpecIdsByNorm);
            } else {
                this.logger.warn('API de especialidades retornou vazia — pulando detecção de códigos obsoletos (fail-safe).');
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

                const turnoM = (p.turno_m && p.turno_m.trim() !== '-' && p.turno_m.trim() !== '') ? p.turno_m.trim() : null;
                const turnoT = (p.turno_t && p.turno_t.trim() !== '-' && p.turno_t.trim() !== '') ? p.turno_t.trim() : null;
                const turnoN = (p.turno_n && p.turno_n.trim() !== '-' && p.turno_n.trim() !== '') ? p.turno_n.trim() : null;

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
                        turnoM,
                        turnoT,
                        turnoN,
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
                        turnoM,
                        turnoT,
                        turnoN,
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

                    // IDs (VismedSpecialty.id) que a string de especialidades atual justifica.
                    const expectedSpecIds = new Set<string>();

                    for (const specName of docSpecs) {
                        const normSpecName = specName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

                        // Buscar TODAS as categorias homônimas (determinístico: ordenado por vismedId).
                        // A VisMed pode ter duas categorias com o mesmo nome (ex.: Oftalmologia 180 e 3472)
                        // e o médico deve ficar vinculado a TODAS, não a uma escolhida ao acaso.
                        let matchedSpecs = await this.prisma.vismedSpecialty.findMany({
                            where: { normalizedName: normSpecName },
                            orderBy: { vismedId: 'asc' },
                        });

                        // Categoria "fantasma" SOMENTE quando nenhuma homônima existe.
                        if (matchedSpecs.length === 0) {
                            const randomId = Math.floor(Math.random() * 10000000) + 1000000;
                            const ghost = await this.prisma.vismedSpecialty.create({
                                data: {
                                    vismedId: randomId,
                                    name: specName,
                                    normalizedName: normSpecName
                                }
                            });
                            await this.matchingEngine.runMatchingForSpecialty(ghost.id);
                            matchedSpecs = [ghost];
                        }

                        for (const matchedSpec of matchedSpecs) {
                            expectedSpecIds.add(matchedSpec.id);
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
                                    vismedSpecialtyId: matchedSpec.id,
                                    source: 'SYNC'
                                }
                            });
                        }
                    }

                    // Limpeza de vínculos obsoletos: remove vínculos criados pela SYNC cujas
                    // categorias não constam mais nas especialidades atuais do profissional.
                    // Vínculos MANUAL são preservados. Só roda quando a string veio preenchida.
                    const staleLinks = await this.prisma.vismedProfessionalSpecialty.findMany({
                        where: {
                            vismedDoctorId: doctor.id,
                            source: 'SYNC',
                            vismedSpecialtyId: { notIn: Array.from(expectedSpecIds) },
                        },
                        include: { specialty: true },
                    });
                    for (const link of staleLinks) {
                        await this.prisma.vismedProfessionalSpecialty.delete({ where: { id: link.id } });
                        const msg = `Vínculo obsoleto removido: ${doctor.name} × "${link.specialty?.name}" (idcategoriaservico=${link.specialty?.vismedId}) — categoria não consta mais nas especialidades do profissional.`;
                        this.logger.log(`[SPECIALTY-LINK-CLEANUP] ${msg}`);
                        await this.logEvent(currentSyncRunId, 'DOCTOR', 'specialty_link_removed', msg);
                    }
                }

                insertedOrUpdated++;
            }

            // ----------------------------------------------------
            // PASSO D: Sincronizar Convênios (VismedInsurance)
            // ----------------------------------------------------
            this.logger.log('Sincronizando Convênios...');
            await this.logEvent(currentSyncRunId, 'INSURANCE', 'fetch_started', 'Buscando convênios...');
            try {
                const convenios = await this.vismedClient.getConvenios(idEmpresaGestora);
                await this.logEvent(currentSyncRunId, 'INSURANCE', 'fetch_success', `Encontrados ${convenios.length} convênios.`);

                for (const c of convenios) {
                    if (!c.idconvenio || !c.nomeconvenio) continue;

                    const insurance = await this.prisma.vismedInsurance.upsert({
                        where: { vismedId: Number(c.idconvenio) },
                        create: {
                            vismedId: Number(c.idconvenio),
                            name: c.nomeconvenio,
                            isActive: true,
                        },
                        update: {
                            name: c.nomeconvenio,
                        }
                    });

                    await this.prisma.mapping.upsert({
                        where: {
                            clinicId_entityType_vismedId: {
                                clinicId,
                                entityType: 'INSURANCE',
                                vismedId: insurance.id,
                            }
                        },
                        create: {
                            clinicId,
                            entityType: 'INSURANCE',
                            vismedId: insurance.id,
                            status: 'UNLINKED',
                        },
                        update: {}
                    });
                    insertedOrUpdated++;
                }
            } catch (convErr) {
                this.logger.warn(`Falha ao sincronizar convênios: ${convErr?.message || convErr}`);
                await this.logEvent(currentSyncRunId, 'INSURANCE', 'fetch_error', convErr?.message || 'Erro desconhecido');
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

    /**
     * Detecta registros VismedSpecialty cujo vismedId (idcategoriaservico) NÃO veio mais no
     * retorno da API — sinal de que a VisMed trocou o código (ex.: Oftalmologia 180 → 3472).
     *
     * Para cada registro obsoleto:
     * - Se existe registro atual com o MESMO nome normalizado: migra os vínculos
     *   médico↔especialidade (VismedProfessionalSpecialty) e os mapeamentos
     *   serviço↔especialidade (SpecialtyServiceMapping) para o registro atual e apaga o obsoleto.
     * - Se não existe correspondente por nome: mantém o registro (pode ser especialidade
     *   "fantasma" criada a partir da string de especialidades do profissional), mas registra
     *   alerta no log do sync em vez de silenciar.
     */
    private async migrateObsoleteSpecialties(
        syncRunId: string,
        returnedVismedIds: Set<number>,
        currentSpecIdsByNorm: Map<string, string>,
    ): Promise<void> {
        const staleSpecs = await this.prisma.vismedSpecialty.findMany({
            where: { vismedId: { notIn: Array.from(returnedVismedIds) } },
            include: {
                doctors: true,
                mappings: true,
            },
            orderBy: { vismedId: 'asc' },
        });

        for (const stale of staleSpecs) {
            const norm = stale.normalizedName
                || stale.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
            const targetId = currentSpecIdsByNorm.get(norm);

            if (!targetId || targetId === stale.id) {
                // Sem correspondente no catálogo atual — não apagar (pode ser especialidade
                // "fantasma" legítima), mas alertar em vez de manter silenciosamente.
                if (stale.doctors.length > 0 || stale.mappings.length > 0) {
                    const msg = `Especialidade "${stale.name}" (idcategoriaservico=${stale.vismedId}) não consta mais no retorno da VisMed e não há registro atual com o mesmo nome. Vínculos mantidos: ${stale.doctors.length} médico(s), ${stale.mappings.length} mapeamento(s). Verifique o catálogo na VisMed.`;
                    this.logger.warn(`[SPECIALTY-OBSOLETE] ${msg}`);
                    await this.logEvent(syncRunId, 'SPECIALTY', 'specialty_obsolete', msg);
                }
                continue;
            }

            const target = await this.prisma.vismedSpecialty.findUnique({ where: { id: targetId } });
            if (!target) continue;

            this.logger.log(
                `[SPECIALTY-MIGRATE] "${stale.name}" mudou de código na VisMed: ${stale.vismedId} → ${target.vismedId}. Migrando ${stale.doctors.length} vínculo(s) de médico e ${stale.mappings.length} mapeamento(s) de serviço.`,
            );

            await this.prisma.$transaction(async (tx) => {
                // 1) Vínculos médico↔especialidade: mover, respeitando o unique (doctorId, specialtyId)
                for (const link of stale.doctors) {
                    const exists = await tx.vismedProfessionalSpecialty.findUnique({
                        where: {
                            vismedDoctorId_vismedSpecialtyId: {
                                vismedDoctorId: link.vismedDoctorId,
                                vismedSpecialtyId: target.id,
                            },
                        },
                    });
                    if (exists) {
                        await tx.vismedProfessionalSpecialty.delete({ where: { id: link.id } });
                    } else {
                        await tx.vismedProfessionalSpecialty.update({
                            where: { id: link.id },
                            data: { vismedSpecialtyId: target.id },
                        });
                    }
                }

                // 2) Mapeamentos serviço↔especialidade: mover, respeitando o unique (specialtyId, serviceId)
                for (const m of stale.mappings) {
                    const exists = await tx.specialtyServiceMapping.findUnique({
                        where: {
                            vismedSpecialtyId_doctoraliaServiceId: {
                                vismedSpecialtyId: target.id,
                                doctoraliaServiceId: m.doctoraliaServiceId,
                            },
                        },
                    });
                    if (exists) {
                        await tx.specialtyServiceMapping.delete({ where: { id: m.id } });
                    } else {
                        await tx.specialtyServiceMapping.update({
                            where: { id: m.id },
                            data: { vismedSpecialtyId: target.id },
                        });
                    }
                }

                // 3) Apagar o registro obsoleto (cascade limpa qualquer resto)
                await tx.vismedSpecialty.delete({ where: { id: stale.id } });
            });

            const msg = `Especialidade "${stale.name}": código VisMed mudou de ${stale.vismedId} para ${target.vismedId}. Migrados ${stale.doctors.length} vínculo(s) de médico e ${stale.mappings.length} mapeamento(s) de serviço; registro antigo removido.`;
            await this.logEvent(syncRunId, 'SPECIALTY', 'specialty_migrated', msg);
        }
    }

    private async logEvent(syncRunId: string, entityType: string, action: string, message: string) {
        await this.prisma.syncEvent.create({
            data: { syncRunId, entityType, action, message }
        });
    }
}
