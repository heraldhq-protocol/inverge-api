import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FlatFeeModule } from '../flat-fee/flat-fee.module';
import { BoostsController } from './boosts.controller';
import { BoostsService } from './boosts.service';

// Depends on FlatFeeModule (createCharge) and listens for its success event.
// One-directional: FlatFeeModule has no dependency back on Boosts.
@Module({
  imports: [AuthModule, FlatFeeModule],
  controllers: [BoostsController],
  providers: [BoostsService],
})
export class BoostsModule {}
