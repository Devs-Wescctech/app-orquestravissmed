import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerClient } from '../integrations/docplanner.service';

@Injectable()
export class PushSyncService {
    private readonly logger = new Logger(PushSyncService.name);

    constructor(private prisma: PrismaService) { }

    async pushToDoctoralia(clinicId: string, syncRunId: string, client: DocplannerClient): Promise<void> {
        this.logger.log(`Starting REVERSE SYNC (Push) for clinic ${clinicId}`);

        const clinic = await this.prisma.clinic.findUnique({ where: { id: clinicId } });
        if (!clinic) {
            this.logger.error(`Clinic ${clinicId} not found, aborting REVERSE SYNC.`);
            return;
        }

        // 1. Get all actively mapped doctors for this clinic
        // In the current schema, mappings don't have clinicId directly, but we can filter by doctors belonging to VisMed Units.
        const mappings = await this.prisma.professionalUnifiedMapping.findMany({
            where: { isActive: true },
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
        for (const [dictId, specName] of expectedDictIds.entries()) {
            if (!currentByDictId.has(dictId)) {
                try {
                    const payload = {
                        service_id: dictId,
                        is_price_from: false,
                        is_visible: true,
                        default_duration: 30,
                        description: `Sincronizado via VisMed - ${specName}`
                    };
                    await client.addAddressService(facilityId, doctorId, addressId, payload);
                    this.logger.log(`Doctor ${doctorName}: [ADD] Service dict:${dictId} (${specName}) to Address ${addressId}`);
                    await this.logEvent(syncRunId, 'SERVICE_PUSH', 'created', `Doctor ${doctorName}: Adicionado serviço "${specName}" (dict:${dictId}) ao endereço ${addressId}`);
                } catch (error: any) {
                    this.logger.warn(`Doctor ${doctorName}: [ADD FAILED] Service dict:${dictId}: ${error.message}`);
                    await this.logEvent(syncRunId, 'SERVICE_PUSH', 'error', `Doctor ${doctorName}: Falha ao adicionar serviço "${specName}" (dict:${dictId}) - ${error.message}`);
                }
            }
        }

        // DELETE: Currently assigned but NOT expected by VisMed
        for (const [dictId, addrSvc] of currentByDictId.entries()) {
            if (!expectedDictIds.has(dictId)) {
                try {
                    const addrSvcId = String(addrSvc.id); // Use address_service ID for DELETE
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
