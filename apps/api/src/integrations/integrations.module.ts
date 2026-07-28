import { Module, Global } from '@nestjs/common';
import { DocplannerService } from './docplanner.service';
import { TokenRefresherService } from './token-refresher.service';
import { VismedModule } from './vismed/vismed.module';

@Global()
@Module({
    providers: [DocplannerService, TokenRefresherService],
    exports: [DocplannerService, VismedModule],
    imports: [VismedModule],
})
export class IntegrationsModule { }
