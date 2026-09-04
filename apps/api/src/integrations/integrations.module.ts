import { Module, Global } from '@nestjs/common';
import { DocplannerService } from './docplanner.service';
import { TokenRefresherService } from './token-refresher.service';
import { StableDataCacheService } from './stable-data-cache.service';
import { VismedModule } from './vismed/vismed.module';
import { MappingsModule } from '../mappings/mappings.module';

@Global()
@Module({
    providers: [DocplannerService, TokenRefresherService, StableDataCacheService],
    exports: [DocplannerService, StableDataCacheService, VismedModule],
    imports: [VismedModule, MappingsModule],
})
export class IntegrationsModule { }
