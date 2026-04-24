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

            // Conta convênios LINKED da clínica para decidir o insurance_support do endereço.
            // CRÍTICO: 'private' faz a página pública mostrar "só aceita pacientes particulares".
            // Valores aceitos pela API: 'private', 'insurance', 'private_and_insurance'.
            const linkedInsuranceCount = await this.prisma.mapping.count({
                where: { clinicId, entityType: 'INSURANCE', status: 'LINKED' },
            });
            const desiredInsuranceSupport = linkedInsuranceCount > 0 ? 'private_and_insurance' : 'private';

            for (const addr of doctoraliaAddresses) {
                const addrId = String(addr.id);

                // 2. UPDATE ADDRESS USING CLINIC CONFIG
                try {
                    let street = '';
                    if (clinic.addressStreet) {
                        street = clinic.addressStreet;
                        if (clinic.addressNumber) street += `, ${clinic.addressNumber}`;
                        if (clinic.addressComplement) street += ` - ${clinic.addressComplement}`;
                        if (clinic.addressNeighborhood) street += ` (${clinic.addressNeighborhood})`;
                    }

                    const addressPayload: any = {
                        insurance_support: desiredInsuranceSupport,
                    };

                    // Only send fields that have data (avoid sending empty strings)
                    if (street) addressPayload.street = street;
                    if (clinic.addressCity) addressPayload.city_name = clinic.addressCity;
                    if (clinic.addressZipCode) addressPayload.post_code = clinic.addressZipCode;

                    await client.updateAddress(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, addressPayload);
                    this.logger.log(`Doctor ${dDoc.name}: [ADDR] Updated address ${addrId} with clinic config (insurance_support=${desiredInsuranceSupport})`);
                    await this.logEvent(syncRunId, 'ADDRESS_PUSH', 'updated', `Doctor ${dDoc.name}: Endereço ${addrId} atualizado (insurance_support=${desiredInsuranceSupport})`);
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
                    const slotResult = await this.slotSync.syncSlotsForDoctor(vDoc.id, client, syncRunId, 30, clinicId);
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
            if (syncRunId) await this.logEvent(syncRunId, 'INSURANCE_PUSH', 'skipped', `Doctor ${doctorName} addr ${addressId}: nenhum convênio LINKED na clínica`);
            return result;
        }

        const desiredProviderIds = new Set(linkedInsuranceMappings.map(m => String(m.externalId)));

        let currentProviders: any[] = [];
        try {
            const res = await client.getAddressInsuranceProviders(facilityId, doctorId, addressId);
            currentProviders = res._items || [];
        } catch (error: any) {
            this.logger.warn(`Doctor ${doctorName}: failed to fetch current insurance providers for address ${addressId}: ${error.message}`);
            if (syncRunId) await this.logEvent(syncRunId, 'INSURANCE_PUSH', 'error', `Doctor ${doctorName} addr ${addressId}: falha ao buscar convênios atuais - ${error.message}`);
            return result;
        }

        const currentProviderIds = new Set(currentProviders.map((p: any) => String(p.insurance_provider_id || p.id)));

        const stateSnapshot = currentProviders.map((p: any) => {
            const pid = String(p.insurance_provider_id || p.id);
            const plans = p.insurance_plans?._items || [];
            return `${pid}(${plans.length} planos)`;
        }).join(', ') || 'vazio';
        if (syncRunId) await this.logEvent(syncRunId, 'INSURANCE_PUSH', 'state', `Doctor ${doctorName} addr ${addressId}: desejados=[${[...desiredProviderIds].join(',')}], Doctoralia atual=[${stateSnapshot}]`);

        const toAdd = [...desiredProviderIds].filter(id => !currentProviderIds.has(id));
        const toRemove = [...currentProviderIds].filter(id => !desiredProviderIds.has(id));

        const defaultPlanCache = new Map<string, string | null>();
        const resolveDefaultPlanId = async (providerId: string): Promise<string | null> => {
            if (defaultPlanCache.has(providerId)) return defaultPlanCache.get(providerId)!;
            try {
                const plansRes = await client.getInsurancePlans(providerId);
                const items = plansRes?._items || [];
                const firstId = items.length > 0 ? String(items[0].insurance_plan_id) : null;
                defaultPlanCache.set(providerId, firstId);
                return firstId;
            } catch (error: any) {
                this.logger.warn(`Doctor ${doctorName}: [INS] Falha ao listar planos do provider ${providerId}: ${error.message}`);
                defaultPlanCache.set(providerId, null);
                return null;
            }
        };

        for (const providerId of toAdd) {
            try {
                const planId = await resolveDefaultPlanId(providerId);
                const plansArg = planId ? [{ insurance_plan_id: planId }] : undefined;
                await client.addAddressInsuranceProvider(facilityId, doctorId, addressId, providerId, plansArg);
                result.added++;
                const planTxt = planId ? ` (plano ${planId})` : ' (sem plano disponível)';
                this.logger.log(`Doctor ${doctorName}: [INS] Added insurance provider ${providerId} to address ${addressId}${planTxt}`);
                if (syncRunId) await this.logEvent(syncRunId, 'INSURANCE_PUSH', 'added', `Doctor ${doctorName} addr ${addressId}: convênio ${providerId} vinculado${planTxt}`);
            } catch (error: any) {
                if (error?.status === 400 && error?.message?.includes('already assigned')) {
                    result.unchanged++;
                    this.logger.debug(`Doctor ${doctorName}: insurance provider ${providerId} already on address ${addressId}`);
                    if (syncRunId) await this.logEvent(syncRunId, 'INSURANCE_PUSH', 'unchanged', `Doctor ${doctorName} addr ${addressId}: convênio ${providerId} já vinculado`);
                } else {
                    this.logger.warn(`Doctor ${doctorName}: [INS FAILED] Failed to add insurance provider ${providerId}: ${error.message}`);
                    if (syncRunId) await this.logEvent(syncRunId, 'INSURANCE_PUSH', 'error', `Doctor ${doctorName} addr ${addressId}: falha ao vincular convênio ${providerId} - ${error.message}`);
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

        // Garante pelo menos 1 plano para cada provider LINKED já existente (sem planos).
        // Não sobrescreve seleções manuais já configuradas no Doctoralia.
        let plansAdded = 0;
        for (const provider of currentProviders) {
            const providerId = String(provider.insurance_provider_id || provider.id);
            if (!desiredProviderIds.has(providerId)) continue;

            const existingPlans = provider.insurance_plans?._items || [];
            if (existingPlans.length > 0) continue;

            const planId = await resolveDefaultPlanId(providerId);
            if (!planId) continue;

            try {
                await client.putAddressInsuranceProvider(
                    facilityId, doctorId, addressId, providerId,
                    [{ insurance_plan_id: planId }]
                );
                plansAdded++;
                this.logger.log(`Doctor ${doctorName}: [INS] Plano ${planId} atribuído ao provider ${providerId} (estava sem plano)`);
            } catch (error: any) {
                this.logger.warn(`Doctor ${doctorName}: [INS] Falha ao definir plano padrão para provider ${providerId}: ${error.message}`);
            }
        }

        result.unchanged += [...desiredProviderIds].filter(id => currentProviderIds.has(id)).length;

        // Verificação pós-push (anti-regressão): re-busca providers e conta os LINKED sem plano.
        // Convênios sem plano fazem a UI mostrar "Não disponível para agendamentos online".
        // Pequeno delay evita falso-positivo por propagação interna do Doctoralia logo após PUT.
        let providersWithoutPlans = 0;
        const providersMissingPlanIds: string[] = [];
        try {
            await new Promise(r => setTimeout(r, 500));
            const verify = await client.getAddressInsuranceProviders(facilityId, doctorId, addressId);
            const verifyItems = verify._items || [];
            for (const p of verifyItems) {
                const pid = String(p.insurance_provider_id || p.id);
                if (!desiredProviderIds.has(pid)) continue;
                const plans = p.insurance_plans?._items || [];
                if (plans.length === 0) {
                    providersWithoutPlans++;
                    providersMissingPlanIds.push(pid);
                }
            }
        } catch (error: any) {
            this.logger.warn(`Doctor ${doctorName}: [INS] Pós-push: falha ao re-verificar providers - ${error.message}`);
        }

        if (providersWithoutPlans > 0 && syncRunId) {
            await this.logEvent(
                syncRunId,
                'INSURANCE_PUSH',
                'regression_warning',
                `Doctor ${doctorName} addr ${addressId}: ${providersWithoutPlans} convênio(s) sem plano após push (IDs: ${providersMissingPlanIds.join(',')}). UI pública mostrará "Não disponível para agendamentos online".`
            );
            this.logger.warn(`Doctor ${doctorName} addr ${addressId}: REGRESSION WARNING - ${providersWithoutPlans} provider(s) sem plano: ${providersMissingPlanIds.join(',')}`);
        }

        (result as any).providersWithoutPlans = providersWithoutPlans;
        (result as any).providersMissingPlanIds = providersMissingPlanIds;

        const finalMsg = `Doctor ${doctorName} addr ${addressId}: concluído - added=${result.added}, removed=${result.removed}, planos auto-atribuídos=${plansAdded}, unchanged=${result.unchanged}, sem-plano=${providersWithoutPlans}`;
        this.logger.log(finalMsg);
        if (syncRunId) await this.logEvent(syncRunId, 'INSURANCE_PUSH', 'completed', finalMsg);

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
