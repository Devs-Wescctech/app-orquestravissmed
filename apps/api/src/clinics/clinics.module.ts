import { Module } from '@nestjs/common';
import { ClinicsService } from './clinics.service';
import { ClinicsController } from './clinics.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
    imports: [PrismaModule],
    controllers: [ClinicsController],
    providers: [ClinicsService],
    exports: [ClinicsService],
})
export class ClinicsModule { }
