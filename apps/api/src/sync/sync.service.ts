import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { VismedService } from '../integrations/vismed/vismed.service';
import { DocplannerService } from '../integrations/docplanner.service';
import { MatchingEngineService } from '../mappings/matching-engine.service';
import { PushSyncService } from './push-sync.service';

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
        private pushSync: PushSyncService
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
            const empresaId = idEmpresaGestora || await this.getEmpresaGestoraForClinic(clinicId);
            try {
                await this.vismedQueue.add('vismed-sync', {
                    syncRunId: syncRun.id,
                    clinicId,
                    idEmpresaGestora: empresaId
                }, { attempts: 1 });
                this.logger.log(`Dispatched VISMED sync job for clinic ${clinicId}`);
            } catch (e) {
                if (this.isRedisUnavailable(e)) {
                    this.logger.warn(`Redis unavailable, running VISMED sync directly for clinic ${clinicId}`);
                    this.runVismedSyncDirect(syncRun.id, clinicId, empresaId).catch(err =>
                        this.logger.error(`Direct VISMED sync failed: ${err.message}`)
                    );
                } else {
                    this.logger.error(`Queue dispatch failed (non-Redis): ${e.message}`);
                    await this.prisma.syncRun.update({ where: { id: syncRun.id }, data: { status: 'failed', endedAt: new Date(), metrics: { error: e.message } } });
                }
            }
        } else {
            try {
                await this.doctoraliaQueue.add('process-sync', {
                    syncRunId: syncRun.id,
                    clinicId,
                    type
                }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
                this.logger.log(`Dispatched DOCTORALIA sync job for clinic ${clinicId}`);
            } catch (e) {
                if (this.isRedisUnavailable(e)) {
                    this.logger.warn(`Redis unavailable, running DOCTORALIA sync directly for clinic ${clinicId}`);
                    this.runDoctoraliaSyncDirect(syncRun.id, clinicId).catch(err =>
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

    private async getEmpresaGestoraForClinic(clinicId: string): Promise<number> {
        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'vismed' }
        });
        return conn?.clientId ? Number(conn.clientId) : 286;
    }

    private async runVismedSyncDirect(syncRunId: string, clinicId: string, idEmpresaGestora: number) {
        this.logger.log(`[DIRECT] Starting VisMed sync (Empresa: ${idEmpresaGestora}, Clinic: ${clinicId})`);
        try {
            await this.logEvent(syncRunId, 'SYSTEM', 'sync_started', 'Iniciando extração de dados da Central VisMed (execução direta).');
            let insertedOrUpdated = 0;

            const conn = await this.prisma.integrationConnection.findFirst({
                where: { clinicId, provider: 'vismed' }
            });
            const baseUrl = conn?.domain || undefined;

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

            for (const e of especialidades) {
                if (!e.idcategoriaservico || !e.nomecategoriaservico) continue;
                const normName = e.nomecategoriaservico.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
                const spec = await this.prisma.vismedSpecialty.upsert({
                    where: { vismedId: Number(e.idcategoriaservico) },
                    create: { vismedId: Number(e.idcategoriaservico), name: e.nomecategoriaservico, normalizedName: normName },
                    update: { name: e.nomecategoriaservico, normalizedName: normName }
                });
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

                await this.prisma.mapping.upsert({
                    where: {
                        clinicId_entityType_vismedId: { clinicId, entityType: 'DOCTOR', vismedId: doctor.id }
                    },
                    create: { clinicId, entityType: 'DOCTOR', vismedId: doctor.id, status: 'UNLINKED' },
                    update: {}
                });

                if (p.especialidades && typeof p.especialidades === 'string') {
                    const docSpecs = p.especialidades.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
                    for (const specName of docSpecs) {
                        const normSpecName = specName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
                        let matchedSpec = await this.prisma.vismedSpecialty.findFirst({
                            where: { normalizedName: normSpecName }
                        });
                        if (!matchedSpec) {
                            const randomId = Math.floor(Math.random() * 10000000) + 1000000;
                            matchedSpec = await this.prisma.vismedSpecialty.create({
                                data: { vismedId: randomId, name: specName, normalizedName: normSpecName }
                            });
                            await this.matchingEngine.runMatchingForSpecialty(matchedSpec.id);
                        }
                        await this.prisma.vismedProfessionalSpecialty.upsert({
                            where: {
                                vismedDoctorId_vismedSpecialtyId: {
                                    vismedDoctorId: doctor.id, vismedSpecialtyId: matchedSpec.id
                                }
                            },
                            update: {},
                            create: { vismedDoctorId: doctor.id, vismedSpecialtyId: matchedSpec.id }
                        });
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

    private async runDoctoraliaSyncDirect(syncRunId: string, clinicId: string) {
        this.logger.log(`[DIRECT] Starting Doctoralia sync for clinic ${clinicId}`);
        try {
            const conn = await this.prisma.integrationConnection.findFirst({
                where: { clinicId, provider: 'doctoralia' }
            });
            if (!conn || !conn.clientId) {
                throw new Error('Integration not fully configured or missing credentials');
            }

            const client = this.docplanner.createClient(conn.domain || 'www.doctoralia.com.br', conn.clientId, conn.clientSecret || '');

            await this.updateSyncStatus(syncRunId, 'syncing_facilities');
            const facilitiesInfo = await client.getFacilities();
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
            const docsRes = await client.getDoctors(facilityId);
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

                const doctoraliaDoctor = await this.prisma.doctoraliaDoctor.upsert({
                    where: { doctoraliaDoctorId: docId },
                    create: {
                        doctoraliaDoctorId: docId, doctoraliaFacilityId: facilityId,
                        name: doc.surname ? `${doc.name} ${doc.surname}` : (doc.name || doc.title || `Doctor #${docId}`),
                        syncedAt: new Date()
                    },
                    update: {
                        name: doc.surname ? `${doc.name} ${doc.surname}` : (doc.name || doc.title || `Doctor #${docId}`),
                        syncedAt: new Date()
                    }
                });

                try {
                    const addrsRes = await client.getAddresses(facilityId, docId);
                    for (const addr of (addrsRes._items || [])) {
                        const addrId = String(addr.id);
                        try {
                            const srvRes = await client.getServices(facilityId, docId, addrId);
                            for (const srv of (srvRes._items || [])) {
                                const srvId = String(srv.id);
                                activeServiceIds.push(srvId);
                                allServicesMap.set(srvId, srv);
                                const normName = (srv.name || `Service #${srvId}`).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
                                const doctoraliaService = await this.prisma.doctoraliaService.upsert({
                                    where: { doctoraliaServiceId: srvId },
                                    create: { doctoraliaServiceId: srvId, name: srv.name || `Service #${srvId}`, normalizedName: normName },
                                    update: { name: srv.name || `Service #${srvId}`, normalizedName: normName }
                                });
                                const addrServiceId = `${addrId}_${docId}_${srvId}`;
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
                const dictRes = await client.getServicesDictionary();
                const dictItems = dictRes._items || [];
                this.logger.log(`Dicionário de Serviços: ${dictItems.length} encontrados.`);
                await this.logEvent(syncRunId, 'SERVICE_CATALOG', 'fetch_success', `Dicionário global: ${dictItems.length} serviços encontrados.`);

                let savedSvcCount = 0;
                for (const item of dictItems) {
                    const svcId = String(item.id);
                    const svcName = item.name || `Service #${svcId}`;
                    try {
                        const normName = svcName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
                        await this.prisma.doctoraliaService.upsert({
                            where: { doctoraliaServiceId: svcId },
                            update: { name: svcName, normalizedName: normName },
                            create: { doctoraliaServiceId: svcId, name: svcName, normalizedName: normName }
                        });
                        savedSvcCount++;
                    } catch (itemErr: any) {
                        this.logger.debug(`Falha ao salvar serviço ${svcId}: ${itemErr?.message}`);
                    }
                    if (savedSvcCount % 500 === 0) {
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
                const insProvidersRes = await client.getInsuranceProviders();
                const insProviders = insProvidersRes._items || [];
                this.logger.log(`Insurance Providers: ${insProviders.length} encontrados no dicionário global.`);
                await this.logEvent(syncRunId, 'INSURANCE', 'fetch_success', `Dicionário global: ${insProviders.length} insurance providers encontrados.`);

                let savedCount = 0;
                for (const ip of insProviders) {
                    const ipId = ip.insurance_provider_id || ip.id;
                    const ipName = ip.name || ip.insurance_provider_name;
                    if (!ipId || !ipName) continue;
                    try {
                        const normName = (ipName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
                        await this.prisma.doctoraliaInsuranceProvider.upsert({
                            where: { doctoraliaId: Number(ipId) },
                            create: { doctoraliaId: Number(ipId), name: ipName, normalizedName: normName },
                            update: { name: ipName, normalizedName: normName }
                        });
                        savedCount++;
                    } catch (itemErr: any) {
                        this.logger.debug(`Falha ao salvar insurance provider ${ipId}: ${itemErr?.message}`);
                    }
                    if (savedCount % 100 === 0) {
                        this.logger.log(`Insurance Providers: ${savedCount}/${insProviders.length} salvos...`);
                    }
                }
                totalProcessed += savedCount;
                this.logger.log(`Insurance Providers: ${savedCount} salvos no dicionário local.`);
            } catch (insErr: any) {
                this.logger.warn(`Falha ao importar insurance providers: ${insErr.message}`);
                await this.logEvent(syncRunId, 'INSURANCE', 'fetch_error', `Erro: ${insErr.message}`);
            }

            await this.updateSyncStatus(syncRunId, 'running_matching_engine');
            await this.matchingEngine.runMatchingForUnmatched();

            this.logger.log('Iniciando envio bidirecional para Doctoralia...');
            await this.updateSyncStatus(syncRunId, 'push_to_doctoralia');
            await this.pushSync.pushToDoctoralia(clinicId, syncRunId, client);

            await this.cleanupOrphans(clinicId, syncRunId, activeDoctorIds, activeServiceIds);
            await this.completeSyncRun(syncRunId, totalProcessed);
            this.logger.log(`[DIRECT] Doctoralia sync completed: ${totalProcessed} records.`);
        } catch (e) {
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
