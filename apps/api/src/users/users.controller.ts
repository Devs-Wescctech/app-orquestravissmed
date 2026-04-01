import { Controller, Get, Post, Body, Param, Put, Delete, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
    constructor(
        private readonly usersService: UsersService,
        private readonly prisma: PrismaService
    ) { }

    @ApiOperation({ summary: 'Get all users' })
    @Get()
    async findAll() {
        return this.usersService.findAll();
    }

    @ApiOperation({ summary: 'Get a single user by ID' })
    @Get(':id')
    async findOne(@Param('id') id: string) {
        return this.usersService.findById(id);
    }

    @ApiOperation({ summary: 'Create a new user' })
    @Post()
    async create(@Body() data: any) {
        // Basic implementation for MVP matching the specific frontend
        const hashedPassword = await bcrypt.hash(data.password, 10);
        const user = await this.prisma.user.create({
            data: {
                email: data.email,
                name: data.name,
                password: hashedPassword,
                active: data.active ?? true,
                roles: {
                    create: data.clinicId ? {
                        clinicId: data.clinicId,
                        role: data.role || 'OPERATOR'
                    } : undefined
                }
            }
        });
        const { password, ...result } = user;
        return result;
    }

    @ApiOperation({ summary: 'Update an existing user' })
    @Put(':id')
    async update(@Param('id') id: string, @Body() data: any) {
        let updateData: any = { ...data };
        if (data.password) {
            updateData.password = await bcrypt.hash(data.password, 10);
        }
        const user = await this.prisma.user.update({
            where: { id },
            data: updateData,
        });
        const { password, ...result } = user;
        return result;
    }

    @ApiOperation({ summary: 'Delete a user' })
    @Delete(':id')
    async remove(@Param('id') id: string) {
        return this.prisma.user.delete({ where: { id } });
    }
}
