import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerClient } from '../integrations/docplanner.service';
import { VismedAvailabilityService, ClinicAvailability, AvailRange } from './vismed-availability.service';

interface TurnoSlot {
    start: string;
    end: string;
}

@Injectable()
export class SlotSyncService {
    private readonly logger = new Logger(SlotSyncService.name);
    /** Hash do payload de slots vazio (`[]`) — usado para distinguir "nunca tinha nada" de "esvaziado". */
    private readonly EMPTY_SLOTS_HASH = crypto.createHash('sha256').update(JSON.stringify([])).digest('hex');

    constructor(
        private prisma: PrismaService,
        private availabilityService: VismedAvailabilityService,
    ) {}

    private async upsertSlotPushState(doctoraliaDoctorId: string, addressId: string, availabilityHash: string): Promise<void> {
        try {
            await this.prisma.slotPushState.upsert({
                where: { doctoraliaDoctorId_addressId: { doctoraliaDoctorId, addressId } },
                create: { doctoraliaDoctorId, addressId, availabilityHash },
                update: { availabilityHash, lastSyncedAt: new Date() },
            });
        } catch (err: any) {
            this.logger.warn(`Falha ao gravar SlotPushState (${doctoraliaDoctorId}/${addressId}): ${err.message}`);
        }
    }

    /** Fonte dos horários: 'availability' (scheduleDay, reflete bloqueio) ou 'template' (turno_m/t/n legado). */
    private slotSource(): 'availability' | 'template' {
        return (process.env.SLOT_SOURCE || 'availability').toLowerCase() === 'template' ? 'template' : 'availability';
    }

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
            slots.push(this.buildSlotObject(date, parsed.start, parsed.end, uniqueServiceIds, timezone, slotDurationMinutes, insuranceProviderIds, insurancePlanIds));
        }
        return slots;
    }

    /**
     * Constrói os slots de um dia a partir das FAIXAS reais disponíveis (scheduleDay).
     * Cada faixa contígua vira um work period. Faixas vazias (turno bloqueado na VisMed
     * naquele dia) simplesmente não geram slot — é assim que o bloqueio é refletido.
     */
    buildDaySlotsFromRanges(date: string, ranges: AvailRange[], addressServiceIds: number[], timezone: string = '-03:00', slotDurationMinutes: number = 30, insuranceProviderIds: number[] = [], insurancePlanIds: number[] = []): any[] {
        const slots: any[] = [];
        const uniqueServiceIds = [...new Set(addressServiceIds)];
        if (uniqueServiceIds.length === 0) return slots;

        for (const range of ranges || []) {
            if (!range?.start || !range?.end || range.end <= range.start) continue;
            slots.push(this.buildSlotObject(date, range.start, range.end, uniqueServiceIds, timezone, slotDurationMinutes, insuranceProviderIds, insurancePlanIds));
        }
        return slots;
    }

    private buildSlotObject(date: string, start: string, end: string, uniqueServiceIds: number[], timezone: string, slotDurationMinutes: number, insuranceProviderIds: number[], insurancePlanIds: number[]): any {
        const slot: any = {
            start: `${date}T${start}:00${timezone}`,
            end: `${date}T${end}:00${timezone}`,
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
        return slot;
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
        availability?: ClinicAvailability | null,
    ): Promise<{ success: boolean; message: string; slotsCreated: number }> {
        const source = this.slotSource();
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

        // No modo legado (template) os turnos são obrigatórios. No modo availability a fonte
        // é o scheduleDay (não depende de turno_m/t/n preenchido).
        if (source === 'template' && !doctor.turnoM && !doctor.turnoT && !doctor.turnoN) {
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
        let addressesUnchanged = 0;
        let addressesCleared = 0;
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

        // ── Disponibilidade real (scheduleDay) ────────────────────────────────────────────
        // Categorias (idcategoriaservico) deste médico = vismedId de cada especialidade dele.
        const doctorCategoryIds = [...new Set(
            (doctor.specialties || [])
                .map((ps: any) => ps?.specialty?.vismedId)
                .filter((v: any): v is number => Number.isInteger(v))
        )];

        // Resolve o snapshot de disponibilidade. Se não veio pronto (build por clínica), constrói
        // só para as categorias deste médico. No modo template, não precisamos de scheduleDay.
        let avail = availability ?? null;
        if (source === 'availability' && !avail && clinicId) {
            avail = await this.availabilityService.buildForCategories(clinicId, doctorCategoryIds, dates);
        }

        // FAIL-SAFE: replaceSlots SUBSTITUI todo o calendário do endereço. Se a foto da
        // disponibilidade do médico estiver INCOMPLETA (qualquer fetch scheduleDay falhou),
        // NÃO empurramos — apagar o calendário por causa de erro de rede seria desastroso.
        if (source === 'availability') {
            if (!avail) {
                const msg = `Médico ${doctor.name}: disponibilidade VisMed indisponível — slots NÃO empurrados (fail-safe).`;
                this.logger.warn(msg);
                if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'skipped_incomplete', msg);
                return { success: false, message: msg, slotsCreated: 0 };
            }
            // Sem categorias = não conseguimos saber a disponibilidade real (especialidades não
            // sincronizadas ainda). Tratar como INCOMPLETO — nunca como "totalmente bloqueado" —
            // para não disparar o caminho de limpeza por inconsistência de dados.
            if (doctorCategoryIds.length === 0) {
                const msg = `Médico ${doctor.name}: sem especialidades VisMed mapeadas — disponibilidade desconhecida, slots NÃO empurrados (fail-safe).`;
                this.logger.warn(msg);
                if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'skipped_incomplete', msg);
                return { success: false, message: msg, slotsCreated: 0 };
            }
            if (!avail.isComplete(doctorCategoryIds, dates)) {
                const msg = `Médico ${doctor.name}: foto de disponibilidade INCOMPLETA (falha em alguma categoria/data) — slots NÃO empurrados para evitar apagar calendário.`;
                this.logger.warn(msg);
                if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'skipped_incomplete', msg);
                return { success: false, message: msg, slotsCreated: 0 };
            }
        }

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
            // Ordenado para hash incremental determinístico (a API Doctoralia não garante ordem estável).
            const addressServiceIds = deduplicatedServices.map((s: any) => Number(s.id)).sort((a: number, b: number) => a - b);
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

            // Ordenação determinística: as listas vêm de queries sem ORDER BY, então a ordem pode
            // variar entre execuções. Sem isso, o hash incremental muda à toa e re-empurra slots
            // idênticos. A ordem não importa para a Doctoralia.
            insuranceProviderIds.sort((a, b) => a - b);
            insurancePlanIds.sort((a, b) => a - b);

            const allSlots: any[] = [];
            for (const date of dates) {
                let daySlots: any[];
                if (source === 'availability' && avail) {
                    // Faixas REALMENTE livres deste profissional naquele dia (já sem turnos bloqueados).
                    const ranges = avail.getRanges(Number(doctor.vismedId), date);
                    daySlots = this.buildDaySlotsFromRanges(date, ranges, addressServiceIds, '-03:00', 30, insuranceProviderIds, insurancePlanIds);
                } else {
                    daySlots = this.buildDaySlots(date, doctor.turnoM, doctor.turnoT, doctor.turnoN, addressServiceIds, '-03:00', 30, insuranceProviderIds, insurancePlanIds);
                }
                allSlots.push(...daySlots);
            }

            // ── Incremental: só re-empurra se a disponibilidade do endereço mudou ──────────────
            // Hash determinístico do payload de slots. Se igual ao último push bem-sucedido,
            // pulamos a chamada replaceSlots (idempotente) — economiza chamadas à API.
            const availabilityHash = crypto.createHash('sha256').update(JSON.stringify(allSlots)).digest('hex');
            const prevState = await this.prisma.slotPushState.findUnique({
                where: { doctoraliaDoctorId_addressId: { doctoraliaDoctorId: String(dDoc.doctoraliaDoctorId), addressId: addrId } },
            });

            if (allSlots.length === 0) {
                // Médico TOTALMENTE bloqueado neste endereço (nenhuma faixa livre na janela).
                // Só limpamos o calendário (replaceSlots []) se a foto está completa E havia algo
                // empurrado antes (estado prévio não-vazio). Senão, pulamos com aviso — evita
                // wipe acidental de um calendário que nunca gerenciamos.
                const prevWasNonEmpty = prevState && prevState.availabilityHash !== this.EMPTY_SLOTS_HASH;
                if (source === 'availability' && prevWasNonEmpty) {
                    if (prevState!.availabilityHash === availabilityHash) {
                        addressesUnchanged++;
                        this.logger.log(`Doctor ${doctor.name} address ${addrId}: já vazio (hash igual), skip.`);
                        continue;
                    }
                    try {
                        await client.replaceSlots(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, { slots: [] });
                        await this.upsertSlotPushState(String(dDoc.doctoraliaDoctorId), addrId, availabilityHash);
                        addressesCleared++;
                        const msg = `Doctor ${doctor.name} address ${addrId}: agenda totalmente bloqueada na VisMed — calendário Doctoralia limpo.`;
                        this.logger.log(msg);
                        if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'cleared', msg);
                    } catch (error: any) {
                        addressesFailed++;
                        const msg = `Doctor ${doctor.name} address ${addrId}: falha ao limpar calendário: ${error.message}`;
                        this.logger.error(msg);
                        if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'error', msg);
                    }
                } else {
                    const msg = `Doctor ${doctor.name} address ${addrId}: nenhuma faixa livre e sem estado prévio gerenciado — skip (evita wipe acidental).`;
                    this.logger.warn(msg);
                    if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'skipped_empty', msg);
                }
                continue;
            }

            if (source === 'availability' && prevState && prevState.availabilityHash === availabilityHash) {
                addressesUnchanged++;
                this.logger.log(`Doctor ${doctor.name} address ${addrId}: disponibilidade inalterada (hash igual), skip replaceSlots.`);
                if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'unchanged', `Doctor ${doctor.name} addr ${addrId}: disponibilidade inalterada, push pulado.`);
                continue;
            }

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
                await this.upsertSlotPushState(String(dDoc.doctoraliaDoctorId), addrId, availabilityHash);
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

        // Incremental: nada empurrado porque já estava tudo sincronizado (hash igual) ou foi
        // limpo por bloqueio total. Isso é SUCESSO — não há trabalho a fazer.
        if (totalSlots === 0 && (addressesUnchanged > 0 || addressesCleared > 0)) {
            const parts: string[] = [];
            if (addressesUnchanged > 0) parts.push(`${addressesUnchanged} inalterado(s)`);
            if (addressesCleared > 0) parts.push(`${addressesCleared} limpo(s) por bloqueio`);
            return {
                success: true,
                message: `${doctor.name}: nada a empurrar (${parts.join(', ')}).`,
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

        const source = this.slotSource();

        // Constrói a disponibilidade da clínica UMA vez (todas as categorias × janela) e reusa
        // para todos os médicos — evita refazer as chamadas scheduleDay por médico.
        let availability: ClinicAvailability | null = null;
        if (source === 'availability' && clinicId) {
            const startDate = new Date();
            startDate.setDate(startDate.getDate() + 1);
            const dates = this.generateDateRange(startDate, daysAhead);
            availability = await this.availabilityService.buildForClinic(clinicId, dates);
        }

        let synced = 0;
        let errors = 0;

        for (const m of mappedDoctors) {
            // No modo legado (template) pulamos médicos sem turnos. No modo availability a
            // fonte é o scheduleDay, então não filtramos por turno aqui.
            if (source === 'template' && !m.vismedDoctor.turnoM && !m.vismedDoctor.turnoT && !m.vismedDoctor.turnoN) {
                continue;
            }

            try {
                const result = await this.syncSlotsForDoctor(m.vismedDoctorId, client, syncRunId, daysAhead, clinicId, availability);
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
        const serviceIdsToAdd: { doctoraliaServiceId: string; name: string; mappingId: string }[] = [];

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
                    mappingId: mapping.id,
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

        // Catálogo da unidade (fonte de verdade dos service_id aceitos). `null` = indisponível → fail-open.
        const facilityCatalogIds = await this.resolveFacilityCatalogIds(client, facilityId);

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

            let validCandidateIds = candidateIds.filter(id => {
                const num = Number(id);
                return Number.isFinite(num) && num > 0;
            });

            if (validCandidateIds.length === 0) {
                this.logger.error(`Doctor ${doctor.name}: no valid numeric service_ids for "${svc.name}" on address ${addressId}`);
                continue;
            }

            // GATE POR CATÁLOGO: só tentamos IDs que a unidade aceita. Se nenhum candidato
            // estiver no catálogo, o mapping aponta para um service_id inválido para esta unidade
            // → marcamos como inválido (para revisão) e não fazemos POST que retornaria 404.
            if (facilityCatalogIds) {
                const inCatalog = validCandidateIds.filter(id => facilityCatalogIds.has(String(id)));
                if (inCatalog.length === 0) {
                    const reason = `service_id ${svc.doctoraliaServiceId} não existe no catálogo da unidade ${facilityId} (não aceito pela Doctoralia)`;
                    this.logger.warn(`Doctor ${doctor.name}: [SKIP NOT IN CATALOG] "${svc.name}" — ${reason}`);
                    await this.markMappingInvalid(svc.mappingId, reason);
                    if (syncRunId) {
                        await this.logEvent(syncRunId, 'SERVICE_PROVISION', 'invalid_service_id', `Serviço "${svc.name}" (dict:${svc.doctoraliaServiceId}) fora do catálogo da unidade — mapping marcado para revisão em /mapping.`);
                    }
                    continue;
                }
                validCandidateIds = inCatalog;
            }

            let provisioned = false;
            let sawRejection = false;
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
                    if (this.isServiceIdRejected(error)) sawRejection = true;
                    this.logger.warn(`Doctor ${doctor.name}: service_id ${candidateId} failed for "${svc.name}" on address ${addressId} (status ${status}): ${error.message}`);
                    if (!isRetryable) {
                        this.logger.error(`Doctor ${doctor.name}: non-retryable error (${status}) for "${svc.name}", stopping candidate attempts`);
                        break;
                    }
                }
            }

            if (!provisioned) {
                this.logger.error(`Doctor ${doctor.name}: all candidate service_ids failed for "${svc.name}" on address ${addressId}. Tried: ${candidateIds.join(', ')}`);
                // Se a Doctoralia REJEITOU todos os candidatos (404 / ItemService not found), o mapping
                // aponta para service_id(s) que a unidade não aceita → marcar como inválido para o cron
                // parar de reenviar e o operador remapear em /mapping.
                if (sawRejection) {
                    await this.markMappingInvalid(svc.mappingId, `service_id ${svc.doctoraliaServiceId} rejeitado pela Doctoralia na unidade ${facilityId} (nenhum candidato aceito)`);
                }
                if (syncRunId) {
                    await this.logEvent(syncRunId, 'SERVICE_PROVISION', sawRejection ? 'invalid_service_id' : 'error', `Falha ao adicionar serviço "${svc.name}" ao endereço ${addressId}: nenhum service_id válido. Tentados: ${candidateIds.join(', ')}`);
                }
            }
        }

        if (provisionedServices.length === 0) {
            const svcRes = await client.getServices(facilityId, doctorId, addressId);
            return svcRes._items || [];
        }

        return provisionedServices;
    }

    /**
     * Resolve o conjunto de service_id (dict IDs) que a UNIDADE aceita via
     * GET /facilities/{id}/services/catalog. Retorna `null` quando indisponível/vazio (fail-open).
     */
    private async resolveFacilityCatalogIds(client: DocplannerClient, facilityId: string): Promise<Set<string> | null> {
        try {
            const res = await client.getFacilityServicesCatalog(facilityId);
            const items = res?._items || [];
            if (items.length === 0) return null;
            const ids = new Set<string>();
            for (const item of items) {
                if (item.service_id != null) ids.add(String(item.service_id));
                if (item.id != null) ids.add(String(item.id));
            }
            return ids;
        } catch (error: any) {
            this.logger.warn(`Facility ${facilityId}: falha ao buscar catálogo de serviços (${error.message}) — gate por catálogo desabilitado (fail-open).`);
            return null;
        }
    }

    /**
     * Rejeição definitiva de um service_id pela Doctoralia: 404 e/ou "ItemService object not found".
     */
    private isServiceIdRejected(error: any): boolean {
        const status = error?.status ?? error?.response?.status ?? 0;
        const msg = String(error?.message || '');
        return status === 404 || /ItemService object not found/i.test(msg);
    }

    /**
     * Sinaliza um SpecialtyServiceMapping como inválido (motivo registrado + fora do push
     * automático) sem apagá-lo, para reaprovação/remapeamento manual em /mapping.
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
                data: { syncRunId, entityType, action, externalId: 'N/A', message }
            });
        } catch (e) {
            this.logger.error(`Failed to write slot sync event: ${e}`);
        }
    }
}
