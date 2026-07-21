import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { KycVerifiedGuard } from './guards/kyc-verified.guard';
import { PrivyAuthGuard } from './guards/privy-auth.guard';
import { SessionService } from './session.service';

// Exports guards + SessionService so other feature modules can protect their routes.
@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionService, PrivyAuthGuard, KycVerifiedGuard],
  exports: [AuthService, SessionService, PrivyAuthGuard, KycVerifiedGuard],
})
export class AuthModule {}
