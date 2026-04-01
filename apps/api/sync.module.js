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

@Module({
    imports: [
        PrismaModule,
        IntegrationsModule,
        AuthModule,
        BullModule.registerQueue({
            name: 'vismed-sync',
        }),
    ],
    controllers: [SyncController],
    providers: [SyncService, SyncProcessor, VismedSyncProcessor, VismedService],
    exports: [SyncService],
})
export class SyncModule { }
