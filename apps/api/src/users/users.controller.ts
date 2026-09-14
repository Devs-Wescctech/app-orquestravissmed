import { Controller, Get, Post, Body, Param, Put, Delete, UseGuards, Request, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '@prisma/client';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { userWriteInput } from './user-write-input';

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
    @Roles(Role.SUPER_ADMIN)
    async findAll() {
        return this.usersService.findAll();
    }

    @ApiOperation({ summary: 'Get own profile' })
    @Get('me/profile')
    async getMyProfile(@Request() req: any) {
        return this.usersService.findById(req.user.id);
    }

    @ApiOperation({ summary: 'Update own profile (name)' })
    @Put('me/profile')
    async updateMyProfile(@Request() req: any, @Body() data: any) {
        const name = (data?.name || '').trim();
        if (!name) {
            throw new BadRequestException('Nome é obrigatório');
        }
        const user = await this.prisma.user.update({
            where: { id: req.user.id },
            data: { name },
        });
        const { password, ...result } = user;
        return result;
    }

    @ApiOperation({ summary: 'Change own password (validates current password)' })
    @Put('me/password')
    async changeMyPassword(@Request() req: any, @Body() data: any) {
        const { currentPassword, newPassword } = data || {};
        if (!currentPassword || !newPassword) {
            throw new BadRequestException('Senha atual e nova senha são obrigatórias');
        }
        if (String(newPassword).length < 6) {
            throw new BadRequestException('A nova senha deve ter pelo menos 6 caracteres');
        }
        const user = await this.prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user) {
            throw new UnauthorizedException('Usuário não encontrado');
        }
        const valid = await bcrypt.compare(currentPassword, user.password);
        if (!valid) {
            throw new UnauthorizedException('Senha atual incorreta');
        }
        const hashed = await bcrypt.hash(newPassword, 10);
        await this.prisma.user.update({
            where: { id: req.user.id },
            data: { password: hashed },
        });
        return { success: true };
    }

    @ApiOperation({ summary: 'Get a single user by ID' })
    @Get(':id')
    @Roles(Role.SUPER_ADMIN)
    async findOne(@Param('id') id: string) {
        return this.usersService.findById(id);
    }

    @ApiOperation({ summary: 'Create a new user' })
    @Post()
    @Roles(Role.SUPER_ADMIN)
    async create(@Body() body: any) {
        const data = userWriteInput(body, true);
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
    @Roles(Role.SUPER_ADMIN)
    async update(@Param('id') id: string, @Body() body: any, @Request() req: any) {
        const data = userWriteInput(body);
        if (id === req.user.id && data.active === false) throw new BadRequestException('Você não pode desativar a própria conta');
        const updateData: any = { ...data };
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
    @Roles(Role.SUPER_ADMIN)
    async remove(@Param('id') id: string, @Request() req: any) {
        if (id === req.user.id) throw new BadRequestException('Você não pode excluir a própria conta');
        const { password, ...user } = await this.prisma.user.delete({ where: { id } });
        return user;
    }
}
