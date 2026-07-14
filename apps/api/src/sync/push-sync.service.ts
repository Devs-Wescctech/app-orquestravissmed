import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerClient } from '../integrations/docplanner.service';
import { SlotSyncService } from './slot-sync.service';
import { VismedAvailabilityService, ClinicAvailability } from './vismed-availability.service';

@Injectable()
export class PushSyncService {
    private readonly logger = new Logger(PushSyncService.name);

    constructor(
        private prisma: PrismaService,
        private slotSync: SlotSyncService,
        private availabilityService: VismedAvailabilityService,
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
                                            // Apenas mappings JÁ APROVADOS são empurrados para a Doctoralia.
                                            // Mappings com requiresReview=true (score 0.60-0.89) ficam de fora
                                            // até serem confirmados manualmente em /mapping → Especialidades.
                                            where: { isActive: true, requiresReview: false },
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

        // Cache do catálogo de serviços POR UNIDADE (facility). É a fonte de verdade dos
        // service_id que a unidade aceita — só empurramos IDs presentes aqui. Evita mandar
        // IDs do dicionário global que a unidade não conhece (404 "ItemService object not found").
        // Valor `null` = catálogo indisponível/falha de fetch → NÃO enforçamos (fail-open) para
        // não bloquear serviços válidos; o handler de rejeição 404 abaixo ainda protege o loop.
        const facilityCatalogCache = new Map<string, Set<string> | null>();

        // Disponibilidade real (scheduleDay) da clínica — construída UMA vez e reusada por todos
        // os médicos. Reflete bloqueios de agenda da VisMed. Pulada no modo legado (template).
        const slotSourceTemplate = (process.env.SLOT_SOURCE || 'availability').toLowerCase() === 'template';
        let availability: ClinicAvailability | null = null;
        if (!slotSourceTemplate) {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() + 1);
            const dates = this.slotSync.generateDateRange(startDate, 30);
            availability = await this.availabilityService.buildForClinic(clinicId, dates);
        }

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

            // Resolve (uma vez por facility) o conjunto de service_id aceitos pela unidade.
            const facilityCatalogIds = await this.resolveFacilityCatalogIds(client, dDoc.doctoraliaFacilityId, facilityCatalogCache);

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
                await this.syncServicesDelta(syncRunId, client, dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, vDoc.specialties, dDoc.name, facilityCatalogIds);

                // 4. INSURANCE PROVIDERS SYNC
                await this.syncInsuranceProviders(syncRunId, client, clinicId, dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, dDoc.name);
            }

            // 5. SLOT SYNC (disponibilidade VisMed → slots Doctoralia) — always runs.
            // No modo availability (padrão), a fonte é o scheduleDay e não dependemos de turnos.
            // No modo template (legado), só roda se houver turno_m/t/n configurado.
            try {
                if (!slotSourceTemplate || vDoc.turnoM || vDoc.turnoT || vDoc.turnoN) {
                    const slotResult = await this.slotSync.syncSlotsForDoctor(vDoc.id, client, syncRunId, 30, clinicId, availability);
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
        doctorName: string,
        facilityCatalogIds: Set<string> | null,
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
        const expectedDictIds = new Map<string, { specName: string; mappingId: string }>(); // dict_id -> mapping info
        const matchedNames = [];

        for (const vs of vismedSpecialties) {
            const spec = vs.specialty;
            if (spec && spec.mappings && spec.mappings.length > 0) {
                const mapping = spec.mappings[0];
                const dictId = mapping.doctoraliaService.doctoraliaServiceId;
                expectedDictIds.set(dictId, { specName: spec.name, mappingId: mapping.id });
                matchedNames.push(`${spec.name} (→ dict:${dictId})`);
            }
        }

        // Log explícito de mappings PENDENTES de aprovação que foram pulados (visibilidade operacional).
        // Conta diretamente no banco quantas especialidades do médico estão com requiresReview=true.
        const pendingSpecialtyIds = vismedSpecialties
            .map(vs => vs.specialty?.id)
            .filter((id: any) => typeof id === 'string');
        if (pendingSpecialtyIds.length > 0) {
            const pendingMappings = await this.prisma.specialtyServiceMapping.findMany({
                where: { isActive: true, requiresReview: true, vismedSpecialtyId: { in: pendingSpecialtyIds } },
                include: { vismedSpecialty: { select: { name: true } }, doctoraliaService: { select: { name: true } } },
            });
            if (pendingMappings.length > 0) {
                const desc = pendingMappings.map(m => `"${m.vismedSpecialty?.name}" → "${m.doctoraliaService?.name}" (${Math.round(m.confidenceScore * 100)}%)`).join('; ');
                this.logger.warn(`Doctor ${doctorName}: [SKIP PENDING] ${pendingMappings.length} mapping(s) aguardando aprovação manual em /mapping → Especialidades: ${desc}`);
                await this.logEvent(syncRunId, 'SERVICE_PUSH', 'skipped_pending_review', `Doctor ${doctorName}: ${pendingMappings.length} mapping(s) ignorado(s) - aguarda aprovação manual: ${desc}`);
            }
        }

        this.logger.log(`Doctor ${doctorName}: VisMed expects ${expectedDictIds.size} service(s): [${matchedNames.join(', ')}]. Currently has ${currentServices.length} service(s).`);

        // ADD: Expected by VisMed but NOT currently assigned
        const addedDictIds = new Set<string>();
        const failedDictIds = new Set<string>();
        for (const [dictId, { specName, mappingId }] of expectedDictIds.entries()) {
            if (!currentByDictId.has(dictId)) {
                const numericId = Number(dictId);
                if (!Number.isFinite(numericId)) {
                    this.logger.warn(`Doctor ${doctorName}: [SKIP] Service dict:${dictId} (${specName}) has non-numeric ID, skipping.`);
                    failedDictIds.add(dictId);
                    continue;
                }

                // GUARD ANTI address_service id: se o id que iríamos enviar é na verdade um id de
                // VÍNCULO serviço↔endereço (address_service), o dicionário está contaminado (bug de
                // ingestão antigo) e o POST retornaria 404. Nunca enviar esse id.
                // Premissa: na Docplanner os espaços de id são disjuntos na prática (dicionário
                // global ~10k ids baixos vs address_service ids sequenciais na casa dos milhões);
                // se houver colisão improvável, o efeito é conservador e visível ao operador
                // (mapping marcado com invalidReason para revisão em /mapping, sem POST 404).
                const isLinkId = await this.prisma.doctoraliaAddressService.findUnique({
                    where: { doctoraliaAddressServiceId: dictId },
                    select: { id: true },
                });
                if (isLinkId) {
                    failedDictIds.add(dictId);
                    const reason = `id ${dictId} é um address_service id (vínculo serviço↔endereço), não um service_id do dicionário — mapping inválido`;
                    this.logger.warn(`Doctor ${doctorName}: [SKIP LINK ID] Service dict:${dictId} (${specName}) — ${reason}`);
                    await this.markMappingInvalid(mappingId, reason);
                    await this.logEvent(syncRunId, 'SERVICE_PUSH', 'invalid_service_id', `Doctor ${doctorName}: "${specName}" (dict:${dictId}) é um address_service id, não um service_id — mapping marcado para revisão em /mapping.`);
                    continue;
                }

                // GATE POR CATÁLOGO DA UNIDADE (fonte de verdade). Se o catálogo foi resolvido e o
                // dict_id NÃO está nele, a unidade não aceita esse serviço → NÃO fazemos o POST
                // (que retornaria 404 "ItemService object not found" a cada ciclo). Marcamos o mapping
                // como inválido para o cron parar de reenviar e o operador remapear em /mapping.
                if (facilityCatalogIds && !facilityCatalogIds.has(dictId)) {
                    failedDictIds.add(dictId);
                    const reason = `service_id ${dictId} não existe no catálogo da unidade ${facilityId} (não aceito pela Doctoralia)`;
                    this.logger.warn(`Doctor ${doctorName}: [SKIP NOT IN CATALOG] Service dict:${dictId} (${specName}) — ${reason}`);
                    await this.markMappingInvalid(mappingId, reason);
                    await this.logEvent(syncRunId, 'SERVICE_PUSH', 'invalid_service_id', `Doctor ${doctorName}: "${specName}" (dict:${dictId}) fora do catálogo da unidade — mapping marcado para revisão em /mapping.`);
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
                    // Rejeição do service_id pela Doctoralia (404 / "ItemService object not found") NÃO é
                    // erro transitório: significa que a unidade não aceita esse ID. Marcar o mapping como
                    // inválido faz o cron parar de reenviar o mesmo POST inválido a cada 30 min.
                    if (this.isServiceIdRejected(error)) {
                        const reason = `service_id ${dictId} rejeitado pela Doctoralia (${this.shortError(error.message)})`;
                        await this.markMappingInvalid(mappingId, reason);
                        this.logger.warn(`Doctor ${doctorName}: [ADD REJECTED] Service dict:${dictId} (${specName}) — ${reason}. Mapping marcado para revisão.`);
                        await this.logEvent(syncRunId, 'SERVICE_PUSH', 'invalid_service_id', `Doctor ${doctorName}: "${specName}" (dict:${dictId}) rejeitado pela Doctoralia — mapping marcado para revisão em /mapping.`);
                    } else {
                        this.logger.warn(`Doctor ${doctorName}: [ADD FAILED] Service dict:${dictId}: ${error.message}`);
                        await this.logEvent(syncRunId, 'SERVICE_PUSH', 'error', `Doctor ${doctorName}: Falha ao adicionar serviço "${specName}" (dict:${dictId}) - ${error.message}`);
                    }
                }
            }
        }

        // DELETE: Currently assigned but NOT expected by VisMed
        // SAFETY 1: Only delete if ALL expected adds succeeded. If any add failed, keep existing
        // services to avoid leaving the doctor with zero services (which breaks slots).
        // SAFETY 2: Se VisMed não tem NENHUM mapping aprovado para esse médico (expectedDictIds vazio),
        // NÃO deletar nada — caso contrário removeríamos todos os serviços atuais do médico em Doctoralia,
        // quebrando os slots. Cenário típico: todos os mappings da especialidade estão pending review.
        if (failedDictIds.size > 0) {
            this.logger.log(`Doctor ${doctorName}: [SKIP DELETE] ${failedDictIds.size} service add(s) failed, keeping existing services to avoid service gap.`);
        } else if (expectedDictIds.size === 0) {
            this.logger.warn(`Doctor ${doctorName}: [SKIP DELETE] VisMed não tem nenhum mapping aprovado — preservando ${currentServices.length} serviço(s) atual(is) em Doctoralia para não quebrar slots. Aprove mappings em /mapping → Especialidades.`);
            await this.logEvent(syncRunId, 'SERVICE_PUSH', 'skipped_no_approved_mapping', `Doctor ${doctorName}: deleção de ${currentServices.length} serviço(s) bloqueada — nenhum mapping de especialidade aprovado.`);
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

    /**
     * Resolve (com cache por facility) o conjunto de service_id (dict IDs) que a UNIDADE aceita,
     * via GET /facilities/{id}/services/catalog. Retorna `null` quando o catálogo não pôde ser
     * obtido ou veio vazio — nesse caso o chamador NÃO deve enforçar o gate (fail-open), para não
     * bloquear serviços válidos por causa de uma falha de rede ou resposta inesperada.
     */
    private async resolveFacilityCatalogIds(
        client: DocplannerClient,
        facilityId: string,
        cache: Map<string, Set<string> | null>,
    ): Promise<Set<string> | null> {
        if (cache.has(facilityId)) return cache.get(facilityId)!;

        let ids: Set<string> | null = null;
        try {
            const res = await client.getFacilityServicesCatalog(facilityId);
            const items = res?._items || [];
            if (items.length > 0) {
                ids = new Set<string>();
                for (const item of items) {
                    // O catálogo lista os ItemService da unidade; o dict_id costuma vir em
                    // `service_id` ou `id`. Guardamos ambos por segurança.
                    if (item.service_id != null) ids.add(String(item.service_id));
                    if (item.id != null) ids.add(String(item.id));
                }
                this.logger.log(`Facility ${facilityId}: catálogo com ${items.length} serviço(s) aceitos resolvido.`);
            } else {
                this.logger.warn(`Facility ${facilityId}: catálogo de serviços vazio/indisponível — gate por catálogo desabilitado (fail-open).`);
            }
        } catch (error: any) {
            this.logger.warn(`Facility ${facilityId}: falha ao buscar catálogo de serviços (${error.message}) — gate por catálogo desabilitado (fail-open).`);
        }

        cache.set(facilityId, ids);
        return ids;
    }

    /**
     * Detecta rejeição definitiva de um service_id pela Doctoralia: 404 e/ou a mensagem
     * "ItemService object not found". Não é erro transitório — o ID não é aceito pela unidade.
     */
    private isServiceIdRejected(error: any): boolean {
        const status = error?.status ?? 0;
        const msg = String(error?.message || '');
        return status === 404 || /ItemService object not found/i.test(msg);
    }

    private shortError(message?: string): string {
        const m = String(message || '').trim();
        return m.length > 160 ? `${m.slice(0, 157)}...` : m;
    }

    /**
     * Sinaliza um SpecialtyServiceMapping como inválido: registra o motivo e o remove do
     * push automático (requiresReview=true), sem apagá-lo. Aparece em /mapping para reaprovação
     * ou remapeamento manual com o service_id correto do catálogo da unidade.
     */
    private async markMappingInvalid(mappingId: string, reason: string): Promise<void> {
        try {
            await this.prisma.specialtyServiceMapping.update({
                where: { id: mappingId },
                data: { invalidReason: reason, invalidAt: new Date(), requiresReview: true },
            });
        } catch (e: any) {
            this.logger.error(`Falha ao marcar mapping ${mappingId} como inválido: ${e.message}`);
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
