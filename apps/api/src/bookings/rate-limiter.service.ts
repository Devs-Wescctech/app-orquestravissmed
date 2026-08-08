import { Injectable, Logger } from '@nestjs/common';
import { getDoctoraliaMetricsService } from '../metrics/doctoralia-metrics.service';

interface TokenBucket {
    tokens: number;
    maxTokens: number;
    refillRate: number;
    lastRefill: number;
}

@Injectable()
export class RateLimiterService {
    private readonly logger = new Logger(RateLimiterService.name);
    private buckets = new Map<string, TokenBucket>();

    private readonly configs: Record<string, { maxTokens: number; refillRate: number }> = {
        doctoralia: { maxTokens: 30, refillRate: 10 },
        vismed: { maxTokens: 20, refillRate: 8 },
        default: { maxTokens: 15, refillRate: 5 },
    };

    private getBucket(provider: string): TokenBucket {
        if (!this.buckets.has(provider)) {
            const config = this.configs[provider] || this.configs.default;
            this.buckets.set(provider, {
                tokens: config.maxTokens,
                maxTokens: config.maxTokens,
                refillRate: config.refillRate,
                lastRefill: Date.now(),
            });
        }
        return this.buckets.get(provider)!;
    }

    private refill(bucket: TokenBucket) {
        const now = Date.now();
        const elapsed = (now - bucket.lastRefill) / 1000;
        bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRate);
        bucket.lastRefill = now;
    }

    async acquire(provider: string, cost: number = 1): Promise<void> {
        const bucket = this.getBucket(provider);
        const acquireStartAt = Date.now();

        while (true) {
            this.refill(bucket);

            if (bucket.tokens >= cost) {
                const tokensBefore = bucket.tokens;
                bucket.tokens -= cost;
                // WP-01: registra aquisição imediata (sem espera)
                try {
                    const metrics = getDoctoraliaMetricsService();
                    if (metrics) {
                        metrics.recordRateLimiter({
                            provider,
                            tokensAvailableBefore: tokensBefore,
                            tokensAvailableAfter: bucket.tokens,
                            waitMsExpected: 0,
                            waitMsActual: Date.now() - acquireStartAt,
                            blocked: false,
                            recordedAt: Date.now(),
                        });
                    }
                } catch (_e) { /* fail-safe */ }
                return;
            }

            const waitTime = ((cost - bucket.tokens) / bucket.refillRate) * 1000;
            const tokensBefore = bucket.tokens;
            this.logger.debug(`[RATE-LIMIT] ${provider}: waiting ${Math.round(waitTime)}ms (tokens: ${bucket.tokens.toFixed(1)}/${bucket.maxTokens})`);
            await new Promise(r => setTimeout(r, Math.min(waitTime + 50, 5000)));
            // WP-01: registra espera no token bucket
            try {
                const metrics = getDoctoraliaMetricsService();
                if (metrics) {
                    metrics.recordRateLimiter({
                        provider,
                        tokensAvailableBefore: tokensBefore,
                        tokensAvailableAfter: Math.min(bucket.maxTokens, tokensBefore + (waitTime / 1000) * bucket.refillRate),
                        waitMsExpected: waitTime,
                        waitMsActual: Date.now() - acquireStartAt,
                        blocked: true,
                        recordedAt: Date.now(),
                    });
                }
            } catch (_e) { /* fail-safe */ }
        }
    }

    getStats() {
        const stats: Record<string, { tokens: number; maxTokens: number }> = {};
        this.buckets.forEach((bucket, provider) => {
            this.refill(bucket);
            stats[provider] = {
                tokens: Math.round(bucket.tokens * 10) / 10,
                maxTokens: bucket.maxTokens,
            };
        });
        return stats;
    }
}
