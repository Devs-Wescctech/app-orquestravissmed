import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('settings')
export class SettingsController {
    @ApiOperation({ summary: 'Read-only operational system config (SUPER_ADMIN only). Derived from environment variables; no secrets exposed.' })
    @Roles('SUPER_ADMIN')
    @Get('system')
    getSystemConfig() {
        const slotSource = (process.env.SLOT_SOURCE || 'availability').toLowerCase() === 'template'
            ? 'template'
            : 'availability';
        const syncCronDisabled = process.env.DISABLE_SYNC_CRON === 'true';
        const slotInsuranceMode = (process.env.SLOT_INSURANCE_MODE || 'with-insurance-only').toLowerCase();

        return {
            managedByEnv: true,
            settings: [
                {
                    key: 'SLOT_SOURCE',
                    label: 'Fonte de slots',
                    value: slotSource,
                    description: slotSource === 'template'
                        ? 'Slots gerados a partir do template de turnos do profissional.'
                        : 'Slots derivados da disponibilidade real (scheduleDay) na VisMed.',
                },
                {
                    key: 'DISABLE_SYNC_CRON',
                    label: 'Workers de sincronização',
                    value: syncCronDisabled ? 'desativados' : 'ativados',
                    description: syncCronDisabled
                        ? 'Cron de sincronização automática está DESATIVADO.'
                        : 'Cron de sincronização automática está ativo.',
                },
                {
                    key: 'SLOT_INSURANCE_MODE',
                    label: 'Modo de convênio nos slots',
                    value: slotInsuranceMode,
                    description: slotInsuranceMode === 'with-insurance-only'
                        ? 'Slots publicados apenas com planos de convênio vinculados.'
                        : 'Modo de convênio configurado: ' + slotInsuranceMode + '.',
                },
            ],
        };
    }
}
