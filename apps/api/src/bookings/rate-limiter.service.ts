import { Injectable, Logger } from '@nestjs/common';

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

        while (true) {
            this.refill(bucket);

            if (bucket.tokens >= cost) {
                bucket.tokens -= cost;
                return;
            }

            const waitTime = ((cost - bucket.tokens) / bucket.refillRate) * 1000;
            this.logger.debug(`[RATE-LIMIT] ${provider}: waiting ${Math.round(waitTime)}ms (tokens: ${bucket.tokens.toFixed(1)}/${bucket.maxTokens})`);
            await new Promise(r => setTimeout(r, Math.min(waitTime + 50, 5000)));
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
