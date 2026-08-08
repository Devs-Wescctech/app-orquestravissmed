import { Controller, Get, Query, UseGuards, Req, ForbiddenException, Patch, Post, Body, Put, Delete } from '@nestjs/common';
import { AppointmentsService } from './appointments.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { runWithDoctoraliaContext } from '../metrics/doctoralia-call-context';
import { randomUUID } from 'crypto';

@Controller('appointments')
@UseGuards(JwtAuthGuard)
export class AppointmentsController {
    constructor(private readonly appointmentsService: AppointmentsService) { }

    /** Validate that the user has access to the requested clinic */
    private validateClinicAccess(user: any, clinicId: string): void {
        if (!clinicId) throw new ForbiddenException('clinicId é obrigatório');
        const isSuperAdmin = user.roles?.some((r: any) => r.role === 'SUPER_ADMIN');
        if (isSuperAdmin) return;
        const hasAccess = user.roles?.some((r: any) => r.clinicId === clinicId);
        if (!hasAccess) throw new ForbiddenException('Acesso negado a esta clínica');
    }

    /** Default date range: today + 7 days */
    private defaultDates(start?: string, end?: string) {
        const today = new Date();
        const weekLater = new Date();
        weekLater.setDate(weekLater.getDate() + 7);
        return {
            start: start || today.toISOString().split('T')[0],
            end: end || weekLater.toISOString().split('T')[0],
        };
    }

    /**
     * GET /appointments/calendar-status — Calendar integration status for all doctors
     */
    @Get('calendar-status')
    calendarStatus(@Req() req: any, @Query('clinicId') clinicId: string) {
        this.validateClinicAccess(req.user, clinicId);
        return this.appointmentsService.getCalendarStatus(clinicId);
    }

    /**
     * GET /appointments/bookings — Real bookings from Doctoralia
     */
    @Get('bookings')
    getBookings(
        @Req() req: any,
        @Query('clinicId') clinicId: string,
        @Query('doctorId') doctorId: string,
        @Query('start') start: string,
        @Query('end') end: string,
    ) {
        this.validateClinicAccess(req.user, clinicId);
        const dates = this.defaultDates(start, end);
        // WP-01: propagate USER_INTERACTIVE context with per-request ID
        const requestId = randomUUID();
        return runWithDoctoraliaContext({ origin: 'USER_INTERACTIVE', clinicId, requestId }, async () => {
            if (doctorId) {
                return this.appointmentsService.getBookings(clinicId, doctorId, dates.start, dates.end);
            }
            return this.appointmentsService.getAllBookings(clinicId, dates.start, dates.end);
        });
    }

    /**
     * GET /appointments/slots — Available slots from Doctoralia
     */
    @Get('slots')
    getSlots(
        @Req() req: any,
        @Query('clinicId') clinicId: string,
        @Query('doctorId') doctorId: string,
        @Query('start') start: string,
        @Query('end') end: string,
    ) {
        this.validateClinicAccess(req.user, clinicId);
        const dates = this.defaultDates(start, end);
        if (!doctorId) {
            return { slots: [], error: 'doctorId é obrigatório para buscar slots' };
        }
        // WP-01: propagate USER_INTERACTIVE context
        const requestId = randomUUID();
        return runWithDoctoraliaContext({ origin: 'USER_INTERACTIVE', clinicId, requestId }, () =>
            this.appointmentsService.getSlots(clinicId, doctorId, dates.start, dates.end),
        );
    }

    /**
     * PUT /appointments/slots — Replace/Add slots (work periods)
     */
    @Put('slots')
    replaceSlots(
        @Req() req: any,
        @Body() body: { clinicId: string; doctorId: string; slots: any[] }
    ) {
        this.validateClinicAccess(req.user, body.clinicId);
        // WP-01: propagate USER_INTERACTIVE context
        const requestId = randomUUID();
        return runWithDoctoraliaContext({ origin: 'USER_INTERACTIVE', clinicId: body.clinicId, requestId }, () =>
            this.appointmentsService.replaceSlots(body.clinicId, body.doctorId, body.slots),
        );
    }

    /**
     * POST /appointments/slots/book — Book a certain slot
     */
    @Post('slots/book')
    bookSlot(
        @Req() req: any,
        @Body() body: { clinicId: string; doctorId: string; [key: string]: any }
    ) {
        const { clinicId, doctorId, ...payload } = body;
        this.validateClinicAccess(req.user, clinicId);
        // WP-01: propagate USER_INTERACTIVE context
        const requestId = randomUUID();
        return runWithDoctoraliaContext({ origin: 'USER_INTERACTIVE', clinicId, requestId }, () =>
            this.appointmentsService.bookSlot(clinicId, doctorId, payload),
        );
    }

    /**
     * DELETE /appointments/slots — Delete slots in range
     */
    @Delete('slots')
    deleteSlots(
        @Req() req: any,
        @Query('clinicId') clinicId: string,
        @Query('doctorId') doctorId: string,
        @Query('start') start: string,
        @Query('end') end: string
    ) {
        this.validateClinicAccess(req.user, clinicId);
        if (!doctorId || !start || !end) {
            throw new ForbiddenException('doctorId, start e end são obrigatórios');
        }
        // WP-01: propagate USER_INTERACTIVE context
        const requestId = randomUUID();
        return runWithDoctoraliaContext({ origin: 'USER_INTERACTIVE', clinicId, requestId }, () =>
            this.appointmentsService.deleteSlots(clinicId, doctorId, start, end),
        );
    }

    /**
     * GET /appointments/stats — Dashboard stats
     */
    @Get('stats')
    stats(@Req() req: any, @Query('clinicId') clinicId: string) {
        this.validateClinicAccess(req.user, clinicId);
        return this.appointmentsService.dashboardStats(clinicId);
    }

    /**
     * POST /appointments/calendar-status — Update doctor calendar status
     */
    @Post('calendar-status')
    updateCalendarStatus(
        @Req() req: any,
        @Body() body: { clinicId?: string; doctoraliaDoctorId: string; status: 'enabled' | 'disabled' }
    ) {
        const finalClinicId = body.clinicId || req.user.roles?.[0]?.clinicId;
        this.validateClinicAccess(req.user, finalClinicId);
        // WP-01: propagate USER_INTERACTIVE context
        const requestId = randomUUID();
        return runWithDoctoraliaContext({ origin: 'USER_INTERACTIVE', clinicId: finalClinicId, requestId }, () =>
            this.appointmentsService.updateCalendarStatus(finalClinicId, body.doctoraliaDoctorId, body.status, req.user.id),
        );
    }
}
