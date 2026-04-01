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
        if (!match) {
            this.logger.warn(`Could not parse turno: "${turnoStr}"`);
            return null;
        }
        const startH = parseInt(match[1], 10);
        const startM = parseInt(match[2], 10);
        const endH = parseInt(match[3], 10);
        const endM = parseInt(match[4], 10);

        if (startH < 0 || startH > 23 || startM < 0 || startM > 59 ||
            endH < 0 || endH > 23 || endM < 0 || endM > 59) {
            this.logger.warn(`Invalid turno time values: "${turnoStr}"`);
            return null;
        }

        const startTotal = startH * 60 + startM;
        const endTotal = endH * 60 + endM;
        if (endTotal <= startTotal) {
            this.logger.warn(`Turno end must be after start: "${turnoStr}"`);
            return null;
        }

        const start = `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}`;
        const end = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
        return { start, end };
    }

    buildDaySlots(date: string, turnoM: string | null, turnoT: string | null, turnoN: string | null, addressServiceIds: number[], timezone: string = '-0300'): any[] {
        const slots: any[] = [];
        const turnos = [turnoM, turnoT, turnoN];

        for (const turno of turnos) {
            const parsed = this.parseTurno(turno);
            if (!parsed) continue;

            if (addressServiceIds.length === 0) continue;

            slots.push({
                start: `${date}T${parsed.start}:00${timezone}`,
                end: `${date}T${parsed.end}:00${timezone}`,
                address_services: addressServiceIds.map(id => ({
                    address_service_id: id,
                    duration: 30,
                })),
            });
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
                this.logger.warn(`Doctor ${doctor.name} address ${addrId}: no services found on Doctoralia, skipping slot sync`);
                continue;
            }

            const addressServiceIds = addressServices.map((s: any) => Number(s.id));

            const allSlots: any[] = [];
            for (const date of dates) {
                const daySlots = this.buildDaySlots(date, doctor.turnoM, doctor.turnoT, doctor.turnoN, addressServiceIds);
                allSlots.push(...daySlots);
            }

            if (allSlots.length === 0) continue;

            try {
                await client.replaceSlots(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, { slots: allSlots });
                totalSlots += allSlots.length;
                this.logger.log(`Doctor ${doctor.name}: synced ${allSlots.length} slots to address ${addrId} for ${dates.length} days`);
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
