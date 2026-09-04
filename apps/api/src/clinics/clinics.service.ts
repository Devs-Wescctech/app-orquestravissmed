import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerService } from '../integrations/docplanner.service';
import { VismedService } from '../integrations/vismed/vismed.service';
import { runWithDoctoraliaContext } from '../metrics/doctoralia-call-context';
import { isDoctoraliaQueueError } from '../integrations/doctoralia-queue.errors';

@Injectable()
export class ClinicsService {
    constructor(
        private prisma: PrismaService,
        private docplanner: DocplannerService,
        private vismed: VismedService,
    ) { }

    private assertAppointmentFeedModeIsNotOperationallyManaged(integrationArgs: any) {
        if (
            integrationArgs
            && Object.prototype.hasOwnProperty.call(
                integrationArgs,
                'vismedAppointmentFeedMode',
            )
        ) {
            throw new BadRequestException(
                'O modo do feed de agendamentos VisMed ainda não pode ser alterado por API.',
            );
        }
    }

    private sanitizeIntegrationArgs(integrationArgs: any): { data: any; explicitReauthorization: boolean } {
        if (!integrationArgs) return { data: integrationArgs, explicitReauthorization: false };
        const {
            catalogScopeVersion: _ignoredVersion,
            reauthorize,
            ...data
        } = integrationArgs;
        return { data, explicitReauthorization: reauthorize === true };
    }

    private doctoraliaScopeChanged(existing: any, next: any, explicitReauthorization: boolean): boolean {
        if ((next.provider ?? existing.provider) !== 'doctoralia') return false;
        if (explicitReauthorization) return true;
        const identityScopeFields = ['domain', 'clientId', 'clientSecret', 'facilityId'];
        return identityScopeFields.some(field =>
            Object.prototype.hasOwnProperty.call(next, field)
            && (next[field] ?? null) !== (existing[field] ?? null),
        );
    }

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
        this.assertAppointmentFeedModeIsNotOperationallyManaged(integrationArgs);
        const clinic = await this.prisma.clinic.create({
            data: { ...clinicData },
        });

        if (integrationArgs) {
            const sanitized = this.sanitizeIntegrationArgs(integrationArgs);
            await this.prisma.integrationConnection.create({
                data: { ...sanitized.data, clinicId: clinic.id },
            });
        }

        return this.findOne(clinic.id);
    }

    async update(id: string, data: any) {
        const { integrationArgs, ...clinicData } = data;
        this.assertAppointmentFeedModeIsNotOperationallyManaged(integrationArgs);

        // Filter out relation fields that Prisma won't accept
        const { users, integrations, ...safeData } = clinicData;

        await this.prisma.clinic.update({
            where: { id },
            data: safeData,
        });

        if (integrationArgs) {
            const sanitized = this.sanitizeIntegrationArgs(integrationArgs);
            const existing = await this.prisma.integrationConnection.findFirst({
                where: { clinicId: id, provider: sanitized.data.provider || 'doctoralia' },
            });
            if (existing) {
                await this.prisma.integrationConnection.update({
                    where: { id: existing.id },
                    data: {
                        ...sanitized.data,
                        ...(this.doctoraliaScopeChanged(
                            existing,
                            sanitized.data,
                            sanitized.explicitReauthorization,
                        ) ? { catalogScopeVersion: { increment: 1 } } : {}),
                    },
                });
            } else {
                await this.prisma.integrationConnection.create({
                    data: { ...sanitized.data, clinicId: id },
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

        // WP-01: propagate USER_INTERACTIVE context for the test connection call
        return runWithDoctoraliaContext({ origin: 'USER_INTERACTIVE', clinicId }, async () => {
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
            // Não rebaixa uma conexão 'connected' em uso: uma falha momentânea no teste
            // (ex.: WAF da Doctoralia) não pode tirar a clínica do polling/varredura.
            // WP-08B: erros de backpressure da fila (QueueFull/QueueTimeout) são
            // saturação INTERNA — jamais rebaixam o status da integração.
            const demote = conn.status !== 'connected' && !isDoctoraliaQueueError(e);
            await this.prisma.integrationConnection.update({
                where: { id: conn.id },
                data: { ...(demote ? { status: 'error' } : {}), lastTestAt: new Date() },
            });
            return {
                success: false,
                message: `Erro: ${e.message}${demote ? '' : ' — status mantido como "connected"; a importação de agendamentos continua ativa'}`,
            };
        }
        }); // end runWithDoctoraliaContext(USER_INTERACTIVE)
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
            // Mesma regra da Doctoralia: teste falho não rebaixa conexão 'connected' em uso.
            const demote = conn.status !== 'connected';
            await this.prisma.integrationConnection.update({
                where: { id: conn.id },
                data: { ...(demote ? { status: 'error' } : {}), lastTestAt: new Date() },
            });
            return {
                success: false,
                message: `Falha na conexão: ${e.message}${demote ? '' : ' — status mantido como "connected"; a importação continua ativa'}`,
            };
        }
    }
}
