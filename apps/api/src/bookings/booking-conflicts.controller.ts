import { Controller, Get, Query, Param, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BookingConflictsService } from './booking-conflicts.service';

@Controller('booking-sync/records')
@UseGuards(JwtAuthGuard)
export class BookingConflictsController {
    constructor(private readonly conflicts: BookingConflictsService) {}

    @Get(':id/conflict-details')
    inspect(@Req() req: any, @Param('id') id: string, @Query('clinicId') clinicId: string) {
        if (!clinicId || !req.user.roles?.some((r: any) => r.role === 'SUPER_ADMIN' || r.clinicId === clinicId)) {
            throw new ForbiddenException('Acesso negado a esta clínica');
        }
        return this.conflicts.inspect(clinicId, id);
    }
}
