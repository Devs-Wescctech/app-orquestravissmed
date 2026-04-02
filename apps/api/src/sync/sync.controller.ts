import { Controller, Post, Param, UseGuards, Get, Body, Request, Query, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { SyncService } from './sync.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerService } from '../integrations/docplanner.service';
import { SlotSyncService } from './slot-sync.service';
import { PushSyncService } from './push-sync.service';
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
        private pushSync: PushSyncService,
    ) { }

    private validateUserClinicAccess(user: any, clinicId: string) {
        const userClinicIds = (user?.roles || []).map((r: any) => r.clinicId);
        if (!userClinicIds.includes(clinicId)) {
            throw new ForbiddenException('Você não tem acesso a esta clínica.');
        }
    }

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
    async runSync(@Param('clinicId') clinicId: string, @Request() req: any) {
        this.validateUserClinicAccess(req.user, clinicId);
        return this.syncService.triggerManualSync(clinicId, 'full');
    }

    @ApiOperation({ summary: 'Dispara a rotina de sincronismo global (Doctoralia + VisMed)' })
    @Post(':clinicId/global')
    async triggerGlobalSync(
        @Param('clinicId') clinicId: string,
        @Body('idEmpresaGestora') idEmpresa?: number,
        @Request() req?: any,
    ) {
        this.validateUserClinicAccess(req?.user, clinicId);
        return this.syncService.triggerGlobalSync(clinicId, idEmpresa);
    }

    @Get('vismed/stats')
    @ApiOperation({ summary: 'Retorna a volumetria da base de dados Vismed' })
    async getVismedStats() {
        return this.syncService.getVismedStats();
    }

    @Get(':clinicId/test-run')
    async testRun(@Param('clinicId') clinicId: string, @Request() req: any) {
        this.validateUserClinicAccess(req.user, clinicId);
        return this.syncService.triggerManualSync(clinicId, 'full');
    }

    @ApiOperation({ summary: 'Get recent sync runs and activities' })
    @Get(':clinicId/history')
    async getHistory(@Param('clinicId') clinicId: string, @Request() req: any) {
        this.validateUserClinicAccess(req.user, clinicId);
        return this.prisma.syncRun.findMany({
            where: { clinicId },
            include: {
                events: true
            },
            orderBy: { startedAt: 'desc' },
            take: 20
        });
    }

    @ApiOperation({ summary: 'Get overall sync health status for a clinic' })
    @Get(':clinicId/status')
    async getSyncStatus(@Param('clinicId') clinicId: string, @Request() req: any) {
        this.validateUserClinicAccess(req.user, clinicId);

        const lastRuns = await this.prisma.syncRun.findMany({
            where: { clinicId },
            orderBy: { startedAt: 'desc' },
            take: 5,
            include: { events: true },
        });

        const lastCompleted = lastRuns.find(r => r.status === 'completed');
        const isRunning = lastRuns.some(r => r.status === 'running');
        const lastFailed = lastRuns.find(r => r.status === 'failed');

        const clinicDoctorMappingIds = await this.prisma.mapping.findMany({
            where: { clinicId, entityType: 'DOCTOR' },
            select: { vismedId: true },
        });
        const clinicVismedIds = clinicDoctorMappingIds.map(m => m.vismedId).filter(Boolean) as string[];
        const doctorMappings = clinicVismedIds.length > 0
            ? await this.prisma.professionalUnifiedMapping.count({ where: { isActive: true, vismedDoctorId: { in: clinicVismedIds } } })
            : 0;
        const insuranceMappings = await this.prisma.mapping.findMany({
            where: { clinicId, entityType: 'INSURANCE' },
            select: { status: true },
        });
        const linkedInsurance = insuranceMappings.filter(m => m.status === 'LINKED').length;
        const pendingInsurance = insuranceMappings.filter(m => m.status === 'PENDING_REVIEW').length;
        const unlinkedInsurance = insuranceMappings.filter(m => m.status === 'UNLINKED').length;

        let overallHealth: 'healthy' | 'warning' | 'error' | 'never_synced' = 'healthy';
        if (!lastCompleted) overallHealth = 'never_synced';
        else if (lastFailed && lastCompleted && new Date(lastFailed.startedAt) > new Date(lastCompleted.startedAt)) overallHealth = 'error';
        else if (pendingInsurance > 0 || unlinkedInsurance > 0) overallHealth = 'warning';

        const [vismedStats, doctoraliaConn, vismedConn] = await Promise.all([
            Promise.all([
                this.prisma.vismedUnit.count(),
                this.prisma.vismedDoctor.count(),
                this.prisma.vismedSpecialty.count(),
                this.prisma.vismedInsurance.count(),
            ]).then(([units, doctors, specialties, insurances]) => ({ units, doctors, specialties, insurances })),
            this.prisma.integrationConnection.findFirst({ where: { clinicId, provider: 'doctoralia' } }),
            this.prisma.integrationConnection.findFirst({ where: { clinicId, provider: 'vismed' } }),
        ]);

        const doctoraliaConnected = doctoraliaConn?.status === 'connected';
        const vismedConnected = vismedConn?.status === 'connected';
        const queueEnabled = doctoraliaConn?.status !== 'paused' && vismedConn?.status !== 'paused';

        const allHistoryRuns = await this.prisma.syncRun.findMany({
            where: { clinicId },
            orderBy: { startedAt: 'desc' },
            take: 10,
            select: { id: true, type: true, status: true, startedAt: true, endedAt: true, totalRecords: true },
        });

        const lastVismedRun = allHistoryRuns.find(r => r.type === 'vismed-full');
        const lastDoctoraliaRun = allHistoryRuns.find(r => r.type === 'full' && r.status === 'completed');

        const successCount = allHistoryRuns.filter(r => r.status === 'completed').length;
        const successRate = allHistoryRuns.length > 0 ? Math.round((successCount / allHistoryRuns.length) * 100) : 0;

        return {
            health: overallHealth,
            isRunning,
            queueEnabled,
            successRate,
            lastSync: lastCompleted ? {
                id: lastCompleted.id,
                startedAt: lastCompleted.startedAt,
                endedAt: lastCompleted.endedAt,
                totalRecords: lastCompleted.totalRecords,
            } : null,
            lastError: lastFailed && (!lastCompleted || new Date(lastFailed.startedAt) > new Date(lastCompleted.startedAt)) ? {
                id: lastFailed.id,
                startedAt: lastFailed.startedAt,
                message: lastFailed.events?.find((e: any) => e.action === 'error')?.message || 'Erro desconhecido',
            } : null,
            doctors: { mapped: doctorMappings },
            insurance: { linked: linkedInsurance, pending: pendingInsurance, unlinked: unlinkedInsurance, total: insuranceMappings.length },
            vismed: {
                connected: vismedConnected,
                stats: vismedStats,
                lastSync: lastVismedRun ? { startedAt: lastVismedRun.startedAt, endedAt: lastVismedRun.endedAt, status: lastVismedRun.status, totalRecords: lastVismedRun.totalRecords } : null,
            },
            doctoralia: {
                connected: doctoraliaConnected,
                lastSync: lastDoctoraliaRun ? { startedAt: lastDoctoraliaRun.startedAt, endedAt: lastDoctoraliaRun.endedAt, status: lastDoctoraliaRun.status, totalRecords: lastDoctoraliaRun.totalRecords } : null,
            },
            recentRuns: allHistoryRuns,
        };
    }

    @ApiOperation({ summary: 'Toggle sync queue (pause/resume)' })
    @Post(':clinicId/queue/toggle')
    async toggleSyncQueue(
        @Param('clinicId') clinicId: string,
        @Body('enabled') enabled: boolean,
        @Request() req?: any,
    ) {
        this.validateUserClinicAccess(req?.user, clinicId);

        if (typeof enabled !== 'boolean') {
            throw new BadRequestException('Field "enabled" must be a boolean');
        }

        const connections = await this.prisma.integrationConnection.findMany({
            where: { clinicId, provider: { in: ['doctoralia', 'vismed'] } },
        });

        if (connections.length === 0) {
            throw new NotFoundException('No integration connections found for this clinic');
        }

        let updatedCount = 0;
        for (const conn of connections) {
            if (enabled && conn.status === 'paused') {
                await this.prisma.integrationConnection.update({
                    where: { id: conn.id },
                    data: { status: 'connected' },
                });
                updatedCount++;
            } else if (!enabled && conn.status !== 'paused') {
                await this.prisma.integrationConnection.update({
                    where: { id: conn.id },
                    data: { status: 'paused' },
                });
                updatedCount++;
            }
        }

        return { enabled, updated: updatedCount };
    }

    @ApiOperation({ summary: 'Sync slots for a single doctor based on VisMed shifts' })
    @Post(':clinicId/slots/:vismedDoctorId')
    async syncSlotsForDoctor(
        @Param('clinicId') clinicId: string,
        @Param('vismedDoctorId') vismedDoctorId: string,
        @Body('daysAhead') daysAhead?: number,
        @Request() req?: any,
    ) {
        this.validateUserClinicAccess(req?.user, clinicId);
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
        @Request() req?: any,
    ) {
        this.validateUserClinicAccess(req?.user, clinicId);
        const client = await this.getDoctoraliaClient(clinicId);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.slotSync.syncAllSlots(client, undefined, daysAhead || 30, clinicId);
    }

    @ApiOperation({ summary: 'Get shifts (turnos) for a VisMed doctor' })
    @Get(':clinicId/shifts/:vismedDoctorId')
    async getShifts(
        @Param('clinicId') clinicId: string,
        @Param('vismedDoctorId') vismedDoctorId: string,
        @Request() req?: any,
    ) {
        this.validateUserClinicAccess(req?.user, clinicId);
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
        @Request() req?: any,
    ) {
        this.validateUserClinicAccess(req?.user, clinicId);
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
                if (e.status === 409) {
                    results.push({ addressId: addr.id, status: 'enabled', note: 'already enabled' });
                    anySuccess = true;
                } else {
                    results.push({ addressId: addr.id, status: 'error', message: e.message });
                }
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
        @Request() req?: any,
    ) {
        this.validateUserClinicAccess(req?.user, clinicId);
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
                if (e.status === 409) {
                    results.push({ addressId: addr.id, status: 'disabled', note: 'already disabled' });
                    anySuccess = true;
                } else {
                    results.push({ addressId: addr.id, status: 'error', message: e.message });
                }
            }
        }

        if (anySuccess) {
            await this.updateCalendarStatusInMapping(clinicId, dDoc.id, 'disabled');
        }

        return { doctoraliaDoctorId, results };
    }

    @ApiOperation({ summary: 'Debug: check real Doctoralia calendar state for a doctor' })
    @Get(':clinicId/calendar/:doctoraliaDoctorId/debug')
    async debugCalendar(
        @Param('clinicId') clinicId: string,
        @Param('doctoraliaDoctorId') doctoraliaDoctorId: string,
        @Request() req?: any,
    ) {
        this.validateUserClinicAccess(req?.user, clinicId);
        const dDoc = await this.validateDoctoraliaDoctorBelongsToClinic(doctoraliaDoctorId, clinicId);
        const client = await this.getDoctoraliaClient(clinicId);

        const addrsRes = await client.getAddresses(dDoc.doctoraliaFacilityId, doctoraliaDoctorId);
        const addresses = addrsRes._items || [];

        const results: any[] = [];
        for (const addr of addresses) {
            const addrId = String(addr.id);
            let calendarStatus: any = null;
            let services: any = null;
            let slots: any = null;

            try {
                calendarStatus = await client.getCalendar(dDoc.doctoraliaFacilityId, doctoraliaDoctorId, addrId);
            } catch (e: any) {
                calendarStatus = { error: e.message, status: e.status };
            }

            try {
                const svcRes = await client.getServices(dDoc.doctoraliaFacilityId, doctoraliaDoctorId, addrId);
                services = svcRes._items || svcRes;
            } catch (e: any) { services = { error: e.message }; }

            try {
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                const nextWeek = new Date();
                nextWeek.setDate(nextWeek.getDate() + 7);
                const startStr = tomorrow.toISOString().split('T')[0] + 'T00:00:00-03:00';
                const endStr = nextWeek.toISOString().split('T')[0] + 'T23:59:59-03:00';
                slots = await client.getSlots(dDoc.doctoraliaFacilityId, doctoraliaDoctorId, addrId, startStr, endStr);
            } catch (e: any) { slots = { error: e.message }; }

            results.push({
                addressId: addrId,
                addressName: addr.name,
                calendarStatus,
                services,
                slotsNextWeek: slots,
            });
        }

        return { doctoraliaDoctorId, facilityId: dDoc.doctoraliaFacilityId, addresses: results };
    }

    @Post(':clinicId/insurance')
    @ApiOperation({ summary: 'Sync insurance providers to all doctors in Doctoralia' })
    async syncInsuranceProviders(
        @Request() req: any,
        @Param('clinicId') clinicId: string,
    ) {
        this.validateUserClinicAccess(req.user, clinicId);
        const client = await this.getDoctoraliaClient(clinicId);

        const mappings = await this.prisma.professionalUnifiedMapping.findMany({
            where: { isActive: true },
            include: {
                vismedDoctor: true,
                doctoraliaDoctor: true,
            }
        });

        const clinicDoctorMappings = await this.prisma.mapping.findMany({
            where: { clinicId, entityType: 'DOCTOR' },
            select: { vismedId: true },
        });
        const clinicDoctorIds = new Set(clinicDoctorMappings.map(m => m.vismedId).filter(Boolean));

        const results: any[] = [];

        for (const mapping of mappings) {
            if (!clinicDoctorIds.has(mapping.vismedDoctorId)) continue;
            const dDoc = mapping.doctoraliaDoctor;
            if (!dDoc) continue;

            let addresses: any[] = [];
            try {
                const res = await client.getAddresses(dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId);
                addresses = res._items || [];
            } catch (e: any) {
                results.push({ doctor: dDoc.name, error: e.message });
                continue;
            }

            for (const addr of addresses) {
                const addrId = String(addr.id);
                try {
                    const syncResult = await this.pushSync.syncInsuranceProviders(
                        null, client, clinicId, dDoc.doctoraliaFacilityId, dDoc.doctoraliaDoctorId, addrId, dDoc.name
                    );
                    results.push({ doctor: dDoc.name, addressId: addrId, ...syncResult });
                } catch (e: any) {
                    results.push({ doctor: dDoc.name, addressId: addrId, error: e.message });
                }
            }
        }

        return {
            total: results.length,
            results,
        };
    }

    @Get(':clinicId/insurance/:doctoraliaDoctorId')
    @ApiOperation({ summary: 'Get current insurance providers for a doctor address' })
    async getInsuranceProviders(
        @Request() req: any,
        @Param('clinicId') clinicId: string,
        @Param('doctoraliaDoctorId') doctoraliaDoctorId: string,
    ) {
        this.validateUserClinicAccess(req.user, clinicId);
        const client = await this.getDoctoraliaClient(clinicId);

        const dDoc = await this.prisma.doctoraliaDoctor.findFirst({
            where: { doctoraliaDoctorId },
        });
        if (!dDoc) throw new NotFoundException('Médico Doctoralia não encontrado.');

        const addrsRes = await client.getAddresses(dDoc.doctoraliaFacilityId, doctoraliaDoctorId);
        const addresses = addrsRes._items || [];
        const results: any[] = [];

        for (const addr of addresses) {
            const addrId = String(addr.id);
            const insRes = await client.getAddressInsuranceProviders(dDoc.doctoraliaFacilityId, doctoraliaDoctorId, addrId);
            results.push({
                addressId: addrId,
                addressName: addr.name,
                insuranceProviders: insRes._items || [],
            });
        }

        return { doctoraliaDoctorId, addresses: results };
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
