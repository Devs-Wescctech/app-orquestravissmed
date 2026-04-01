import { Test, TestingModule } from '@nestjs/testing';
import { VismedSyncService } from './vismed-sync.service';

describe('VismedSyncService', () => {
  let service: VismedSyncService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [VismedSyncService],
    }).compile();

    service = module.get<VismedSyncService>(VismedSyncService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
