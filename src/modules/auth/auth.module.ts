import { Module, forwardRef } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailVerificationController } from './email/email-verification.controller';
import { EmailVerificationService } from './email/email-verification.service';
import { AdminGuard } from './guards/admin.guard';
import { EmailVerifiedGuard } from './guards/email-verified.guard';
import { KycVerifiedGuard } from './guards/kyc-verified.guard';
import { PrivyAuthGuard } from './guards/privy-auth.guard';
import { OptionalPrivyAuthGuard } from './guards/optional-privy-auth.guard';
import { SessionService } from './session.service';
import { ModerationModule } from '../moderation/moderation.module';

// Exports guards + SessionService so other feature modules can protect their routes.
@Module({
  imports: [forwardRef(() => ModerationModule)],
  controllers: [AuthController, EmailVerificationController],
  providers: [
    AuthService,
    EmailVerificationService,
    SessionService,
    PrivyAuthGuard,
    OptionalPrivyAuthGuard,
    EmailVerifiedGuard,
    KycVerifiedGuard,
    AdminGuard,
  ],
  exports: [
    AuthService,
    EmailVerificationService,
    SessionService,
    PrivyAuthGuard,
    OptionalPrivyAuthGuard,
    EmailVerifiedGuard,
    KycVerifiedGuard,
    AdminGuard,
  ],
})
export class AuthModule {}
