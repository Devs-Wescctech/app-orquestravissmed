/**
 * WP-01 — Endpoint de relatório de observabilidade Doctoralia.
 * GET /metrics/doctoralia-baseline — restrito a usuários com role SUPER_ADMIN.
 *
 * O relatório contém dados operacionais globais (clinicIds, volumes, fila), por isso
 * não pode ser exposto para usuários com escopo de clínica. Somente SUPER_ADMIN.
 */
import { Controller, ForbiddenException, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DoctoraliaMetricsService } from './doctoralia-metrics.service';

@Controller('metrics')
@UseGuards(JwtAuthGuard)
export class MetricsController {
    constructor(private readonly metricsService: DoctoraliaMetricsService) {}

    /**
     * GET /metrics/doctoralia-baseline
     *
     * Retorna o Executive Summary completo: volume, origem, fila (p50/p95/p99/máx/buckets),
     * erros, polling, agendamentos, duplicatas e measurementScope.
     *
     * **Restrito a SUPER_ADMIN**: o relatório inclui dados de todas as clínicas.
     *
     * **Atenção**: em cenário multi-instância sem Redis, este endpoint representa
     * apenas a instância que atendeu a requisição (ver measurementScope no response).
     */
    @Get('doctoralia-baseline')
    getDoctoraliaBaseline(@Req() req: any) {
        const isSuperAdmin = req.user?.roles?.some((r: any) => r.role === 'SUPER_ADMIN');
        if (!isSuperAdmin) {
            throw new ForbiddenException('Acesso restrito a administradores globais (SUPER_ADMIN).');
        }
        return this.metricsService.getBaseline();
    }
}
