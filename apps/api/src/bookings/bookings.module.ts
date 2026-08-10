import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { MappingsModule } from '../mappings/mappings.module';
import { BookingSyncService } from './booking-sync.service';
import { BookingSafetySweepService } from './booking-safety-sweep.service';
import { QueueService } from './queue.service';
import { RateLimiterService } from './rate-limiter.service';
import { ClinicConcurrencyGuard } from './clinic-concurrency-guard';
import { WebhookController, BookingSyncController } from './webhook.controller';

@Module({
    imports: [PrismaModule, IntegrationsModule, MappingsModule],
    controllers: [WebhookController, BookingSyncController],
    providers: [BookingSyncService, BookingSafetySweepService, QueueService, RateLimiterService, ClinicConcurrencyGuard],
    exports: [BookingSyncService, QueueService, ClinicConcurrencyGuard],
})
export class BookingsModule {}
