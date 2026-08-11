/**
 * WP-08A — Filtro global para DoctoraliaCircuitOpenError.
 *
 * Fluxos USER_INTERACTIVE (sync.controller e demais endpoints que tocam a
 * Doctoralia) recebem 503 imediato e amigável, com a estimativa de retorno,
 * em vez de um 500 genérico. Nenhum estado de integração é alterado aqui.
 */
import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { DoctoraliaCircuitOpenError } from './doctoralia-circuit-breaker';

@Catch(DoctoraliaCircuitOpenError)
export class DoctoraliaCircuitOpenFilter implements ExceptionFilter {
    private readonly logger = new Logger(DoctoraliaCircuitOpenFilter.name);

    catch(exception: DoctoraliaCircuitOpenError, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse();
        const retryAfterSec = Math.max(1, Math.ceil(exception.cooldownRemainingMs / 1000));
        this.logger.debug(`[CIRCUIT] Requisição UI em fast-fail (${exception.reason}, ~${retryAfterSec}s restantes)`);
        response
            .status(HttpStatus.SERVICE_UNAVAILABLE)
            .header('Retry-After', String(retryAfterSec))
            .json({
                statusCode: HttpStatus.SERVICE_UNAVAILABLE,
                error: 'Service Unavailable',
                message:
                    'A Doctoralia está temporariamente indisponível e as chamadas foram pausadas ' +
                    `para proteger a integração. Tente novamente em cerca de ${retryAfterSec} segundo(s).`,
                reason: exception.reason,
                cooldownRemainingMs: exception.cooldownRemainingMs,
            });
    }
}
