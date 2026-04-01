import { Controller, Post, Param, UseGuards, Get, Body } from '@nestjs/common';
import { SyncService } from './sync.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('sync')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('sync')
export class SyncController {
    constructor(
        private syncService: SyncService,
        private prisma: PrismaService
    ) { }

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
}
