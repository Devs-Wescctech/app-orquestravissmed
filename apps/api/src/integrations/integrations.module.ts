import { Module, Global } from '@nestjs/common';
import { DocplannerService } from './docplanner.service';
import { VismedModule } from './vismed/vismed.module';

@Global()
@Module({
    providers: [DocplannerService],
    exports: [DocplannerService, VismedModule],
    imports: [VismedModule],
})
export class IntegrationsModule { }
