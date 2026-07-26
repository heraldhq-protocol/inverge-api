import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AdminGuard } from './guards/admin.guard';
import { KycVerifiedGuard } from './guards/kyc-verified.guard';
import { PrivyAuthGuard } from './guards/privy-auth.guard';
import { SessionService } from './session.service';

// Exports guards + SessionService so other feature modules can protect their routes.
@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionService, PrivyAuthGuard, KycVerifiedGuard, AdminGuard],
  exports: [AuthService, SessionService, PrivyAuthGuard, KycVerifiedGuard, AdminGuard],
})
export class AuthModule {}
