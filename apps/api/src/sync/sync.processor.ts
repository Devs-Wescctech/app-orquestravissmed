import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerService, DocplannerClient } from '../integrations/docplanner.service';
import { MappingEntityType, MappingStatus } from '@prisma/client';
import { MatchingEngineService } from '../mappings/matching-engine.service';
import { PushSyncService } from './push-sync.service';

@Processor('sync-queue')
export class SyncProcessor extends WorkerHost {
    private readonly logger = new Logger(SyncProcessor.name);

    constructor(
        private prisma: PrismaService,
        private docplanner: DocplannerService,
        private matchingEngine: MatchingEngineService,
        private pushSync: PushSyncService
    ) {
        super();
    }

    async process(job: Job<any, any, string>): Promise<any> {
        const { syncRunId, clinicId } = job.data;
        this.logger.log(`Processing sync job for clinic ${clinicId}, run ID ${syncRunId}`);

        try {
            const conn = await this.prisma.integrationConnection.findFirst({
                where: { clinicId, provider: 'doctoralia' }
            });

            if (!conn || !conn.clientId) {
                throw new Error('Integration not fully configured or missing credentials');
            }

            const client = this.docplanner.createClient(conn.domain || 'doctoralia.com.br', conn.clientId, conn.clientSecret || '');

            // 1. Facilities
            await this.updateSyncStatus(syncRunId, 'syncing_facilities');
            const facilitiesInfo = await client.getFacilities();
            const facilitiesList = facilitiesInfo._items || [];
            await this.logEvent(syncRunId, 'FACILITY', 'fetch_success', `Found ${facilitiesList.length} facilities`);
            let totalProcessed = 0;
            totalProcessed += facilitiesList.length;

            if (facilitiesList.length === 0) {
                await this.completeSync(syncRunId);
                return { status: 'success', message: 'No facilities found' };
            }

            // For MVP, we process the first facility
            const facilityId = String(facilitiesList[0].id);

            // Create MAPPING for the Facility (LOCATION)
            await this.syncEntity(clinicId, syncRunId, client, 'LOCATION', async () => ({ _items: facilitiesList }));

            // ------------------------------------------------------------------------------------------
            // 2. DOCTORS, SERVICES & ADDRESS SERVICES (Hierarchical Sync Sprint 6)
            // ------------------------------------------------------------------------------------------
            await this.updateSyncStatus(syncRunId, 'syncing_doctors_services');
            this.logger.log('Sincronizando Profissionais Doctoralia e Endereços/Serviços...');

            const docsRes = await client.getDoctors(facilityId);
            const doctorsList = docsRes._items || [];
            await this.logEvent(syncRunId, 'DOCTOR', 'fetch_success', `Found ${doctorsList.length} doctors`);
            totalProcessed += doctorsList.length;
            // totalProcessed += doctorsList.length; // This will be updated incrementally inside the loop
            await this.prisma.syncRun.update({ where: { id: syncRunId }, data: { totalRecords: totalProcessed } });

            const activeDoctorIds: string[] = [];
            const activeServiceIds: string[] = [];
            const allServicesMap = new Map<string, any>(); // To track generic services for Mapping orphan logic

            for (const doc of doctorsList) {
                const docId = String(doc.id);
                activeDoctorIds.push(docId);

                // Save generic mapping
                await this.saveGenericMapping(clinicId, 'DOCTOR', docId, doc, syncRunId);
                totalProcessed++; // Increment totalProcessed for each doctor

                // Save typed table
                const doctoraliaDoctor = await this.prisma.doctoraliaDoctor.upsert({
                    where: { doctoraliaDoctorId: docId },
                    create: {
                        doctoraliaDoctorId: docId,
                        doctoraliaFacilityId: facilityId,
                        name: doc.surname ? `${doc.name} ${doc.surname}` : (doc.name || doc.title || `Doctor #${docId}`),
                        syncedAt: new Date()
                    },
                    update: {
                        name: doc.surname ? `${doc.name} ${doc.surname}` : (doc.name || doc.title || `Doctor #${docId}`),
                        syncedAt: new Date()
                    }
                });

                // Fetch Addresses for this doctor
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

                                // Save Global Service Dictionary Item
                                const doctoraliaService = await this.prisma.doctoraliaService.upsert({
                                    where: { doctoraliaServiceId: srvId },
                                    create: {
                                        doctoraliaServiceId: srvId,
                                        name: srv.name || `Service #${srvId}`,
                                        normalizedName: normName
                                    },
                                    update: {
                                        name: srv.name || `Service #${srvId}`,
                                        normalizedName: normName
                                    }
                                });

                                // Save Address Service Association (Pivot)
                                const addrServiceId = `${addrId}_${docId}_${srvId}`;
                                await this.prisma.doctoraliaAddressService.upsert({
                                    where: { doctoraliaAddressServiceId: addrServiceId },
                                    update: {
                                        price: srv.price,
                                        isPriceFrom: srv.is_price_from || false,
                                        description: srv.description,
                                        defaultDuration: srv.default_duration,
                                        syncedAt: new Date(),
                                        isVisible: true
                                    },
                                    create: {
                                        doctoraliaAddressServiceId: addrServiceId,
                                        doctoraliaAddressId: addrId,
                                        doctorId: doctoraliaDoctor.id, // internal ID
                                        serviceId: doctoraliaService.id, // internal ID
                                        price: srv.price,
                                        isPriceFrom: srv.is_price_from || false,
                                        description: srv.description,
                                        defaultDuration: srv.default_duration,
                                        syncedAt: new Date(),
                                        isVisible: true
                                    }
                                });
                            }
                        } catch (e) {
                            // Ignore address without services
                        }
                    }
                } catch (e) {
                    // Ignore doc without addresses
                }

                // Real-time progress update for doctors loop
                if (activeDoctorIds.length % 5 === 0) {
                    await this.prisma.syncRun.update({
                        where: { id: syncRunId },
                        data: { totalRecords: totalProcessed }
                    });
                }
            }

            // Register Services in Mapping table
            for (const [srvId, srv] of allServicesMap.entries()) {
                await this.saveGenericMapping(clinicId, 'SERVICE', srvId, srv, syncRunId);
            }

            // Update Run metrics for Orphans cleanup
            await this.prisma.syncRun.update({
                where: { id: syncRunId },
                data: {
                    metrics: {
                        last_active_doctors: activeDoctorIds,
                        last_active_services: activeServiceIds
                    }
                }
            });

            // 3.5 IMPORT FULL SERVICE CATALOG from Doctoralia Facility
            // This ensures the MatchingEngine can compare against ALL available services, not just assigned ones
            this.logger.log('Importando catálogo completo de serviços da Facility Doctoralia...');
            await this.updateSyncStatus(syncRunId, 'importing_service_catalog');
            try {
                const catalogRes = await client.getFacilityServicesCatalog(facilityId);
                const catalogItems = catalogRes._items || [];
                this.logger.log(`Catálogo de Serviços: ${catalogItems.length} itens encontrados.`);

                for (const item of catalogItems) {
                    const svcId = String(item.id);
                    await this.prisma.doctoraliaService.upsert({
                        where: { doctoraliaServiceId: svcId },
                        update: { name: item.name, normalizedName: item.name?.toLowerCase() },
                        create: { doctoraliaServiceId: svcId, name: item.name, normalizedName: item.name?.toLowerCase() }
                    });
                }
                await this.logEvent(syncRunId, 'SERVICE_CATALOG', 'fetch_success', `Imported ${catalogItems.length} services from Doctoralia catalog`);
                totalProcessed += catalogItems.length;
                await this.prisma.syncRun.update({ where: { id: syncRunId }, data: { totalRecords: totalProcessed } });
            } catch (catalogError: any) {
                this.logger.warn(`Falha ao importar catálogo de serviços: ${catalogError.message}`);
                await this.logEvent(syncRunId, 'SERVICE_CATALOG', 'error', `Failed to import service catalog: ${catalogError.message}`);
            }

            this.logger.log('Sincronização de Entidades Padrão concluídas. Acionando Rescan de Matching...');
            await this.updateSyncStatus(syncRunId, 'running_matching_engine');
            await this.matchingEngine.runMatchingForUnmatched();

            // 4. Reverse Sync: Push To Doctoralia
            this.logger.log('Iniciando envio Bidirecional para a Doctoralia...');
            await this.updateSyncStatus(syncRunId, 'push_to_doctoralia');
            await this.pushSync.pushToDoctoralia(clinicId, syncRunId, client);

            // 5. Insurances
            const insRes = await client.getInsurances(facilityId);
            const insList = insRes._items || [];
            totalProcessed += insList.length;
            await this.syncEntity(clinicId, syncRunId, client, 'INSURANCE', async () => ({ _items: insList }));

            // 6. Cleanup Orphans
            await this.cleanupOrphans(clinicId, syncRunId);

            await this.completeSync(syncRunId, totalProcessed);
            return { status: 'success' };
        } catch (error: any) {
            this.logger.error(`Failed sync job ${job.id}: ${error.message}`);
            await this.prisma.syncRun.update({
                where: { id: syncRunId },
                data: { status: 'failed', endedAt: new Date(), metrics: { error: error.message } }
            });
            throw error;
        }
    }

    private async syncEntity(clinicId: string, syncRunId: string, client: DocplannerClient, type: MappingEntityType, fetchFn: () => Promise<any>) {
        await this.logEvent(syncRunId, type, 'fetch_started', `Fetching ${type.toLowerCase()}s...`);
        const res = await fetchFn();
        const items = res._items || [];
        await this.logEvent(syncRunId, type, 'fetch_success', `Found ${items.length} ${type.toLowerCase()}s`);

        if (items.length > 0) {
            this.logger.log(`SAMPLE ITEM FOR ${type}: ${JSON.stringify(items[0])}`);
        }

        let insertedOrUpdated = 0;
        for (const item of items) {
            await this.saveGenericMapping(clinicId, type, String(item.id || item.uuid || 'unknown'), item, syncRunId);
            insertedOrUpdated++;
            if (insertedOrUpdated % 10 === 0) {
                await this.prisma.syncRun.update({ where: { id: syncRunId }, data: { totalRecords: insertedOrUpdated } });
            }
        }

        // Store active IDs for cleanup later
        const activeIds = items.map((i: any) => String(i.id));
        const currentMetrics = (await this.prisma.syncRun.findUnique({ where: { id: syncRunId } }))?.metrics as any || {};
        await this.prisma.syncRun.update({
            where: { id: syncRunId },
            data: { metrics: { ...currentMetrics, [`last_active_${type.toLowerCase()}s`]: activeIds } }
        });
    }

    private async saveGenericMapping(clinicId: string, type: MappingEntityType, externalId: string, item: any, currentSyncRunId: string) {
        const name = item.name || item.title || (item.surname ? `${item.name} ${item.surname}` : (item.description || `Doctoralia Item #${externalId}`));

        const existingMapping = await this.prisma.mapping.findUnique({
            where: {
                clinicId_entityType_externalId: {
                    clinicId,
                    entityType: type,
                    externalId
                }
            }
        });

        if (!existingMapping) {
            await this.prisma.mapping.create({
                data: {
                    clinicId,
                    entityType: type,
                    externalId,
                    status: 'UNLINKED',
                    conflictData: { ...item, name, externalId }
                }
            });
        } else if (existingMapping.status === 'ORPHAN') {
            await this.prisma.mapping.update({
                where: { id: existingMapping.id },
                data: { status: existingMapping.vismedId ? 'LINKED' : 'UNLINKED' }
            });
        }
    }

    private async cleanupOrphans(clinicId: string, syncRunId: string) {
        await this.logEvent(syncRunId, 'MAPPING', 'cleanup_started', 'Identifying orphaned records...');

        const syncRun = await this.prisma.syncRun.findUnique({ where: { id: syncRunId } });
        const metrics = syncRun?.metrics as any || {};

        const entityTypes: MappingEntityType[] = ['DOCTOR', 'SERVICE', 'INSURANCE'];

        for (const type of entityTypes) {
            const key = `last_active_${type.toLowerCase()}s`;
            const activeIds = metrics[key] || [];

            if (activeIds.length === 0 && type === 'DOCTOR') continue; // Safety check

            const orphaned = await this.prisma.mapping.updateMany({
                where: {
                    clinicId,
                    entityType: type,
                    externalId: { notIn: activeIds },
                    status: { not: 'ORPHAN' }
                },
                data: {
                    status: 'ORPHAN',
                    lastError: 'Registro não encontrado na última sincronização com a Doctoralia.'
                }
            });

            if (orphaned.count > 0) {
                await this.logEvent(syncRunId, type, 'cleanup_orphans', `Marked ${orphaned.count} ${type.toLowerCase()}(s) as ORPHAN`);
            }
        }
    }

    private async updateSyncStatus(id: string, status: string) {
        await this.prisma.syncRun.update({ where: { id }, data: { status } });
    }

    private async logEvent(syncRunId: string, entityType: string, action: string, message: string) {
        await this.prisma.syncEvent.create({
            data: { syncRunId, entityType, action, message }
        });
    }

    private async completeSync(id: string, totalRecords = 0) {
        await this.prisma.syncRun.update({
            where: { id },
            data: {
                status: 'completed',
                endedAt: new Date(),
                totalRecords
            }
        });
    }
}
