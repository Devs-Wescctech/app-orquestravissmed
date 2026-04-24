import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncProcessor } from './sync.processor';
import { SyncController } from './sync.controller';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AuthModule } from '../auth/auth.module';
import { VismedSyncProcessor } from './vismed-sync/vismed-sync.processor';
import { VismedService } from '../integrations/vismed/vismed.service';
import { MappingsModule } from '../mappings/mappings.module';
import { PushSyncService } from './push-sync.service';
import { SlotSyncService } from './slot-sync.service';
import { SyncSchedulerService } from './sync-scheduler.service';

@Module({
    imports: [
        PrismaModule,
        IntegrationsModule,
        MappingsModule,
        AuthModule,
        BullModule.registerQueue({
            name: 'vismed-sync',
        }),
        BullModule.registerQueue({
            name: 'sync-queue',
        }),
    ],
    controllers: [SyncController],
    providers: [SyncService, SyncProcessor, VismedSyncProcessor, VismedService, PushSyncService, SlotSyncService, SyncSchedulerService],
    exports: [SyncService, SlotSyncService],
})
export class SyncModule { }
