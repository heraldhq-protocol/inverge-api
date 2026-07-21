import { Module } from '@nestjs/common';
import { FlatFeeController } from './flat-fee.controller';
import { FlatFeeService } from './flat-fee.service';

@Module({
  controllers: [FlatFeeController],
  providers: [FlatFeeService],
  exports: [FlatFeeService],
})
export class FlatFeeModule {}
