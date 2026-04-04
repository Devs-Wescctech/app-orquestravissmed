import { Controller, Post, Body, Get, Query, UseGuards, Req, Logger, ForbiddenException, Delete, Param } from '@nestjs/common';
import { BookingSyncService } from './booking-sync.service';
import { QueueService } from './queue.service';
import { RateLimiterService } from './rate-limiter.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

@Controller('webhooks')
export class WebhookController {
    private readonly logger = new Logger(WebhookController.name);

    constructor(private readonly bookingSyncService: BookingSyncService) {}

    @Post('doctoralia')
    async handleDoctoraliaWebhook(@Body() body: any) {
        this.logger.log(`[WEBHOOK] Received: ${body?.name || 'unknown'}`);
        const result = await this.bookingSyncService.processWebhookNotification(body);
        return { ok: true, ...result };
    }
}

@Controller('booking-sync')
@UseGuards(JwtAuthGuard)
export class BookingSyncController {
    private readonly logger = new Logger(BookingSyncController.name);

    constructor(
        private readonly bookingSyncService: BookingSyncService,
        private readonly queueService: QueueService,
        private readonly rateLimiter: RateLimiterService,
        private readonly prisma: PrismaService,
    ) {}

    private validateClinicAccess(user: any, clinicId: string): void {
        if (!clinicId) throw new ForbiddenException('clinicId é obrigatório');
        const isSuperAdmin = user.roles?.some((r: any) => r.role === 'SUPER_ADMIN');
        if (isSuperAdmin) return;
        const hasAccess = user.roles?.some((r: any) => r.clinicId === clinicId);
        if (!hasAccess) throw new ForbiddenException('Acesso negado a esta clínica');
    }

    @Get('records')
    async getRecords(
        @Req() req: any,
        @Query('clinicId') clinicId: string,
        @Query('doctoraliaDoctorId') doctoraliaDoctorId?: string,
        @Query('vismedDoctorId') vismedDoctorId?: string,
        @Query('start') startDate?: string,
        @Query('end') endDate?: string,
        @Query('origin') origin?: string,
        @Query('status') status?: string,
    ) {
        this.validateClinicAccess(req.user, clinicId);
        return this.bookingSyncService.getBookingSyncRecords(clinicId, {
            doctoraliaDoctorId,
            vismedDoctorId,
            startDate,
            endDate,
            origin,
            status,
        });
    }

    @Get('stats')
    async getStats(@Req() req: any, @Query('clinicId') clinicId: string) {
        this.validateClinicAccess(req.user, clinicId);
        return this.bookingSyncService.getSyncStats(clinicId);
    }

    @Get('health')
    async getHealth(@Req() req: any) {
        const [queueMetrics, rateLimiterStats] = await Promise.all([
            this.queueService.getMetrics(),
            this.rateLimiter.getStats(),
        ]);

        const connectedClinics = await this.prisma.integrationConnection.count({
            where: { provider: 'doctoralia', status: 'connected' },
        });

        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
            connectedClinics,
            queue: queueMetrics,
            rateLimiter: rateLimiterStats,
        };
    }

    @Get('metrics')
    async getClinicMetrics(
        @Req() req: any,
        @Query('clinicId') clinicId?: string,
    ) {
        if (clinicId) {
            this.validateClinicAccess(req.user, clinicId);
            return this.queueService.getClinicMetrics(clinicId);
        }

        const connections = await this.prisma.integrationConnection.findMany({
            where: { provider: 'doctoralia', status: 'connected' },
            select: { clinicId: true },
        });

        const metrics = await Promise.all(
            connections.map(c => this.queueService.getClinicMetrics(c.clinicId)),
        );

        return { clinics: metrics };
    }

    @Post('retry-dead-letters')
    async retryDeadLetters(
        @Req() req: any,
        @Body() body: { clinicId: string },
    ) {
        if (!body?.clinicId) {
            throw new ForbiddenException('clinicId é obrigatório');
        }
        this.validateClinicAccess(req.user, body.clinicId);
        return this.queueService.retryDeadLetters(body.clinicId);
    }

    @Post('book-from-vismed')
    async bookFromVismed(
        @Req() req: any,
        @Body() body: {
            clinicId: string;
            vismedDoctorId?: string;
            doctoraliaDoctorId?: string;
            slotStart: string;
            patient: {
                name: string;
                surname?: string;
                phone?: string;
                email?: string;
                cpf?: string;
                birthDate?: string;
                gender?: string;
            };
            addressServiceId?: string;
            duration?: number;
        },
    ) {
        this.validateClinicAccess(req.user, body.clinicId);

        let vismedDoctorId = body.vismedDoctorId;

        if (!vismedDoctorId && body.doctoraliaDoctorId) {
            const mapping = await this.prisma.mapping.findFirst({
                where: {
                    clinicId: body.clinicId,
                    entityType: 'DOCTOR',
                    externalId: body.doctoraliaDoctorId,
                    status: 'LINKED',
                },
            });
            if (mapping?.vismedId) {
                vismedDoctorId = mapping.vismedId;
            } else {
                throw new ForbiddenException('Médico não possui mapeamento VisMed↔Doctoralia');
            }
        }

        if (!vismedDoctorId) {
            throw new ForbiddenException('vismedDoctorId ou doctoraliaDoctorId é obrigatório');
        }

        return this.bookingSyncService.bookOnDoctoraliaFromVismed(
            body.clinicId,
            vismedDoctorId,
            body.slotStart,
            body.patient,
            body.addressServiceId,
            body.duration,
        );
    }

    @Delete('cancel/:doctoraliaBookingId')
    async cancelBooking(
        @Req() req: any,
        @Param('doctoraliaBookingId') doctoraliaBookingId: string,
        @Query('clinicId') clinicId: string,
        @Body() body?: { reason?: string },
    ) {
        this.validateClinicAccess(req.user, clinicId);
        return this.bookingSyncService.cancelOnDoctoraliaFromVismed(clinicId, doctoraliaBookingId, body?.reason);
    }

    @Post('poll')
    async triggerPoll(@Req() req: any) {
        this.logger.log('[MANUAL] Triggering notification poll');
        await this.bookingSyncService.pollNotifications();
        return { ok: true, message: 'Polling completed' };
    }
}
