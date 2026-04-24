import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerClient } from '../integrations/docplanner.service';

interface TurnoSlot {
    start: string;
    end: string;
}

@Injectable()
export class SlotSyncService {
    private readonly logger = new Logger(SlotSyncService.name);

    constructor(private prisma: PrismaService) {}

    parseTurno(turnoStr: string | null): TurnoSlot | null {
        if (!turnoStr || turnoStr.trim() === '-' || turnoStr.trim() === '') return null;
        const cleaned = turnoStr.trim().replace(/\s+/g, ' ');
        const match = cleaned.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
        if (!match) return null;
        const startH = parseInt(match[1], 10);
        const startM = parseInt(match[2], 10);
        const endH = parseInt(match[3], 10);
        const endM = parseInt(match[4], 10);

        if (startH < 0 || startH > 23 || startM < 0 || startM > 59 ||
            endH < 0 || endH > 23 || endM < 0 || endM > 59) return null;

        const startTotal = startH * 60 + startM;
        const endTotal = endH * 60 + endM;
        if (endTotal <= startTotal) return null;

        const start = `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}`;
        const end = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
        return { start, end };
    }

    buildDaySlots(date: string, turnoM: string | null, turnoT: string | null, turnoN: string | null, addressServiceIds: number[], timezone: string = '-03:00', slotDurationMinutes: number = 30, insuranceProviderIds: number[] = [], insurancePlanIds: number[] = []): any[] {
        const slots: any[] = [];
        const turnos = [turnoM, turnoT, turnoN];

        const uniqueServiceIds = [...new Set(addressServiceIds)];
        if (uniqueServiceIds.length === 0) return slots;

        for (const turno of turnos) {
            const parsed = this.parseTurno(turno);
            if (!parsed) continue;

            const slot: any = {
                start: `${date}T${parsed.start}:00${timezone}`,
                end: `${date}T${parsed.end}:00${timezone}`,
                address_services: uniqueServiceIds.map(id => ({
                    address_service_id: String(id),
                    duration: slotDurationMinutes,
                })),
            };

            if (insuranceProviderIds.length > 0) {
                const mode = (process.env.SLOT_INSURANCE_MODE || 'with-insurance-only').toLowerCase();
                if (mode === 'without-insurance-only') {
                    slot.insurance_accepted = 'without-insurance-only';
                } else if (mode === 'with-and-without-insurance') {
                    slot.insurance_accepted = 'with-and-without-insurance';
                    slot.insurance_providers = insuranceProviderIds;
                    if (insurancePlanIds.length > 0) slot.insurance_plans = insurancePlanIds;
                } else if (mode === 'none') {
                    slot.insurance_providers = insuranceProviderIds;
                    if (insurancePlanIds.length > 0) slot.insurance_plans = insurancePlanIds;
                } else {
                    slot.insurance_accepted = 'with-insurance-only';
                    slot.insurance_providers = insuranceProviderIds;
                    // CRITICAL: insurance_plans é OBRIGATÓRIO para a UI pública marcar a Unimed como
                    // "agendável online" (isBookable:true). Sem ele, o convênio aparece com a tag
                    // "(Não disponível para agendamentos online)" mesmo com providers vinculados.
                    if (insurancePlanIds.length > 0) slot.insurance_plans = insurancePlanIds;
                }
            }

            slots.push(slot);
        }
        return slots;
    }

    generateDateRange(startDate: Date, days: number): string[] {
        const dates: string[] = [];
        for (let i = 0; i < days; i++) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + i);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            dates.push(`${yyyy}-${mm}-${dd}`);
        }
        return dates;
    }

    async syncSlotsForDoctor(
        vismedDoctorId: string,
        client: DocplannerClient,
        syncRunId?: string,
        daysAhead: number = 30,
        clinicId?: string,
    ): Promise<{ success: boolean; message: string; slotsCreated: number }> {
        const whereClause: any = { id: vismedDoctorId };

        const doctor = await this.prisma.vismedDoctor.findUnique({
            where: whereClause,
            include: {
                specialties: {
                    include: {
                        specialty: {
                            include: {
                                mappings: {
                                    // Apenas mappings JÁ APROVADOS produzem slots na Doctoralia.
                                    // Mappings com requiresReview=true (score 0.60-0.89) ficam de fora
                                    // até serem confirmados manualmente em /mapping → Especialidades.
                                    where: { isActive: true, requiresReview: false },
                                    include: { doctoraliaService: true },
                                    take: 1,
                                }
                            }
                        }
                    }
                },
                unifiedMappings: {
                    where: { isActive: true },
                    include: {
                        doctoraliaDoctor: {
                            include: { addressServices: true }
                        }
                    }
                }
            }
        });

        if (!doctor) {
            return { success: false, message: 'Médico VisMed não encontrado.', slotsCreated: 0 };
        }

        if (clinicId) {
            const mapping = await this.prisma.mapping.findFirst({
                where: { vismedId: doctor.id, entityType: 'DOCTOR', clinicId },
            });
            if (!mapping) {
                return { success: false, message: `Médico ${doctor.name} não pertence a esta clínica.`, slotsCreated: 0 };
            }
        }

        if (!doctor.turnoM && !doctor.turnoT && !doctor.turnoN) {
            return { success: false, message: `Médico ${doctor.name} não possui turnos configurados no VisMed.`, slotsCreated: 0 };
        }

        if (doctor.unifiedMappings.length === 0) {
            return { success: false, message: `Médico ${doctor.name} não está vinculado à Doctoralia.`, slotsCreated: 0 };
        }

        let selectedMapping = doctor.unifiedMappings[0];
        if (clinicId && doctor.unifiedMappings.length > 1) {
            const clinicDoctorMappings = await this.prisma.mapping.findMany({
                where: { clinicId, entityType: 'DOCTOR' },
                select: { vismedId: true },
            });
            const clinicVismedIds = new Set(clinicDoctorMappings.map(m => m.vismedId).filter(Boolean));
            const clinicScoped = doctor.unifiedMappings.find(um => clinicVismedIds.has(um.vismedDoctorId));
            if (clinicScoped) selectedMapping = clinicScoped;
        }

        let totalSlots = 0;
        let addressesAttempted = 0;
        let addressesFailed = 0;
        const dDoc = selectedMapping.doctoraliaDoctor;

        let doctoraliaAddresses: any[];
        try {
            const res = await client.getAddresses(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId);
            doctoraliaAddresses = res._items || [];
        } catch (error: any) {
            const msg = `Falha ao buscar endereços Doctoralia para ${doctor.name}: ${error.message}`;
            this.logger.error(msg);
            if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'error', msg);
            return { success: false, message: msg, slotsCreated: 0 };
        }

        if (doctoraliaAddresses.length === 0) {
            return { success: false, message: `Médico ${doctor.name} não possui endereços na Doctoralia.`, slotsCreated: 0 };
        }

        const startDate = new Date();
        startDate.setDate(startDate.getDate() + 1);
        const dates = this.generateDateRange(startDate, daysAhead);

        // Cache de plan_id por provider_id (escopo: este médico). Evita N+1 quando o mesmo provider
        // aparece em múltiplos endereços. Valor -1 significa "consultado e sem planos disponíveis".
        const planCache = new Map<number, number>();

        for (const addr of doctoraliaAddresses) {
            const addrId = String(addr.id);
            addressesAttempted++;

            let addressServices: any[];
            try {
                const svcRes = await client.getServices(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId);
                addressServices = svcRes._items || [];
            } catch (error: any) {
                this.logger.warn(`Failed to get services for addr ${addrId}: ${error.message}`);
                addressesFailed++;
                continue;
            }

            if (addressServices.length === 0) {
                this.logger.log(`Doctor ${doctor.name} address ${addrId}: no services found, attempting auto-provision from specialty mappings...`);
                const provisioned = await this.provisionAddressServices(doctor, client, dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, syncRunId);
                if (provisioned.length > 0) {
                    addressServices = provisioned;
                    this.logger.log(`Doctor ${doctor.name} address ${addrId}: provisioned ${provisioned.length} service(s) from specialty mappings`);
                } else {
                    this.logger.warn(`Doctor ${doctor.name} address ${addrId}: no specialty→service mappings available, skipping slot sync`);
                    continue;
                }
            }

            const seenServiceIds = new Set<string>();
            const deduplicatedServices = addressServices.filter((s: any) => {
                const key = String(s.service_id || s.id);
                if (seenServiceIds.has(key)) return false;
                seenServiceIds.add(key);
                return true;
            });
            const addressServiceIds = deduplicatedServices.map((s: any) => Number(s.id));
            this.logger.log(`Doctor ${doctor.name} address ${addrId}: using ${addressServiceIds.length} unique address_service_ids (from ${addressServices.length} total): ${addressServiceIds.join(', ')}`);

            // DEBUG: log detalhado do que a Doctoralia retornou para os serviços do endereço
            const debugSvcs = deduplicatedServices.map((s: any) =>
                `id=${s.id} service_id=${s.service_id} name="${s.service_name || s.name || '?'}" duration=${s.duration || s.default_duration || '?'}`
            ).join(' | ');
            if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'services_inspection', `Doctor ${doctor.name} addr ${addrId}: Doctoralia retornou ${deduplicatedServices.length} address_service(s): ${debugSvcs}`);

            const invalidTurnos: string[] = [];
            for (const t of [doctor.turnoM, doctor.turnoT, doctor.turnoN]) {
                if (t && t.trim() !== '-' && t.trim() !== '' && !this.parseTurno(t)) {
                    invalidTurnos.push(t);
                }
            }
            if (invalidTurnos.length > 0) {
                this.logger.warn(`Doctor ${doctor.name}: skipping invalid turno(s): ${invalidTurnos.map(t => `"${t}"`).join(', ')}`);
            }

            let insuranceProviderIds: number[] = [];
            let insurancePlanIds: number[] = [];
            const omitInsurance = process.env.OMIT_INSURANCE_FROM_SLOTS === 'true';
            if (clinicId && !omitInsurance) {
                const linkedInsuranceMappings = await this.prisma.mapping.findMany({
                    where: { clinicId, entityType: 'INSURANCE', status: 'LINKED', externalId: { not: null } },
                });
                insuranceProviderIds = linkedInsuranceMappings
                    .map(m => parseInt(m.externalId!, 10))
                    .filter(id => !isNaN(id));

                // CRITICAL: para cada provider, busca o primeiro plano disponível na Doctoralia.
                // O slot precisa de `insurance_plans` para a página pública marcar o convênio
                // como "agendável online" (isBookable:true). Sem isso, a UI mostra a tag
                // "(Não disponível para agendamentos online)" mesmo com providers vinculados.
                // Cache evita N+1: o mesmo provider é consultado uma vez por sync (independe de quantos endereços/médicos).
                const seenPlans = new Set<number>();
                for (const providerId of insuranceProviderIds) {
                    if (planCache.has(providerId)) {
                        const cached = planCache.get(providerId)!;
                        if (cached > 0 && !seenPlans.has(cached)) {
                            insurancePlanIds.push(cached);
                            seenPlans.add(cached);
                        }
                        continue;
                    }
                    try {
                        const plansRes = await client.getInsurancePlans(String(providerId));
                        const firstPlan = plansRes?._items?.[0];
                        if (firstPlan?.id) {
                            const planIdNum = parseInt(String(firstPlan.id), 10);
                            if (!isNaN(planIdNum)) {
                                planCache.set(providerId, planIdNum);
                                if (!seenPlans.has(planIdNum)) {
                                    insurancePlanIds.push(planIdNum);
                                    seenPlans.add(planIdNum);
                                }
                            } else {
                                planCache.set(providerId, -1);
                            }
                        } else {
                            planCache.set(providerId, -1);
                            this.logger.warn(`Doctor ${doctor.name} address ${addrId}: provider ${providerId} sem planos disponíveis — slot pode aparecer como "não agendável online"`);
                        }
                    } catch (err: any) {
                        // não cacheia erro: pode ser transitório, próxima execução tenta de novo
                        this.logger.warn(`Doctor ${doctor.name} address ${addrId}: falha ao buscar planos do provider ${providerId}: ${err.message}`);
                    }
                }

                if (insuranceProviderIds.length > 0) {
                    this.logger.log(`Doctor ${doctor.name} address ${addrId}: including ${insuranceProviderIds.length} insurance provider(s): ${insuranceProviderIds.join(', ')} with ${insurancePlanIds.length} plan(s): ${insurancePlanIds.join(', ')}`);
                }
            } else if (omitInsurance) {
                this.logger.log(`Doctor ${doctor.name} address ${addrId}: OMIT_INSURANCE_FROM_SLOTS=true, slot será enviado sem insurance_providers (modo legado)`);
                if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'insurance_omitted', `Doctor ${doctor.name} addr ${addrId}: insurance_providers OMITIDO do payload (flag legacy)`);
            }

            const allSlots: any[] = [];
            for (const date of dates) {
                const daySlots = this.buildDaySlots(date, doctor.turnoM, doctor.turnoT, doctor.turnoN, addressServiceIds, '-03:00', 30, insuranceProviderIds, insurancePlanIds);
                allSlots.push(...daySlots);
            }

            if (allSlots.length === 0) continue;

            try {
                await client.enableCalendar(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId);
                this.logger.log(`Doctor ${doctor.name} address ${addrId}: calendar enabled`);
            } catch (enableErr: any) {
                const status = enableErr?.status;
                if (status === 409) {
                    this.logger.log(`Doctor ${doctor.name} address ${addrId}: calendar already enabled (409)`);
                } else if (status && status >= 400 && status < 500) {
                    this.logger.error(`Doctor ${doctor.name} address ${addrId}: calendar enable rejected (${status}): ${enableErr.message} — skipping slot sync for this address`);
                    addressesFailed++;
                    continue;
                } else {
                    this.logger.warn(`Doctor ${doctor.name} address ${addrId}: transient error enabling calendar: ${enableErr.message} — proceeding with slot sync`);
                }
            }

            try {
                const sampleSlot = JSON.stringify(allSlots[0]);
                this.logger.log(`Doctor ${doctor.name}: sending ${allSlots.length} work periods to address ${addrId} for ${dates.length} days. Sample: ${sampleSlot}`);
                if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'payload_sent', `Doctor ${doctor.name} addr ${addrId}: enviando ${allSlots.length} slots. Amostra: ${sampleSlot.substring(0, 400)}`);

                const putResponse = await client.replaceSlots(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, { slots: allSlots });
                const respStr = JSON.stringify(putResponse);
                this.logger.log(`Doctor ${doctor.name}: PUT slots response: ${respStr}`);
                if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'doctoralia_response', `Doctor ${doctor.name} addr ${addrId}: resposta Doctoralia: ${respStr.substring(0, 400)}`);

                totalSlots += allSlots.length;
                this.logger.log(`Doctor ${doctor.name}: synced ${allSlots.length} work periods to address ${addrId} for ${dates.length} days`);
                if (syncRunId) {
                    await this.logEvent(syncRunId, 'SLOT_SYNC', 'created', `Doctor ${doctor.name}: ${allSlots.length} slots sincronizados para endereço ${addrId}`);
                }
            } catch (error: any) {
                const msg = `Doctor ${doctor.name}: slot sync failed for address ${addrId}: ${error.message}`;
                this.logger.error(msg);
                addressesFailed++;
                if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'error', msg);
            }
        }

        if (totalSlots === 0 && addressesFailed > 0) {
            return {
                success: false,
                message: `Falha ao sincronizar slots para ${doctor.name}: ${addressesFailed}/${addressesAttempted} endereço(s) falharam.`,
                slotsCreated: 0,
            };
        }

        if (totalSlots === 0) {
            return {
                success: false,
                message: `Nenhum slot gerado para ${doctor.name}. Verifique serviços visíveis nos endereços.`,
                slotsCreated: 0,
            };
        }

        const partialNote = addressesFailed > 0 ? ` (${addressesFailed} endereço(s) com falha)` : '';
        return {
            success: true,
            message: `${totalSlots} slot(s) sincronizado(s) para ${doctor.name}.${partialNote}`,
            slotsCreated: totalSlots,
        };
    }

    async syncAllSlots(
        client: DocplannerClient,
        syncRunId?: string,
        daysAhead: number = 30,
        clinicId?: string,
    ): Promise<{ total: number; synced: number; errors: number }> {
        let doctorIdFilter: string[] | undefined;
        if (clinicId) {
            const clinicMappings = await this.prisma.mapping.findMany({
                where: { clinicId, entityType: 'DOCTOR' },
                select: { vismedId: true },
            });
            doctorIdFilter = clinicMappings.map(m => m.vismedId).filter(Boolean) as string[];
        }

        const mappingWhere: any = { isActive: true };
        if (doctorIdFilter) {
            mappingWhere.vismedDoctorId = { in: doctorIdFilter };
        }

        const mappedDoctors = await this.prisma.professionalUnifiedMapping.findMany({
            where: mappingWhere,
            include: { vismedDoctor: true }
        });

        let synced = 0;
        let errors = 0;

        for (const m of mappedDoctors) {
            if (!m.vismedDoctor.turnoM && !m.vismedDoctor.turnoT && !m.vismedDoctor.turnoN) {
                continue;
            }

            try {
                const result = await this.syncSlotsForDoctor(m.vismedDoctorId, client, syncRunId, daysAhead, clinicId);
                if (result.success) synced++;
                else errors++;
            } catch (error: any) {
                errors++;
                this.logger.error(`Slot sync failed for doctor ${m.vismedDoctor.name}: ${error.message}`);
            }
        }

        return { total: mappedDoctors.length, synced, errors };
    }

    private async provisionAddressServices(
        doctor: any,
        client: DocplannerClient,
        facilityId: string,
        doctorId: string,
        addressId: string,
        syncRunId?: string,
    ): Promise<any[]> {
        const provisionedServices: any[] = [];

        const doctorSpecialties = doctor.specialties || [];
        const serviceIdsToAdd: { doctoraliaServiceId: string; name: string }[] = [];

        for (const ps of doctorSpecialties) {
            const specialty = ps.specialty;
            if (!specialty?.mappings?.length) continue;
            const mapping = specialty.mappings[0];
            if (!mapping?.doctoraliaService) continue;

            const docSvc = mapping.doctoraliaService;
            const alreadyAdded = serviceIdsToAdd.some(s => s.doctoraliaServiceId === docSvc.doctoraliaServiceId);
            if (!alreadyAdded) {
                serviceIdsToAdd.push({
                    doctoraliaServiceId: docSvc.doctoraliaServiceId,
                    name: docSvc.name,
                });
            }
        }

        if (serviceIdsToAdd.length === 0) {
            // Diferencia: "não tem mapping nenhum" vs "tem mapping mas todos pending review"
            const specialtyIds = doctorSpecialties.map((ps: any) => ps.specialty?.id).filter((id: any) => typeof id === 'string');
            const pendingCount = specialtyIds.length > 0
                ? await this.prisma.specialtyServiceMapping.count({
                    where: { isActive: true, requiresReview: true, vismedSpecialtyId: { in: specialtyIds } },
                })
                : 0;
            if (pendingCount > 0) {
                this.logger.warn(`Doctor ${doctor.name}: ${pendingCount} mapping(s) aguardando aprovação manual em /mapping → Especialidades — slot provisioning pulado.`);
                if (syncRunId) {
                    await this.logEvent(syncRunId, 'SLOT_SYNC', 'skipped_pending_review', `Doctor ${doctor.name}: ${pendingCount} mapping(s) pending review — slot provisioning pulado.`);
                }
            } else {
                this.logger.warn(`Doctor ${doctor.name}: no specialty→service mappings found for auto-provisioning`);
            }
            return [];
        }

        this.logger.log(`Doctor ${doctor.name}: will provision ${serviceIdsToAdd.length} service(s): ${serviceIdsToAdd.map(s => `${s.name} (${s.doctoraliaServiceId})`).join(', ')}`);

        for (const svc of serviceIdsToAdd) {
            const candidateIds = [svc.doctoraliaServiceId];

            const normalizedLookup = (svc as any).normalizedName
                || svc.name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            const alternativeServices = await this.prisma.doctoraliaService.findMany({
                where: { normalizedName: normalizedLookup },
                select: { doctoraliaServiceId: true },
            });
            for (const alt of alternativeServices) {
                if (!candidateIds.includes(alt.doctoraliaServiceId)) {
                    candidateIds.push(alt.doctoraliaServiceId);
                }
            }

            const validCandidateIds = candidateIds.filter(id => {
                const num = Number(id);
                return Number.isFinite(num) && num > 0;
            });

            if (validCandidateIds.length === 0) {
                this.logger.error(`Doctor ${doctor.name}: no valid numeric service_ids for "${svc.name}" on address ${addressId}`);
                continue;
            }

            let provisioned = false;
            for (const candidateId of validCandidateIds) {
                try {
                    const result = await client.addAddressService(facilityId, doctorId, addressId, {
                        service_id: Number(candidateId),
                        is_price_from: false,
                        price: 0,
                    });

                    let newAddressServiceId: number | null = null;

                    if (result?._location) {
                        const match = String(result._location).match(/\/services\/(\d+)/);
                        if (match) newAddressServiceId = Number(match[1]);
                    }
                    if (result?.id) {
                        newAddressServiceId = Number(result.id);
                    }

                    if (newAddressServiceId) {
                        provisionedServices.push({ id: newAddressServiceId, service_id: Number(candidateId), name: svc.name });
                    } else {
                        const svcRes = await client.getServices(facilityId, doctorId, addressId);
                        const items = svcRes._items || [];
                        const found = items.find((s: any) => String(s.service_id) === String(candidateId));
                        if (found) {
                            provisionedServices.push(found);
                        } else if (items.length > 0) {
                            provisionedServices.push(...items.filter((i: any) => !provisionedServices.some((p: any) => p.id === i.id)));
                        }
                    }

                    this.logger.log(`Doctor ${doctor.name}: provisioned service "${svc.name}" (service_id: ${candidateId}) on address ${addressId}`);
                    if (syncRunId) {
                        await this.logEvent(syncRunId, 'SERVICE_PROVISION', 'created', `Serviço "${svc.name}" (service_id: ${candidateId}) adicionado ao endereço ${addressId} do médico ${doctor.name}`);
                    }
                    provisioned = true;
                    break;
                } catch (error: any) {
                    const status = error.status ?? error.response?.status ?? (() => {
                        const m = error.message?.match(/(\d{3})/);
                        return m ? Number(m[1]) : 0;
                    })();
                    const isRetryable = status === 404 || status === 422 || status === 0;
                    this.logger.warn(`Doctor ${doctor.name}: service_id ${candidateId} failed for "${svc.name}" on address ${addressId} (status ${status}): ${error.message}`);
                    if (!isRetryable) {
                        this.logger.error(`Doctor ${doctor.name}: non-retryable error (${status}) for "${svc.name}", stopping candidate attempts`);
                        break;
                    }
                }
            }

            if (!provisioned) {
                this.logger.error(`Doctor ${doctor.name}: all candidate service_ids failed for "${svc.name}" on address ${addressId}. Tried: ${candidateIds.join(', ')}`);
                if (syncRunId) {
                    await this.logEvent(syncRunId, 'SERVICE_PROVISION', 'error', `Falha ao adicionar serviço "${svc.name}" ao endereço ${addressId}: nenhum service_id válido. Tentados: ${candidateIds.join(', ')}`);
                }
            }
        }

        if (provisionedServices.length === 0) {
            const svcRes = await client.getServices(facilityId, doctorId, addressId);
            return svcRes._items || [];
        }

        return provisionedServices;
    }

    private async logEvent(syncRunId: string, entityType: string, action: string, message: string) {
        try {
            await this.prisma.syncEvent.create({
                data: { syncRunId, entityType, action, externalId: 'N/A', message }
            });
        } catch (e) {
            this.logger.error(`Failed to write slot sync event: ${e}`);
        }
    }
}
