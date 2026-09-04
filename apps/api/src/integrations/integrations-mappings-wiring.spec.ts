import { Test } from '@nestjs/testing';
import { IntegrationsModule } from './integrations.module';
import { MappingsModule } from '../mappings/mappings.module';
import { DoctoraliaCatalogService } from '../mappings/doctoralia-catalog.service';
import { TokenRefresherService } from './token-refresher.service';
import { ConfigModule } from '@nestjs/config';

describe('IntegrationsModule + MappingsModule wiring', () => {
    it('compiles without a runtime DI cycle and resolves catalog/token services', async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [ConfigModule.forRoot({ isGlobal: true }), IntegrationsModule, MappingsModule],
        }).compile();

        expect(moduleRef.get(TokenRefresherService)).toBeInstanceOf(TokenRefresherService);
        expect(moduleRef.get(DoctoraliaCatalogService)).toBeInstanceOf(DoctoraliaCatalogService);
        await moduleRef.close();
    });
});