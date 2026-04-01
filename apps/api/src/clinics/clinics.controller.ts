import { Controller, Get, Post, Body, Param, Put, Delete, UseGuards, Req } from '@nestjs/common';
import { ClinicsService } from './clinics.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('clinics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('clinics')
export class ClinicsController {
    constructor(private readonly clinicsService: ClinicsService) { }

    @ApiOperation({ summary: 'Get clinics for the logged-in user' })
    @Get('my')
    async findMyClinics(@Req() req: any) {
        return this.clinicsService.findByUser(req.user.id, req.user.roles);
    }

    @ApiOperation({ summary: 'Get all clinics' })
    @Get()
    async findAll() {
        return this.clinicsService.findAll();
    }

    @ApiOperation({ summary: 'Get a single clinic by ID' })
    @Get(':id')
    async findOne(@Param('id') id: string) {
        return this.clinicsService.findOne(id);
    }

    @ApiOperation({ summary: 'Create a new clinic with optional integration credentials' })
    @Post()
    async create(@Body() data: any) {
        return this.clinicsService.create(data);
    }

    @ApiOperation({ summary: 'Update an existing clinic' })
    @Put(':id')
    async update(@Param('id') id: string, @Body() data: any) {
        return this.clinicsService.update(id, data);
    }

    @ApiOperation({ summary: 'Delete a clinic' })
    @Delete(':id')
    async remove(@Param('id') id: string) {
        return this.clinicsService.remove(id);
    }

    @ApiOperation({ summary: 'Test Doctoralia integration for a clinic' })
    @Post(':id/test-integration')
    async testIntegration(@Param('id') id: string) {
        return this.clinicsService.testIntegration(id);
    }

    @ApiOperation({ summary: 'Link a user to a clinic' })
    @Post(':id/users')
    async addUser(@Param('id') id: string, @Body() data: { userId: string; role?: string }) {
        return this.clinicsService.addUser(id, data.userId, data.role);
    }

    @ApiOperation({ summary: 'Remove a user from a clinic' })
    @Delete(':id/users/:userId')
    async removeUser(@Param('id') id: string, @Param('userId') userId: string) {
        return this.clinicsService.removeUser(id, userId);
    }

    @ApiOperation({ summary: 'Test VisMed integration for a clinic' })
    @Post(':id/test-vismed')
    async testVismedIntegration(@Param('id') id: string) {
        return this.clinicsService.testVismedIntegration(id);
    }
}

