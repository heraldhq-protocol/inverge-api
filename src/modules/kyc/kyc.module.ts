import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KycController } from './kyc.controller';
import { KybController } from './kyb.controller';
import { KycService } from './kyc.service';

@Module({
  imports: [AuthModule],
  controllers: [KycController, KybController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
