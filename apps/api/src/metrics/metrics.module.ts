import { Module, Global } from '@nestjs/common';
import { DoctoraliaMetricsService } from './doctoralia-metrics.service';
import { MetricsController } from './metrics.controller';

@Global()
@Module({
    controllers: [MetricsController],
    providers: [DoctoraliaMetricsService],
    exports: [DoctoraliaMetricsService],
})
export class MetricsModule {}
