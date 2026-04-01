import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { DoctorsService } from './doctors.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('doctors')
@UseGuards(JwtAuthGuard)
export class DoctorsController {
    constructor(private readonly doctorsService: DoctorsService) { }

    /**
     * GET /doctors — Returns synced Doctoralia doctors from the Mapping table
     */
    @Get()
    findAll(@Query('clinicId') clinicId: string) {
        return this.doctorsService.findAllFromDoctoralia(clinicId);
    }

    /**
     * GET /doctors/count — Count of synced doctors
     */
    @Get('count')
    count(@Query('clinicId') clinicId: string) {
        return this.doctorsService.count(clinicId);
    }

    /**
     * POST /doctors/sync — Fetches live data from Doctoralia API and updates Mapping table
     */
    @Post('sync')
    syncLive(@Query('clinicId') clinicId: string) {
        return this.doctorsService.fetchLive(clinicId);
    }
}
