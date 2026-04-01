import { Module } from '@nestjs/common';
import { VismedService } from './vismed.service';

@Module({
  providers: [VismedService],
  exports: [VismedService]
})
export class VismedModule {}
