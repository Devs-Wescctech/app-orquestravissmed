import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { DocplannerService } from './docplanner.service';

/**
 * Renovador de token OAuth Doctoralia em segundo plano.
 *
 * Contexto: o AWS WAF da Doctoralia desafia o IP do servidor de forma intermitente
 * (janelas de baixa pontuação passam; ex.: madrugada). Como o token vale ~24h e agora é
 * persistido no banco, UMA autenticação bem-sucedida por dia basta. Este cron tenta
 * discretamente (1 POST por clientId a cada ciclo, no máximo) garantir que sempre exista
 * um token válido, aproveitando qualquer janela em que o WAF deixe passar.
 *
 * Respeita a pausa da Central de Sincronização (status 'paused') e conexões desativadas.
 */
@Injectable()
export class TokenRefresherService implements OnModuleInit {
    private readonly logger = new Logger(TokenRefresherService.name);
    private isRunning = false;

    // Renova quando faltar menos que esta margem para expirar (2h de um token de 24h).
    private static readonly RENEW_MARGIN_MS = 2 * 60 * 60 * 1000;

    constructor(
        private readonly prisma: PrismaService,
        private readonly docplanner: DocplannerService,
    ) {}

    onModuleInit() {
        this.logger.log('[TOKEN-REFRESHER] Ativo — garante token OAuth Doctoralia válido a cada 15min (aproveita janelas do WAF; token persiste 24h no banco).');
    }

    @Cron('*/15 * * * *', { name: 'doctoralia-token-refresher' })
    async refreshAll() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            const conns = await this.prisma.integrationConnection.findMany({
                where: {
                    provider: 'doctoralia',
                    status: { in: ['connected', 'error'] },
                    clientId: { not: null },
                    NOT: [{ clientSecret: null }, { clientSecret: '' }],
                },
                select: { id: true, clientId: true, clientSecret: true, domain: true, tokenExpiresAt: true },
            });
            const seen = new Set<string>();
            for (const conn of conns) {
                if (!conn.clientId || seen.has(conn.clientId)) continue;
                seen.add(conn.clientId);

                const expiresAt = conn.tokenExpiresAt?.getTime() ?? 0;
                if (expiresAt - Date.now() > TokenRefresherService.RENEW_MARGIN_MS) continue; // token saudável

                try {
                    const client = this.docplanner.createClient(
                        conn.domain || 'www.doctoralia.com.br',
                        conn.clientId,
                        conn.clientSecret || '',
                    );
                    if (expiresAt > Date.now()) {
                        // Token ainda válido mas dentro da margem: força um token NOVO
                        // (getToken(false) devolveria o atual e nunca renovaria).
                        await client.forceTokenRefresh(conn.clientId, conn.clientSecret || '');
                    } else {
                        await client.authenticate(conn.clientId, conn.clientSecret || '');
                    }
                    this.logger.log(`[TOKEN-REFRESHER] Token garantido para clientId ${conn.clientId.split('_')[0]}_***.`);
                } catch (err: any) {
                    // Esperado enquanto o WAF desafia; tenta de novo no próximo ciclo.
                    this.logger.warn(`[TOKEN-REFRESHER] Sem sucesso para clientId ${conn.clientId.split('_')[0]}_*** (tentará novamente em 15min): ${String(err?.message).slice(0, 120)}`);
                }
            }
        } catch (err: any) {
            this.logger.error(`[TOKEN-REFRESHER] Erro inesperado: ${err?.message}`);
        } finally {
            this.isRunning = false;
        }
    }
}
