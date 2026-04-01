import { Controller, Get, Post, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { MappingsService } from './mappings.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { MappingEntityType } from '@prisma/client';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('mappings')
export class MappingsController {
    constructor(private readonly mappingsService: MappingsService) { }

    @Get()
    findAll(
        @Request() req: any,
        @Query('clinicId') clinicId: string,
        @Query('type') type?: MappingEntityType,
    ) {
        const finalClinicId = clinicId || req.user.roles[0]?.clinicId;
        return this.mappingsService.findAll(finalClinicId, type);
    }

    @Post(':id/resolve')
    resolveConflict(
        @Request() req: any,
        @Param('id') id: string,
        @Body('dataToKeep') dataToKeep: 'VISMED' | 'EXTERNAL',
    ) {
        return this.mappingsService.resolveConflict(id, dataToKeep, req.user.id);
    }

    // ------------------------------------------------------------------------------------------
    // NOVO MODELO RELACIONAL — Profissionais e Unidades
    // ------------------------------------------------------------------------------------------

    @Get('professionals')
    getProfessionalMappings(@Request() req: any, @Query('clinicId') clinicId: string) {
        const finalClinicId = clinicId || req.user.roles[0]?.clinicId;
        return this.mappingsService.getProfessionalMappings(finalClinicId);
    }

    @Get('units')
    getUnitMappings(@Request() req: any, @Query('clinicId') clinicId: string) {
        const finalClinicId = clinicId || req.user.roles[0]?.clinicId;
        return this.mappingsService.getUnitMappings(finalClinicId);
    }

    // ------------------------------------------------------------------------------------------
    // NEW MATCHING ENGINE ENDPOINTS (SPRINT 6)
    // ------------------------------------------------------------------------------------------

    @Get('specialties/matches')
    getSpecialtyMatches(@Query('requiresReview') requiresReview?: string) {
        const reviewFilter = requiresReview ? requiresReview === 'true' : undefined;
        return this.mappingsService.getSpecialtyMatches(reviewFilter);
    }

    @Post('specialties/approve')
    approveSpecialtyMatch(
        @Request() req: any,
        @Body() body: { vismedSpecialtyId: string; doctoraliaServiceId: string; }
    ) {
        return this.mappingsService.approveSpecialtyMatch(body.vismedSpecialtyId, body.doctoraliaServiceId, req.user.id);
    }

    @Post('specialties/reject')
    rejectSpecialtyMatch(
        @Request() req: any,
        @Body() body: { vismedSpecialtyId: string; doctoraliaServiceId: string; }
    ) {
        return this.mappingsService.rejectSpecialtyMatch(body.vismedSpecialtyId, body.doctoraliaServiceId, req.user.id);
    }

    @Post('specialties/manual')
    createManualSpecialtyMatch(
        @Request() req: any,
        @Body() body: { vismedSpecialtyId: string; doctoraliaServiceId: string; }
    ) {
        return this.mappingsService.createManualSpecialtyMatch(body.vismedSpecialtyId, body.doctoraliaServiceId, req.user.id);
    }
}
