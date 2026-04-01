import { Controller, Post, Param, UseGuards, Get, Body, Request, Query, NotFoundException, ForbiddenException } from '@nestjs/common';
import { SyncService } from './sync.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerService } from '../integrations/docplanner.service';
import { SlotSyncService } from './slot-sync.service';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('sync')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('sync')
export class SyncController {
    constructor(
        private syncService: SyncService,
        private prisma: PrismaService,
        private docplanner: DocplannerService,
        private slotSync: SlotSyncService,
    ) { }

    private async getDoctoraliaClient(clinicId: string) {
        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia' }
        });
        if (!conn || !conn.clientId) throw new Error('Integração Doctoralia não configurada.');
        return this.docplanner.createClient(conn.domain || 'www.doctoralia.com.br', conn.clientId, conn.clientSecret || '');
    }

    private async validateDoctorBelongsToClinic(vismedDoctorId: string, clinicId: string) {
        const mapping = await this.prisma.mapping.findFirst({
            where: { vismedId: vismedDoctorId, entityType: 'DOCTOR', clinicId },
        });
        if (!mapping) {
            throw new ForbiddenException('Este médico não pertence à clínica informada.');
        }
    }

    private async validateDoctoraliaDoctorBelongsToClinic(doctoraliaDoctorId: string, clinicId: string) {
        const dDoc = await this.prisma.doctoraliaDoctor.findUnique({ where: { doctoraliaDoctorId } });
        if (!dDoc) throw new NotFoundException('Médico Doctoralia não encontrado.');

        const clinicDoctorMappings = await this.prisma.mapping.findMany({
            where: { clinicId, entityType: 'DOCTOR' },
            select: { vismedId: true },
        });
        const clinicDoctorIds = clinicDoctorMappings.map(m => m.vismedId).filter(Boolean) as string[];

        const unifiedMapping = await this.prisma.professionalUnifiedMapping.findFirst({
            where: {
                doctoraliaDoctorId: dDoc.id,
                isActive: true,
                vismedDoctorId: { in: clinicDoctorIds },
            }
        });
        if (!unifiedMapping) {
            throw new ForbiddenException('Este médico Doctoralia não está vinculado a esta clínica.');
        }
        return dDoc;
    }

    @ApiOperation({ summary: 'Trigger a manual sync for a clinic (Doctoralia)' })
    @Post(':clinicId/run')
    async runSync(@Param('clinicId') clinicId: string) {
        return this.syncService.triggerManualSync(clinicId, 'full');
    }

    @ApiOperation({ summary: 'Dispara a rotina de sincronismo global (Doctoralia + VisMed)' })
    @Post(':clinicId/global')
    async triggerGlobalSync(
        @Param('clinicId') clinicId: string,
        @Body('idEmpresaGestora') idEmpresa?: number
    ) {
        return this.syncService.triggerGlobalSync(clinicId, idEmpresa);
    }

    @Get('vismed/stats')
    @ApiOperation({ summary: 'Retorna a volumetria da base de dados Vismed' })
    async getVismedStats() {
        return this.syncService.getVismedStats();
    }

    @Get(':clinicId/test-run')
    async testRun(@Param('clinicId') clinicId: string) {
        return this.syncService.triggerManualSync(clinicId, 'full');
    }

    @ApiOperation({ summary: 'Get recent sync runs and activities' })
    @Get(':clinicId/history')
    async getHistory(@Param('clinicId') clinicId: string) {
        return this.prisma.syncRun.findMany({
            where: { clinicId },
            include: {
                events: true
            },
            orderBy: { startedAt: 'desc' },
            take: 20
        });
    }

    @ApiOperation({ summary: 'Sync slots for a single doctor based on VisMed shifts' })
    @Post(':clinicId/slots/:vismedDoctorId')
    async syncSlotsForDoctor(
        @Param('clinicId') clinicId: string,
        @Param('vismedDoctorId') vismedDoctorId: string,
        @Body('daysAhead') daysAhead?: number,
    ) {
        await this.validateDoctorBelongsToClinic(vismedDoctorId, clinicId);
        const client = await this.getDoctoraliaClient(clinicId);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.slotSync.syncSlotsForDoctor(vismedDoctorId, client, undefined, daysAhead || 30, clinicId);
    }

    @ApiOperation({ summary: 'Sync slots for all mapped doctors' })
    @Post(':clinicId/slots')
    async syncAllSlots(
        @Param('clinicId') clinicId: string,
        @Body('daysAhead') daysAhead?: number,
    ) {
        const client = await this.getDoctoraliaClient(clinicId);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.slotSync.syncAllSlots(client, undefined, daysAhead || 30, clinicId);
    }

    @ApiOperation({ summary: 'Get shifts (turnos) for a VisMed doctor' })
    @Get(':clinicId/shifts/:vismedDoctorId')
    async getShifts(
        @Param('clinicId') clinicId: string,
        @Param('vismedDoctorId') vismedDoctorId: string,
    ) {
        await this.validateDoctorBelongsToClinic(vismedDoctorId, clinicId);
        const doctor = await this.prisma.vismedDoctor.findUnique({
            where: { id: vismedDoctorId },
            select: { id: true, name: true, turnoM: true, turnoT: true, turnoN: true }
        });
        if (!doctor) throw new NotFoundException('Médico não encontrado.');
        return doctor;
    }

    @ApiOperation({ summary: 'Enable calendar for a doctor on Doctoralia' })
    @Post(':clinicId/calendar/:doctoraliaDoctorId/enable')
    async enableCalendar(
        @Param('clinicId') clinicId: string,
        @Param('doctoraliaDoctorId') doctoraliaDoctorId: string,
    ) {
        const dDoc = await this.validateDoctoraliaDoctorBelongsToClinic(doctoraliaDoctorId, clinicId);
        const client = await this.getDoctoraliaClient(clinicId);
        await new Promise(resolve => setTimeout(resolve, 1000));

        const addrsRes = await client.getAddresses(dDoc.doctoraliaFacilityId, doctoraliaDoctorId);
        const addresses = addrsRes._items || [];
        const results: any[] = [];
        let anySuccess = false;

        for (const addr of addresses) {
            try {
                await client.enableCalendar(dDoc.doctoraliaFacilityId, doctoraliaDoctorId, String(addr.id));
                results.push({ addressId: addr.id, status: 'enabled' });
                anySuccess = true;
            } catch (e: any) {
                results.push({ addressId: addr.id, status: 'error', message: e.message });
            }
        }

        if (anySuccess) {
            await this.updateCalendarStatusInMapping(clinicId, dDoc.id, 'enabled');
        }

        return { doctoraliaDoctorId, results };
    }

    @ApiOperation({ summary: 'Disable calendar for a doctor on Doctoralia' })
    @Post(':clinicId/calendar/:doctoraliaDoctorId/disable')
    async disableCalendar(
        @Param('clinicId') clinicId: string,
        @Param('doctoraliaDoctorId') doctoraliaDoctorId: string,
    ) {
        const dDoc = await this.validateDoctoraliaDoctorBelongsToClinic(doctoraliaDoctorId, clinicId);
        const client = await this.getDoctoraliaClient(clinicId);
        await new Promise(resolve => setTimeout(resolve, 1000));

        const addrsRes = await client.getAddresses(dDoc.doctoraliaFacilityId, doctoraliaDoctorId);
        const addresses = addrsRes._items || [];
        const results: any[] = [];
        let anySuccess = false;

        for (const addr of addresses) {
            try {
                await client.disableCalendar(dDoc.doctoraliaFacilityId, doctoraliaDoctorId, String(addr.id));
                results.push({ addressId: addr.id, status: 'disabled' });
                anySuccess = true;
            } catch (e: any) {
                results.push({ addressId: addr.id, status: 'error', message: e.message });
            }
        }

        if (anySuccess) {
            await this.updateCalendarStatusInMapping(clinicId, dDoc.id, 'disabled');
        }

        return { doctoraliaDoctorId, results };
    }

    private async updateCalendarStatusInMapping(clinicId: string, doctoraliaDoctorInternalId: string, status: string) {
        try {
            const unifiedMapping = await this.prisma.professionalUnifiedMapping.findFirst({
                where: { doctoraliaDoctorId: doctoraliaDoctorInternalId, isActive: true },
            });
            if (!unifiedMapping) return;

            const mapping = await this.prisma.mapping.findFirst({
                where: { clinicId, entityType: 'DOCTOR', vismedId: unifiedMapping.vismedDoctorId },
            });
            if (!mapping) return;

            const existing = (mapping.conflictData as any) || {};
            await this.prisma.mapping.update({
                where: { id: mapping.id },
                data: { conflictData: { ...existing, calendarStatus: status } },
            });
        } catch (e) {
            // non-critical
        }
    }
}
