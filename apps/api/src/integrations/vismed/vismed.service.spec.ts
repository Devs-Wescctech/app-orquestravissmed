import { Test, TestingModule } from '@nestjs/testing';
import { VismedService } from './vismed.service';

describe('VismedService', () => {
  let service: VismedService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [VismedService],
    }).compile();

    service = module.get<VismedService>(VismedService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
