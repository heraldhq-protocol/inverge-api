import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FeePayerService } from './fee-payer.service';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [AuthModule],
  controllers: [WalletsController],
  providers: [WalletsService, FeePayerService],
  exports: [WalletsService, FeePayerService],
})
export class WalletsModule {}
