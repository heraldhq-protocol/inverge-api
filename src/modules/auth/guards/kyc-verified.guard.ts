import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

// FR-103: creator actions (campaign submission, from Phase 1) require verified KYC.
// Defined now, applied to the routes that gate on it.
@Injectable()
export class KycVerifiedGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (!req.user || req.user.kycStatus !== 'VERIFIED') {
      throw new ForbiddenException('KYC verification required');
    }
    return true;
  }
}
