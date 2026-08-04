import { Module, forwardRef } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AdminGuard } from './guards/admin.guard';
import { KycVerifiedGuard } from './guards/kyc-verified.guard';
import { PrivyAuthGuard } from './guards/privy-auth.guard';
import { OptionalPrivyAuthGuard } from './guards/optional-privy-auth.guard';
import { SessionService } from './session.service';
import { ModerationModule } from '../moderation/moderation.module';

// Exports guards + SessionService so other feature modules can protect their routes.
@Module({
  imports: [forwardRef(() => ModerationModule)],
  controllers: [AuthController],
  providers: [AuthService, SessionService, PrivyAuthGuard, OptionalPrivyAuthGuard, KycVerifiedGuard, AdminGuard],
  exports: [AuthService, SessionService, PrivyAuthGuard, OptionalPrivyAuthGuard, KycVerifiedGuard, AdminGuard],
})
export class AuthModule {}

