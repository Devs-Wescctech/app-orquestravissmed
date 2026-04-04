import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { BookingSyncService } from './booking-sync.service';
import { QueueService } from './queue.service';
import { RateLimiterService } from './rate-limiter.service';
import { WebhookController, BookingSyncController } from './webhook.controller';

@Module({
    imports: [PrismaModule, IntegrationsModule],
    controllers: [WebhookController, BookingSyncController],
    providers: [BookingSyncService, QueueService, RateLimiterService],
    exports: [BookingSyncService, QueueService],
})
export class BookingsModule {}
