import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerClient } from '../integrations/docplanner.service';
import { SlotSyncService } from './slot-sync.service';

@Injectable()
export class PushSyncService {
    private readonly logger = new Logger(PushSyncService.name);

    constructor(
        private prisma: PrismaService,
        private slotSync: SlotSyncService,
    ) { }

    async pushToDoctoralia(clinicId: string, syncRunId: string, client: DocplannerClient): Promise<void> {
        this.logger.log(`Starting REVERSE SYNC (Push) for clinic ${clinicId}`);

        const clinic = await this.prisma.clinic.findUnique({ where: { id: clinicId } });
        if (!clinic) {
            this.logger.error(`Clinic ${clinicId} not found, aborting REVERSE SYNC.`);
            return;
        }

        const clinicDoctorMappings = await this.prisma.mapping.findMany({
            where: { clinicId, entityType: 'DOCTOR' },
            select: { vismedId: true },
        });
        const clinicDoctorIds = clinicDoctorMappings.map(m => m.vismedId).filter(Boolean) as string[];

        const mappings = await this.prisma.professionalUnifiedMapping.findMany({
            where: {
                isActive: true,
                vismedDoctorId: { in: clinicDoctorIds },
            },
            include: {
                vismedDoctor: {
                    include: {
                        unit: true,
                        specialties: {
                            include: {
                                specialty: {
                                    include: {
                                        mappings: {
                                            where: { isActive: true },
                                            include: { doctoraliaService: true },
                                            take: 1
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                doctoraliaDoctor: {
                    include: {
                        addressServices: true
                    }
                }
            }
        });

        this.logger.log(`Found ${mappings.length} actively mapped doctors for push sync.`);

        for (const mapping of mappings) {
            const vDoc = mapping.vismedDoctor;
            const dDoc = mapping.doctoraliaDoctor;

            if (!vDoc.unit) {
                this.logger.warn(`VisMed Doctor ${vDoc.name} has no Unit. Skipping push...`);
                continue;
            }

            // We need the doctoralia address IDs to sync. 
            // Vismed currently doesn't map VisMedUnit to DoctoraliaAddress 1:1, 
            // but Doctoralia doctors belong to a Facility which has Addresses.
            // Let's get the active addresses for the doctor on Doctoralia.
            let doctoraliaAddresses = [];
            try {
                const addrsRes = await client.getAddresses(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId);
                doctoraliaAddresses = addrsRes._items || [];
            } catch (error: any) {
                this.logger.error(`Error fetching addresses for doctor ${dDoc.name}: ${error.message}`);
                continue;
            }

            for (const addr of doctoraliaAddresses) {
                const addrId = String(addr.id);

                // 2. UPDATE ADDRESS USING CLINIC CONFIG
                // Sempre envia PATCH com insurance_support: 'private' (field obrigatório da API v3, snake_case)
                try {
                    let street = '';
                    if (clinic.addressStreet) {
                        street = clinic.addressStreet;
                        if (clinic.addressNumber) street += `, ${clinic.addressNumber}`;
                        if (clinic.addressComplement) street += ` - ${clinic.addressComplement}`;
                        if (clinic.addressNeighborhood) street += ` (${clinic.addressNeighborhood})`;
                    }

                    const addressPayload: any = {
                        insurance_support: addr.insurance_support || 'private',
                    };

                    // Only send fields that have data (avoid sending empty strings)
                    if (street) addressPayload.street = street;
                    if (clinic.addressCity) addressPayload.city_name = clinic.addressCity;
                    if (clinic.addressZipCode) addressPayload.post_code = clinic.addressZipCode;

                    await client.updateAddress(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, addressPayload);
                    this.logger.log(`Doctor ${dDoc.name}: [ADDR] Updated address ${addrId} with clinic config`);
                    await this.logEvent(syncRunId, 'ADDRESS_PUSH', 'updated', `Doctor ${dDoc.name}: Endereço ${addrId} atualizado com dados da clínica`);
                } catch (error: any) {
                    this.logger.warn(`Doctor ${dDoc.name}: [ADDR FAILED] Address ${addrId}: ${error.message}`);
                    await this.logEvent(syncRunId, 'ADDRESS_PUSH', 'error', `Doctor ${dDoc.name}: Falha ao atualizar endereço ${addrId} - ${error.message}`);
                }

                // 3. SERVICES DELTA
                await this.syncServicesDelta(syncRunId, client, dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, vDoc.specialties, dDoc.name);

                // 4. INSURANCE PROVIDERS SYNC
                await this.syncInsuranceProviders(syncRunId, client, clinicId, dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, dDoc.name);
            }

            // 5. SLOT SYNC (turnos VisMed → slots Doctoralia) — always runs
            try {
                if (vDoc.turnoM || vDoc.turnoT || vDoc.turnoN) {
                    const slotResult = await this.slotSync.syncSlotsForDoctor(vDoc.id, client, syncRunId, 30);
                    this.logger.log(`Doctor ${dDoc.name}: [SLOTS] ${slotResult.message}`);
                    if (slotResult.success) {
                        const doctorMapping = await this.prisma.mapping.findFirst({
                            where: { clinicId, entityType: 'DOCTOR', vismedId: vDoc.id, status: 'LINKED' }
                        });
                        if (doctorMapping) {
                            const existing = (doctorMapping.conflictData as any) || {};
                            await this.prisma.mapping.update({
                                where: { id: doctorMapping.id },
                                data: { conflictData: { ...existing, calendarStatus: 'enabled' } }
                            });
                        }
                    }
                } else {
                    this.logger.warn(`Doctor ${dDoc.name}: [SLOTS] No shifts configured in VisMed, skipping slot generation.`);
                    await this.logEvent(syncRunId, 'SLOT_SYNC', 'skipped', `Doctor ${dDoc.name}: Sem turnos configurados no VisMed`);
                }
            } catch (error: any) {
                this.logger.warn(`Doctor ${dDoc.name}: [SLOTS FAILED] ${error.message}`);
                await this.logEvent(syncRunId, 'SLOT_SYNC', 'error', `Doctor ${dDoc.name}: Falha no sync de slots - ${error.message}`);
            }
        }

        this.logger.log(`REVERSE SYNC completed.`);
    }

    private async syncServicesDelta(
        syncRunId: string,
        client: DocplannerClient,
        facilityId: string,
        doctorId: string,
        addressId: string,
        vismedSpecialties: any[],
        doctorName: string
    ) {
        // Fetch current address services from Doctoralia
        let currentServices = [];
        try {
            const res = await client.getServices(facilityId, doctorId, addressId);
            currentServices = res._items || [];
        } catch (error: any) {
            this.logger.error(`Doctor ${doctorName}: Failed to fetch current services for address ${addressId}: ${error.message}`);
            return;
        }

        // Map current services by their dictionary service_id (not address_service id)
        // Each address_service has: id (address_service_id), service_id (dictionary_id)
        const currentByDictId = new Map<string, any>(); // dict_id -> address_service object
        for (const svc of currentServices) {
            const dictId = String(svc.service_id || svc.id);
            currentByDictId.set(dictId, svc);
        }

        // Build expected services from VisMed specialties with active mappings
        // The mapping.doctoraliaService.doctoraliaServiceId IS the dictionary ID
        const expectedDictIds = new Map<string, string>(); // dict_id -> specialty_name
        const matchedNames = [];

        for (const vs of vismedSpecialties) {
            const spec = vs.specialty;
            if (spec && spec.mappings && spec.mappings.length > 0) {
                const mapping = spec.mappings[0];
                const dictId = mapping.doctoraliaService.doctoraliaServiceId;
                expectedDictIds.set(dictId, spec.name);
                matchedNames.push(`${spec.name} (→ dict:${dictId})`);
            }
        }

        this.logger.log(`Doctor ${doctorName}: VisMed expects ${expectedDictIds.size} service(s): [${matchedNames.join(', ')}]. Currently has ${currentServices.length} service(s).`);

        // ADD: Expected by VisMed but NOT currently assigned
        const addedDictIds = new Set<string>();
        const failedDictIds = new Set<string>();
        for (const [dictId, specName] of expectedDictIds.entries()) {
            if (!currentByDictId.has(dictId)) {
                const numericId = Number(dictId);
                if (!Number.isFinite(numericId)) {
                    this.logger.warn(`Doctor ${doctorName}: [SKIP] Service dict:${dictId} (${specName}) has non-numeric ID, skipping.`);
                    failedDictIds.add(dictId);
                    continue;
                }
                try {
                    const payload = {
                        service_id: numericId,
                        is_price_from: false,
                        is_visible: true,
                        default_duration: 30,
                        description: `Sincronizado via VisMed - ${specName}`
                    };
                    await client.addAddressService(facilityId, doctorId, addressId, payload);
                    addedDictIds.add(dictId);
                    this.logger.log(`Doctor ${doctorName}: [ADD] Service dict:${dictId} (${specName}) to Address ${addressId}`);
                    await this.logEvent(syncRunId, 'SERVICE_PUSH', 'created', `Doctor ${doctorName}: Adicionado serviço "${specName}" (dict:${dictId}) ao endereço ${addressId}`);
                } catch (error: any) {
                    failedDictIds.add(dictId);
                    this.logger.warn(`Doctor ${doctorName}: [ADD FAILED] Service dict:${dictId}: ${error.message}`);
                    await this.logEvent(syncRunId, 'SERVICE_PUSH', 'error', `Doctor ${doctorName}: Falha ao adicionar serviço "${specName}" (dict:${dictId}) - ${error.message}`);
                }
            }
        }

        // DELETE: Currently assigned but NOT expected by VisMed
        // SAFETY: Only delete if ALL expected adds succeeded. If any add failed, keep existing
        // services to avoid leaving the doctor with zero services (which breaks slots).
        if (failedDictIds.size > 0) {
            this.logger.log(`Doctor ${doctorName}: [SKIP DELETE] ${failedDictIds.size} service add(s) failed, keeping existing services to avoid service gap.`);
        } else {
            for (const [dictId, addrSvc] of currentByDictId.entries()) {
                if (!expectedDictIds.has(dictId)) {
                    try {
                        const addrSvcId = String(addrSvc.id);
                        await client.deleteAddressService(facilityId, doctorId, addressId, addrSvcId);
                        this.logger.log(`Doctor ${doctorName}: [DELETE] Service addr_svc:${addrSvcId} (dict:${dictId}) from Address ${addressId}`);
                        await this.logEvent(syncRunId, 'SERVICE_PUSH', 'deleted', `Doctor ${doctorName}: Removido serviço excessivo (dict:${dictId}) do endereço ${addressId}`);
                    } catch (error: any) {
                        this.logger.warn(`Doctor ${doctorName}: [DELETE FAILED] Service addr_svc:${addrSvc.id}: ${error.message}`);
                        await this.logEvent(syncRunId, 'SERVICE_PUSH', 'error', `Doctor ${doctorName}: Falha ao remover serviço (dict:${dictId}) - ${error.message}`);
                    }
                }
            }
        }
    }

    async syncInsuranceProviders(
        syncRunId: string | null,
        client: DocplannerClient,
        clinicId: string,
        facilityId: string,
        doctorId: string,
        addressId: string,
        doctorName: string
    ): Promise<{ added: number; removed: number; unchanged: number }> {
        const result = { added: 0, removed: 0, unchanged: 0 };

        const linkedInsuranceMappings = await this.prisma.mapping.findMany({
            where: { clinicId, entityType: 'INSURANCE', status: 'LINKED', externalId: { not: null } },
        });

        if (linkedInsuranceMappings.length === 0) {
            this.logger.log(`Doctor ${doctorName}: [INS] Nenhum convênio LINKED para sincronizar. Aprove convênios pendentes na tela de Mapeamentos.`);
            return result;
        }

        const desiredProviderIds = new Set(linkedInsuranceMappings.map(m => String(m.externalId)));

        let currentProviders: any[] = [];
        try {
            const res = await client.getAddressInsuranceProviders(facilityId, doctorId, addressId);
            currentProviders = res._items || [];
        } catch (error: any) {
            this.logger.warn(`Doctor ${doctorName}: failed to fetch current insurance providers for address ${addressId}: ${error.message}`);
            return result;
        }

        const currentProviderIds = new Set(currentProviders.map((p: any) => String(p.insurance_provider_id || p.id)));

        const toAdd = [...desiredProviderIds].filter(id => !currentProviderIds.has(id));
        const toRemove = [...currentProviderIds].filter(id => !desiredProviderIds.has(id));

        for (const providerId of toAdd) {
            try {
                await client.addAddressInsuranceProvider(facilityId, doctorId, addressId, providerId);
                result.added++;
                this.logger.log(`Doctor ${doctorName}: [INS] Added insurance provider ${providerId} to address ${addressId}`);
            } catch (error: any) {
                if (error?.status === 400 && error?.message?.includes('already assigned')) {
                    result.unchanged++;
                    this.logger.debug(`Doctor ${doctorName}: insurance provider ${providerId} already on address ${addressId}`);
                } else {
                    this.logger.warn(`Doctor ${doctorName}: [INS FAILED] Failed to add insurance provider ${providerId}: ${error.message}`);
                }
            }
        }

        for (const providerId of toRemove) {
            try {
                await client.deleteAddressInsuranceProvider(facilityId, doctorId, addressId, providerId);
                result.removed++;
                this.logger.log(`Doctor ${doctorName}: [INS] Removed insurance provider ${providerId} from address ${addressId}`);
            } catch (error: any) {
                this.logger.warn(`Doctor ${doctorName}: [INS FAILED] Failed to remove insurance provider ${providerId}: ${error.message}`);
            }
        }

        result.unchanged += [...desiredProviderIds].filter(id => currentProviderIds.has(id)).length;

        if (result.added > 0 || result.removed > 0) {
            const msg = `Doctor ${doctorName}: Insurance sync - added ${result.added}, removed ${result.removed}, unchanged ${result.unchanged}`;
            this.logger.log(msg);
            if (syncRunId) await this.logEvent(syncRunId, 'INSURANCE_PUSH', 'synced', msg);
        }

        return result;
    }

    private async logEvent(syncRunId: string, entityType: string, action: string, message: string) {
        try {
            await this.prisma.syncEvent.create({
                data: {
                    syncRunId,
                    entityType,
                    action,
                    externalId: 'N/A',
                    message
                }
            });
        } catch (e) {
            this.logger.error(`Failed to write push log event: ${e}`);
        }
    }
}
