import { managedSlotState, managedClearPayload, ManagedSlotState } from './managed-slot-ranges';
import { consultationSlotServices } from '../bookings/consultation-policy';
import { AddressInsuranceProvider } from './insurance-plan-selection';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerClient } from '../integrations/docplanner.service';
import { StableDataCacheService, STABLE_DATA_TTLS } from '../integrations/stable-data-cache.service';
import { VismedAvailabilityService, ClinicAvailability, AvailRange } from './vismed-availability.service';
import { runWithDoctoraliaContext } from '../metrics/doctoralia-call-context';
import { getDoctoraliaMetricsService } from '../metrics/doctoralia-metrics.service';
import { SyncCycleContext } from './sync-cycle-context';
import { DisabledProfessionalSlots } from './disabled-professional-slots';

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
        private stableCache: StableDataCacheService,
    ) {}

    async assertCalendarEligibility(clinicId: string, doctorExternalId: string): Promise<void> {
        const mapping = await this.prisma.mapping.findFirst({
            where: { clinicId, entityType: 'DOCTOR', externalId: doctorExternalId, status: 'LINKED' },
        });
        const doctor = mapping?.vismedId ? await this.prisma.vismedDoctor.findUnique({ where: { id: mapping.vismedId } }) : null;
        const eligibility = doctor ? await this.availabilityService.getProfessionalEligibility(clinicId, Number(doctor.vismedId)) : null;
        if (mapping?.status !== 'LINKED' || eligibility?.state !== 'enabled') {
            throw new BadRequestException('Habilitação do profissional na VissMed não confirmada. Agenda não ativada.');
        }
    }

    private async upsertSlotPushState(doctoraliaDoctorId: string, addressId: string, availabilityHash: string, managedState?: ManagedSlotState): Promise<void> {
        try {
            await this.prisma.slotPushState.upsert({
                where: { doctoraliaDoctorId_addressId: { doctoraliaDoctorId, addressId } },
                create: { doctoraliaDoctorId, addressId, availabilityHash, managedState },
                update: { availabilityHash, lastSyncedAt: new Date(), managedState },
            });
        } catch (err: any) {
            this.logger.warn(`Falha ao gravar SlotPushState (${doctoraliaDoctorId}/${addressId}): ${err.message}`);
            throw err;
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
        cycleCtx?: SyncCycleContext,
    ): Promise<{ success: boolean; message: string; slotsCreated: number }> {
        // WP-01: propagate SLOT_SYNC context for all Doctoralia calls within this sync
        return runWithDoctoraliaContext({ origin: 'SLOT_SYNC', clinicId }, () =>
            this._syncSlotsForDoctorInner(vismedDoctorId, client, syncRunId, daysAhead, clinicId, availability, cycleCtx),
        );
    }

    private async _syncSlotsForDoctorInner(
        vismedDoctorId: string,
        client: DocplannerClient,
        syncRunId?: string,
        daysAhead: number = 30,
        clinicId?: string,
        availability?: ClinicAvailability | null,
        cycleCtx?: SyncCycleContext,
    ): Promise<{ success: boolean; message: string; slotsCreated: number }> {
        const slotSyncStartAt = Date.now();
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

        const clinicMapping = clinicId ? await this.prisma.mapping.findFirst({
                where: { vismedId: doctor.id, entityType: 'DOCTOR', clinicId },
            }) : null;
        if (clinicId) {
            if (!clinicMapping) {
                return { success: false, message: `Médico ${doctor.name} não pertence a esta clínica.`, slotsCreated: 0 };
            }
        }

        const eligibility = await this.availabilityService.getProfessionalEligibility(clinicId || '', Number(doctor.vismedId));
        if (eligibility.state === 'unknown') {
            const message = 'Habilitação do profissional na VISSMED não confirmada; nenhum horário enviado ou removido.';
            if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'professional_eligibility_unknown', message);
            return { success: false, message, slotsCreated: 0 };
        }
        const authorizedMapping = clinicMapping?.status === 'LINKED' && doctor.unifiedMappings.find(
            um => String(um.doctoraliaDoctor.doctoraliaDoctorId) === String(clinicMapping.externalId));
        if (!authorizedMapping) {
            const message = 'Vínculo atual da clínica não autoriza publicação ou remoção de horários.';
            if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'managed_scope_pending', message);
            return { success: false, message, slotsCreated: 0 };
        }
        if (eligibility.state === 'excluded') {
            const remote = authorizedMapping.doctoraliaDoctor;
            const result = await new DisabledProfessionalSlots(this.prisma).clear(clinicId!, doctor.id,
                String(remote.doctoraliaFacilityId), String(remote.doctoraliaDoctorId), client,
                async () => (await this.availabilityService.getProfessionalEligibility(clinicId!, Number(doctor.vismedId))).state === 'excluded');
            const message = `Profissional não habilitado: ${result.cleared} endereço(s) com horários gerenciados retirados; ${result.pending} pendência(s). Consultas existentes preservadas.`;
            if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', result.pending ? 'professional_cleanup_pending' : 'professional_excluded', message);
            return { success: result.pending === 0, message, slotsCreated: 0 };
        }

        // No modo legado (template) os turnos são obrigatórios. No modo availability a fonte
        // é o scheduleDay (não depende de turno_m/t/n preenchido).
        if (source === 'template' && !doctor.turnoM && !doctor.turnoT && !doctor.turnoN) {
            return { success: false, message: `Médico ${doctor.name} não possui turnos configurados no VisMed.`, slotsCreated: 0 };
        }

        if (doctor.unifiedMappings.length === 0) {
            return { success: false, message: `Médico ${doctor.name} não está vinculado à Doctoralia.`, slotsCreated: 0 };
        }

        const selectedMapping = authorizedMapping;

        let totalSlots = 0;
        let addressesAttempted = 0;
        let addressesFailed = 0;
        let addressesUnchanged = 0;
        let addressesCleared = 0;
        const dDoc = selectedMapping.doctoraliaDoctor;

        let doctoraliaAddresses: any[];
        try {
            const cachedAddrs = cycleCtx?.getAddresses(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId);
            if (cachedAddrs !== undefined) {
                doctoraliaAddresses = cachedAddrs;
            } else {
                // WP-06: cache TTL entre ciclos — cobre também as execuções do block watcher
                // (que chamam syncSlotsForDoctor com cycleCtx undefined).
                const res = await this.stableCache.getOrFetch(
                    `${client.getCacheIdentity()}|addresses|${dDoc.doctoraliaFacilityId}|${dDoc.doctoraliaDoctorId}`,
                    STABLE_DATA_TTLS.addresses,
                    () => client.getAddresses(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId),
                );
                doctoraliaAddresses = res._items || [];
                cycleCtx?.setAddresses(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, doctoraliaAddresses);
            }
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
        // Categorias (idcategoriaservico) deste médico = vismedId de cada especialidade dele,
        // ESCOPADAS à empresa gestora da clínica (nunca consultar categoria de outra empresa).
        let clinicEmpresa: number | null = null;
        if (clinicId) {
            const clinicConn = await this.prisma.integrationConnection.findFirst({
                where: { clinicId, provider: 'vismed' },
                select: { clientId: true },
            });
            clinicEmpresa = clinicConn?.clientId ? parseInt(clinicConn.clientId) : null;
        }
        // Filtra AQUI as especialidades do médico ao catálogo da empresa da clínica —
        // todo o restante do fluxo (categorias, auto-provisioning de serviços) usa a
        // lista já escopada e nunca propaga mapping/serviço de outra empresa.
        if (clinicEmpresa != null) {
            doctor.specialties = (doctor.specialties || [])
                .filter((ps: any) => ps?.specialty?.idEmpresaGestora === clinicEmpresa);
        }
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

        for (const addr of doctoraliaAddresses) {
            const addrId = String(addr.id);
            addressesAttempted++;

            let addressServices: any[];
            try {
                const cachedSvcs = cycleCtx?.getServices(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId);
                if (cachedSvcs !== undefined) {
                    addressServices = cachedSvcs;
                } else {
                    // WP-06: cache TTL entre ciclos, por baixo do cycleCtx.
                    const svcRes = await this.stableCache.getOrFetch(
                        `${client.getCacheIdentity()}|services|${dDoc.doctoraliaFacilityId}|${dDoc.doctoraliaDoctorId}|${addrId}`,
                        STABLE_DATA_TTLS.services,
                        () => client.getServices(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId),
                    );
                    addressServices = svcRes._items || [];
                    cycleCtx?.setServices(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, addressServices);
                }
            } catch (error: any) {
                this.logger.warn(`Failed to get services for addr ${addrId}: ${error.message}`);
                addressesFailed++;
                if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'error', `Endereço ${addrId}: falha ao consultar serviços; disponibilidade não enviada.`);
                continue;
            }

            if (addressServices.length === 0) {
                this.logger.log(`Doctor ${doctor.name} address ${addrId}: no services found, attempting auto-provision from specialty mappings...`);
                const provisioned = await this.provisionAddressServices(doctor, client, dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, syncRunId, clinicEmpresa);
                if (provisioned.length > 0) {
                    addressServices = provisioned;
                    this.logger.log(`Doctor ${doctor.name} address ${addrId}: provisioned ${provisioned.length} service(s) from specialty mappings`);
                } else {
                    this.logger.warn(`Doctor ${doctor.name} address ${addrId}: no specialty→service mappings available, skipping slot sync`);
                    if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'mapping_pending', `Endereço ${addrId}: falta correspondência aprovada de especialidade e serviço.`);
                    continue;
                }
            }

            const seenServiceIds = new Set<string>();
            addressServices = consultationSlotServices(addressServices, client.getCacheIdentity().split('|')[0]);
            if (addressServices.length === 0) {
                if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'mapping_pending', 'Nenhum serviço confirmado como consulta; disponibilidade preservada sem envio.');
                continue;
            }
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

                // Use plans actually linked to this address. A catalog's first plan may
                // differ from the clinic's manual selection and is not an authorization.
                if (insuranceProviderIds.length > 0) {
                    try {
                        const response = await client.getAddressInsuranceProviders(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId) as { _items?: unknown };
                        if (!Array.isArray(response?._items)) throw new Error('Resposta inválida de planos vinculados.');
                        const desired = new Set(insuranceProviderIds.map(String));
                        const seenPlans = new Set<number>();
                        for (const provider of response._items as AddressInsuranceProvider[]) {
                            if (!desired.has(String(provider.insurance_provider_id ?? provider.id))) continue;
                            for (const plan of provider.insurance_plans?._items || []) {
                                if (/^[1-9]\d*$/.test(String(plan.insurance_plan_id))) seenPlans.add(Number(plan.insurance_plan_id));
                            }
                        }
                        insurancePlanIds = [...seenPlans];
                    } catch {
                        addressesFailed++;
                        if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'error',
                            `Endereço ${addrId}: não foi possível confirmar planos vinculados; disponibilidade não enviada.`);
                        continue;
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

            // Duração real da grade do médico, inferida do scheduleDay (moda dos intervalos).
            // Fallback 30 min quando não foi possível inferir (sem dados / fora da faixa sã).
            // Determinística entre execuções → não quebra o skip incremental por hash.
            let slotDurationMinutes = 30;
            if (source === 'availability' && avail) {
                const inferred = avail.getInferredStep(Number(doctor.vismedId));
                if (inferred != null) {
                    slotDurationMinutes = inferred;
                    this.logger.log(`Doctor ${doctor.name} address ${addrId}: grade inferida = ${inferred} min.`);
                } else {
                    this.logger.log(`Doctor ${doctor.name} address ${addrId}: grade não inferível — fallback 30 min.`);
                }
            }

            const allSlots: any[] = [];
            for (const date of dates) {
                let daySlots: any[];
                if (source === 'availability' && avail) {
                    // Faixas REALMENTE livres deste profissional naquele dia (já sem turnos bloqueados).
                    const ranges = avail.getRanges(Number(doctor.vismedId), date);
                    daySlots = this.buildDaySlotsFromRanges(date, ranges, addressServiceIds, '-03:00', slotDurationMinutes, insuranceProviderIds, insurancePlanIds);
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
                // Só limpamos intervalos comprovadamente enviados se a foto está completa E havia algo
                // empurrado antes (estado prévio não-vazio). Senão, pulamos com aviso — evita
                // wipe acidental de um calendário que nunca gerenciamos.
                const prevWasNonEmpty = prevState && prevState.availabilityHash !== this.EMPTY_SLOTS_HASH;
                if (source === 'availability' && prevWasNonEmpty) {
                    if (prevState!.availabilityHash === availabilityHash) {
                        addressesUnchanged++;
                        this.logger.log(`Doctor ${doctor.name} address ${addrId}: já vazio (hash igual), skip.`);
                        continue;
                    }
                    const scope = { clinicId: clinicId || '', facilityId: String(dDoc.doctoraliaFacilityId), doctorId: String(dDoc.doctoraliaDoctorId), addressId: addrId };
                    const ownsCurrentDoctor = clinicMapping?.status === 'LINKED'
                        && clinicMapping.externalId === String(dDoc.doctoraliaDoctorId);
                    const clearPayload = ownsCurrentDoctor
                        ? managedClearPayload(prevState.managedState, prevState.availabilityHash, scope, dates) : null;
                    if (!clearPayload) {
                        addressesFailed++;
                        if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'managed_scope_pending',
                            `Endereço ${addrId}: limpeza pendente de conferência dos intervalos gerenciados. Estado antigo ou fora da janela; nenhuma remoção enviada.`);
                        continue;
                    }
                    try {
                        if ((await this.availabilityService.getProfessionalEligibility(clinicId!, Number(doctor.vismedId))).state !== 'enabled') {
                            addressesFailed++;
                            if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'professional_eligibility_changed', 'Habilitação mudou durante o ciclo; disponibilidade existente preservada.');
                            continue;
                        }
                        await client.replaceSlots(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, clearPayload);
                        await this.upsertSlotPushState(String(dDoc.doctoraliaDoctorId), addrId, availabilityHash, managedSlotState(
                            { clinicId: clinicId || '', facilityId: String(dDoc.doctoraliaFacilityId), doctorId: String(dDoc.doctoraliaDoctorId), addressId: addrId }, availabilityHash, allSlots));
                        addressesCleared++;
                        const msg = `Doctor ${doctor.name} address ${addrId}: agenda bloqueada na VisMed; intervalos gerenciados na janela removidos da Doctoralia.`;
                        this.logger.log(msg);
                        if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'cleared', msg);
                    } catch (error: any) {
                        addressesFailed++;
                        const msg = `Doctor ${doctor.name} address ${addrId}: falha ao limpar calendário: ${error.message}`;
                        this.logger.error(msg);
                        if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'error', msg);
                    }
                } else {
                    const reason = source === 'availability' && avail
                        ? avail.describeEmpty(Number(doctor.vismedId), dates)
                        : 'Os turnos cadastrados não geraram faixas para envio.';
                    const msg = `Profissional ${doctor.name}, endereço ${addrId}, período ${dates[0]} a ${dates[dates.length - 1]}: ${reason} Nenhum horário enviado ou removido da Doctoralia.`;
                    this.logger.warn(msg);
                    if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'skipped_empty', msg);
                }
                continue;
            }

            if (source === 'availability' && prevState && prevState.availabilityHash === availabilityHash) {
                if (!prevState.managedState) {
                    await this.upsertSlotPushState(String(dDoc.doctoraliaDoctorId), addrId, availabilityHash, managedSlotState(
                        { clinicId: clinicId || '', facilityId: String(dDoc.doctoraliaFacilityId), doctorId: String(dDoc.doctoraliaDoctorId), addressId: addrId }, availabilityHash, allSlots));
                }
                addressesUnchanged++;
                this.logger.log(`Doctor ${doctor.name} address ${addrId}: disponibilidade inalterada (hash igual), skip replaceSlots.`);
                if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'unchanged', `Doctor ${doctor.name} addr ${addrId}: disponibilidade inalterada, push pulado.`);
                // WP-01: emit slot sync skipped event
                try {
                    getDoctoraliaMetricsService()?.recordSlotSync({
                        doctorId: vismedDoctorId, addressId: addrId, clinicId,
                        event: 'SLOT_SYNC_SKIPPED_UNCHANGED',
                        durationMs: Date.now() - slotSyncStartAt, retries: 0, errors: 0,
                        recordedAt: Date.now(),
                    });
                } catch (_e) {}
                continue;
            }

            if ((await this.availabilityService.getProfessionalEligibility(clinicId!, Number(doctor.vismedId))).state !== 'enabled') {
                addressesFailed++;
                if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'professional_eligibility_changed', 'Habilitação mudou durante o ciclo; calendário não ativado e horários não enviados.');
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
                    if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'error', `Endereço ${addrId}: ativação do calendário recusada (${status}).`);
                    continue;
                } else {
                    this.logger.warn(`Doctor ${doctor.name} address ${addrId}: transient error enabling calendar: ${enableErr.message} — proceeding with slot sync`);
                }
            }

            try {
                const sampleSlot = JSON.stringify(allSlots[0]);
                this.logger.log(`Doctor ${doctor.name}: sending ${allSlots.length} work periods to address ${addrId} for ${dates.length} days. Sample: ${sampleSlot}`);
                if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'payload_sent', `Doctor ${doctor.name} addr ${addrId}: enviando ${allSlots.length} slots. Amostra: ${sampleSlot.substring(0, 400)}`);

                if ((await this.availabilityService.getProfessionalEligibility(clinicId!, Number(doctor.vismedId))).state !== 'enabled') {
                    addressesFailed++;
                    if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'professional_eligibility_changed', 'Habilitação mudou durante o ciclo; horários não enviados.');
                    continue;
                }
                const putResponse = await client.replaceSlots(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, { slots: allSlots });
                const respStr = JSON.stringify(putResponse);
                this.logger.log(`Doctor ${doctor.name}: PUT slots response: ${respStr}`);
                if (syncRunId) await this.logEvent(syncRunId, 'SLOT_SYNC', 'doctoralia_response', `Doctor ${doctor.name} addr ${addrId}: resposta Doctoralia: ${respStr.substring(0, 400)}`);

                totalSlots += allSlots.length;
                await this.upsertSlotPushState(String(dDoc.doctoraliaDoctorId), addrId, availabilityHash, managedSlotState(
                            { clinicId: clinicId || '', facilityId: String(dDoc.doctoraliaFacilityId), doctorId: String(dDoc.doctoraliaDoctorId), addressId: addrId }, availabilityHash, allSlots));
                // WP-01: emit slot sync pushed event
                try {
                    getDoctoraliaMetricsService()?.recordSlotSync({
                        doctorId: vismedDoctorId, addressId: addrId, clinicId,
                        event: 'SLOT_SYNC_PUSHED_CHANGED',
                        durationMs: Date.now() - slotSyncStartAt, retries: 0, errors: 0,
                        recordedAt: Date.now(),
                    });
                } catch (_e) {}
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
            // Let the per-doctor gate run before template/shift checks, including cleanup for excluded doctors.

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
        clinicEmpresa?: number | null,
    ): Promise<any[]> {
        const provisionedServices: any[] = [];

        // ESCOPADO (defesa em profundidade): só especialidades do catálogo da empresa
        // gestora da clínica podem provisionar serviços — nunca mapping de outra empresa.
        const doctorSpecialties = (doctor.specialties || []).filter(
            (ps: any) => clinicEmpresa == null || ps?.specialty?.idEmpresaGestora === clinicEmpresa,
        );
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

            // GUARD ANTI address_service id: descarta candidatos que são na verdade ids de VÍNCULO
            // serviço↔endereço (contaminação antiga do dicionário) — a Doctoralia rejeitaria com 404.
            if (validCandidateIds.length > 0) {
                const linkCollisions = await this.prisma.doctoraliaAddressService.findMany({
                    where: { doctoraliaAddressServiceId: { in: validCandidateIds } },
                    select: { doctoraliaAddressServiceId: true },
                });
                if (linkCollisions.length > 0) {
                    const linkIds = new Set(linkCollisions.map(l => l.doctoraliaAddressServiceId));
                    this.logger.warn(`Doctor ${doctor.name}: descartando candidato(s) que são address_service ids, não service_ids: ${[...linkIds].join(', ')}`);
                    validCandidateIds = validCandidateIds.filter(id => !linkIds.has(String(id)));
                }
            }

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
                        // WP-06 BYPASS obrigatório: re-leitura logo após addAddressService para
                        // descobrir o vínculo recém-criado — precisa de estado FRESCO da Doctoralia,
                        // nunca do cache TTL. Vai direto ao client.
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
                    // WP-06: POST de auto-provisionamento mudou os services do endereço —
                    // invalida o cache TTL para o próximo leitor buscar a lista atualizada.
                    this.stableCache.invalidate(`${client.getCacheIdentity()}|services|${facilityId}|${doctorId}|${addressId}`);
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
            // WP-06 BYPASS obrigatório: fallback de resolução no fim do provisionamento —
            // precisa do estado CORRENTE (pós-POSTs) da Doctoralia; nunca usar o cache TTL.
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
            // WP-06: catálogo da unidade é estável (sem mutação no código) — cache TTL longo.
            const res = await this.stableCache.getOrFetch(
                `${client.getCacheIdentity()}|facilityServicesCatalog|${facilityId}`,
                STABLE_DATA_TTLS.facilityServicesCatalog,
                () => client.getFacilityServicesCatalog(facilityId),
            );
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
