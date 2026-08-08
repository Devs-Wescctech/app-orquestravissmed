import { Logger } from '@nestjs/common';

const logger = new Logger('SyncCycleContext');

/**
 * Contexto de ciclo de sync: armazena respostas de GET /addresses e GET /services
 * para um único par (facilityId, doctorId) dentro de uma execução de sync.
 *
 * Regras de isolamento:
 * - Um contexto é criado POR médico em `pushToDoctoralia` e passado como parâmetro.
 * - Dados de um médico nunca são acessíveis por outro médico/clínica.
 * - O contexto é descartado ao final do ciclo (escopo local, não campo de classe).
 * - Se SlotSync for acionado isoladamente (sem PushSync), ele faz a chamada real e
 *   armazena no contexto para reuso dentro do mesmo ciclo.
 *
 * Métricas: `sync_context_hit` / `sync_context_miss` por tipo de recurso.
 */
export class SyncCycleContext {
    private readonly addresses = new Map<string, any[]>();
    private readonly services = new Map<string, any[]>();

    private readonly hits = { addresses: 0, services: 0 };
    private readonly misses = { addresses: 0, services: 0 };

    // ── Addresses ────────────────────────────────────────────────────────────

    getAddresses(facilityId: string, doctorId: string): any[] | undefined {
        const key = `${facilityId}:${doctorId}`;
        const cached = this.addresses.get(key);
        if (cached !== undefined) {
            this.hits.addresses++;
            logger.debug(`sync_context_hit addresses ${key}`);
            return cached;
        }
        this.misses.addresses++;
        logger.debug(`sync_context_miss addresses ${key}`);
        return undefined;
    }

    setAddresses(facilityId: string, doctorId: string, items: any[]): void {
        this.addresses.set(`${facilityId}:${doctorId}`, items);
    }

    // ── Services ─────────────────────────────────────────────────────────────

    getServices(facilityId: string, doctorId: string, addressId: string): any[] | undefined {
        const key = `${facilityId}:${doctorId}:${addressId}`;
        const cached = this.services.get(key);
        if (cached !== undefined) {
            this.hits.services++;
            logger.debug(`sync_context_hit services ${key}`);
            return cached;
        }
        this.misses.services++;
        logger.debug(`sync_context_miss services ${key}`);
        return undefined;
    }

    setServices(facilityId: string, doctorId: string, addressId: string, items: any[]): void {
        this.services.set(`${facilityId}:${doctorId}:${addressId}`, items);
    }

    /**
     * Invalida o cache de serviços para um endereço específico.
     * Deve ser chamado após qualquer mutação (add/delete) em syncServicesDelta,
     * para que o SlotSync subsequente busque a lista atualizada da Doctoralia.
     */
    invalidateServices(facilityId: string, doctorId: string, addressId: string): void {
        const key = `${facilityId}:${doctorId}:${addressId}`;
        this.services.delete(key);
        logger.debug(`sync_context_invalidated services ${key}`);
    }

    // ── Stats ─────────────────────────────────────────────────────────────────

    getStats(): { hits: { addresses: number; services: number }; misses: { addresses: number; services: number } } {
        return { hits: { ...this.hits }, misses: { ...this.misses } };
    }

    logStats(doctorLabel: string): void {
        const { hits, misses } = this;
        const totalHits = hits.addresses + hits.services;
        const totalMisses = misses.addresses + misses.services;
        if (totalHits > 0 || totalMisses > 0) {
            logger.log(
                `[CTX] ${doctorLabel}: addresses hit=${hits.addresses}/miss=${misses.addresses}; services hit=${hits.services}/miss=${misses.services} — ${totalHits} Doctoralia call(s) economizada(s)`,
            );
        }
    }
}
