import { Injectable, Logger } from '@nestjs/common';

/**
 * WP-06 — Cache TTL em memória para dados ESTÁVEIS da Doctoralia.
 *
 * Camadas (sem sobreposição com o WP-05):
 *   caller → StableDataCache → (MISS) → DocplannerClient → dedup in-flight (WP-05)
 *   → rate limiter → Doctoralia; (HIT) → nenhuma chamada de rede.
 *
 * Dois MISS simultâneos da mesma chave são colapsados pelo dedup do WP-05 no client —
 * este cache NÃO precisa de lógica própria de concorrência.
 *
 * Regras:
 * - Erros do fetch NUNCA ficam cacheados (só sucesso entra no mapa).
 * - Valores retornados são CLONADOS (mutação de um caller não afeta outro).
 * - Chave: `domain|clientId|recurso|facility[|doctor[|address]]` — zero
 *   compartilhamento indevido entre clínicas/credenciais.
 * - Sem persistência: restart começa vazio (comportamento aceito).
 */

/** TTLs padrão por tipo de recurso (constantes nomeadas num único lugar). */
export const STABLE_DATA_TTLS = {
    /** GET /addresses do médico */
    addresses: 20 * 60 * 1000,
    /** GET /services do endereço */
    services: 20 * 60 * 1000,
    /** GET /facilities/{id}/services/catalog */
    facilityServicesCatalog: 2 * 60 * 60 * 1000,
    /** GET /insurance-providers/{id}/plans */
    insurancePlans: 2 * 60 * 60 * 1000,
    /** GET dicionário global de serviços */
    servicesDictionary: 12 * 60 * 60 * 1000,
    /** GET dicionário global de insurance providers */
    insuranceProviders: 12 * 60 * 60 * 1000,
    /** GET /facilities */
    facilities: 2 * 60 * 60 * 1000,
    /** GET /doctors da facility */
    doctors: 30 * 60 * 1000,
} as const;

interface CacheEntry {
    value: any;
    expiresAt: number;
}

@Injectable()
export class StableDataCacheService {
    private readonly logger = new Logger(StableDataCacheService.name);

    /** Cap de entradas: acima disso, evict da mais antiga (ordem de inserção do Map). */
    static readonly MAX_ENTRIES = 2000;
    /** Intervalo mínimo entre sweeps oportunistas de expirados. */
    private static readonly SWEEP_INTERVAL_MS = 60 * 1000;

    private readonly entries = new Map<string, CacheEntry>();
    private lastSweepAt = 0;

    /**
     * Retorna o valor cacheado (clonado) se ainda válido; senão executa `fetchFn`,
     * armazena em caso de sucesso e retorna um clone. Erros propagam SEM cachear.
     *
     * Para leituras que exigem estado fresco (pós-mutação), NÃO use este método —
     * chame o client diretamente (bypass explícito).
     */
    async getOrFetch<T>(key: string, ttlMs: number, fetchFn: () => Promise<T>): Promise<T> {
        this.sweepIfDue();
        const entry = this.entries.get(key);
        if (entry && entry.expiresAt > Date.now()) {
            this.logger.debug(`[STABLE-CACHE] HIT ${key}`);
            return this.clone(entry.value);
        }
        this.logger.debug(`[STABLE-CACHE] MISS ${key}`);
        const value = await fetchFn(); // erro propaga; nada é cacheado
        this.set(key, value, ttlMs);
        return this.clone(value);
    }

    /** Grava um valor com TTL, aplicando o cap de tamanho (evict do mais antigo). */
    set(key: string, value: any, ttlMs: number): void {
        // Re-inserção vai para o fim da ordem do Map (mais recente).
        this.entries.delete(key);
        this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        while (this.entries.size > StableDataCacheService.MAX_ENTRIES) {
            const oldest = this.entries.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    /**
     * Invalida a chave exata E qualquer chave que comece com o prefixo dado.
     * Usar após mutações do próprio sistema (POST/DELETE de service, PATCH de address).
     */
    invalidate(keyOrPrefix: string): void {
        let removed = 0;
        for (const key of [...this.entries.keys()]) {
            if (key === keyOrPrefix || key.startsWith(keyOrPrefix)) {
                this.entries.delete(key);
                removed++;
            }
        }
        if (removed > 0) this.logger.debug(`[STABLE-CACHE] invalidated ${removed} entrada(s) para "${keyOrPrefix}"`);
    }

    /** Remove todas as entradas (uso em testes). */
    clear(): void {
        this.entries.clear();
    }

    /** Quantidade de entradas atualmente no cache (uso em testes/diagnóstico). */
    size(): number {
        return this.entries.size;
    }

    /** Sweep oportunista de expirados (no máximo 1x por SWEEP_INTERVAL_MS). */
    private sweepIfDue(): void {
        const now = Date.now();
        if (now - this.lastSweepAt < StableDataCacheService.SWEEP_INTERVAL_MS) return;
        this.lastSweepAt = now;
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) this.entries.delete(key);
        }
    }

    /**
     * Clone defensivo (mesma disciplina do WP-05): nenhum caller muta os arrays hoje,
     * mas o clone é cinto de segurança barato.
     */
    private clone(value: any): any {
        if (value === null || value === undefined || typeof value !== 'object') return value;
        try {
            return structuredClone(value);
        } catch {
            return JSON.parse(JSON.stringify(value));
        }
    }
}
