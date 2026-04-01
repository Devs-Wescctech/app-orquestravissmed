import { Module } from '@nestjs/common';
import { MappingsService } from './mappings.service';
import { MappingsController } from './mappings.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { MatchingEngineService } from './matching-engine.service';

@Module({
    imports: [PrismaModule],
    controllers: [MappingsController],
    providers: [MappingsService, MatchingEngineService],
    exports: [MappingsService, MatchingEngineService]
})
export class MappingsModule { }
