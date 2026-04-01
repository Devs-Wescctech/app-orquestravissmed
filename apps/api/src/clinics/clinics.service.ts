import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerService } from '../integrations/docplanner.service';
import { VismedService } from '../integrations/vismed/vismed.service';

@Injectable()
export class ClinicsService {
    constructor(
        private prisma: PrismaService,
        private docplanner: DocplannerService,
        private vismed: VismedService,
    ) { }

    async findAll() {
        return this.prisma.clinic.findMany({
            include: {
                integrations: true,
                users: { include: { user: { select: { id: true, name: true, email: true } } } },
            },
            orderBy: { name: 'asc' },
        });
    }

    async findByUser(userId: string, roles?: any[]) {
        // SUPER_ADMIN sees all clinics
        const isSuperAdmin = roles?.some((r: any) => r.role === 'SUPER_ADMIN');
        if (isSuperAdmin) {
            return this.findAll();
        }

        // Regular users see only their linked clinics
        const userRoles = await this.prisma.userClinicRole.findMany({
            where: { userId },
            include: {
                clinic: {
                    include: {
                        integrations: true,
                    },
                },
            },
        });
        return userRoles.map((ur) => ({
            ...ur.clinic,
            userRole: ur.role,
        }));
    }

    async findOne(id: string) {
        const clinic = await this.prisma.clinic.findUnique({
            where: { id },
            include: {
                integrations: true,
                users: { include: { user: { select: { id: true, name: true, email: true } } } },
            },
        });
        if (!clinic) throw new NotFoundException('Clinic not found');
        return clinic;
    }

    async create(data: any) {
        const { integrationArgs, ...clinicData } = data;
        const clinic = await this.prisma.clinic.create({
            data: { ...clinicData },
        });

        if (integrationArgs) {
            await this.prisma.integrationConnection.create({
                data: { ...integrationArgs, clinicId: clinic.id },
            });
        }

        return this.findOne(clinic.id);
    }

    async update(id: string, data: any) {
        const { integrationArgs, ...clinicData } = data;

        // Filter out relation fields that Prisma won't accept
        const { users, integrations, ...safeData } = clinicData;

        await this.prisma.clinic.update({
            where: { id },
            data: safeData,
        });

        if (integrationArgs) {
            const existing = await this.prisma.integrationConnection.findFirst({
                where: { clinicId: id, provider: integrationArgs.provider || 'doctoralia' },
            });
            if (existing) {
                await this.prisma.integrationConnection.update({
                    where: { id: existing.id },
                    data: integrationArgs,
                });
            } else {
                await this.prisma.integrationConnection.create({
                    data: { ...integrationArgs, clinicId: id },
                });
            }
        }

        return this.findOne(id);
    }

    async remove(id: string) {
        return this.prisma.clinic.delete({ where: { id } });
    }

    async addUser(clinicId: string, userId: string, role?: string) {
        return this.prisma.userClinicRole.upsert({
            where: { userId_clinicId: { userId, clinicId } },
            update: { role: (role as any) || 'OPERATOR' },
            create: { userId, clinicId, role: (role as any) || 'OPERATOR' },
        });
    }

    async removeUser(clinicId: string, userId: string) {
        return this.prisma.userClinicRole.delete({
            where: { userId_clinicId: { userId, clinicId } },
        });
    }

    async testIntegration(clinicId: string) {
        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'doctoralia' },
        });
        if (!conn || !conn.clientId) {
            return { success: false, message: 'Integração Doctoralia não configurada' };
        }

        try {
            const client = this.docplanner.createClient(
                conn.domain || 'doctoralia.com.br',
                conn.clientId,
                conn.clientSecret || '',
            );
            const facilities = await client.getFacilities();
            const items = facilities._items || [];

            await this.prisma.integrationConnection.update({
                where: { id: conn.id },
                data: { status: 'connected', lastTestAt: new Date() },
            });

            return {
                success: true,
                message: `Conexão OK — ${items.length} facility(ies) encontrada(s)`,
                facilities: items.map((f: any) => ({ id: f.id, name: f.name })),
            };
        } catch (e: any) {
            await this.prisma.integrationConnection.update({
                where: { id: conn.id },
                data: { status: 'error', lastTestAt: new Date() },
            });
            return { success: false, message: `Erro: ${e.message}` };
        }
    }

    async testVismedIntegration(clinicId: string) {
        const conn = await this.prisma.integrationConnection.findFirst({
            where: { clinicId, provider: 'vismed' },
        });
        if (!conn || !conn.clientId) {
            return { success: false, message: 'Integração VisMed não configurada ou sem ID Empresa Gestora' };
        }

        try {
            // Utiliza o VismedService para buscar as unidades (usando o clientId como EmpresaGestora e o domain persistido)
            const unidades = await this.vismed.getUnidades(Number(conn.clientId), conn.domain || undefined);

            if (!unidades || unidades.length === 0) {
                throw new Error(`Nenhuma unidade localizada para a Empresa Gestora ID ${conn.clientId}`);
            }

            await this.prisma.integrationConnection.update({
                where: { id: conn.id },
                data: { status: 'connected', lastTestAt: new Date() },
            });

            return {
                success: true,
                message: `Conexão OK — ${unidades.length} unidade(s) visível(is) para Empresa ${conn.clientId}`,
            };
        } catch (e: any) {
            await this.prisma.integrationConnection.update({
                where: { id: conn.id },
                data: { status: 'error', lastTestAt: new Date() },
            });
            return { success: false, message: `Falha na conexão: ${e.message}` };
        }
    }
}
