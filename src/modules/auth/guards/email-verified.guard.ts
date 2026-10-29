import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { User } from '../../../generated/prisma/client';

/**
 * Server-side gate for actions that require a verified account email.
 *
 * Chain after PrivyAuthGuard, which loads the current user row on every request,
 * so a verification completed in another tab takes effect immediately. Idea
 * support and pre-pledges deliberately do not use this guard.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const user: User | undefined = req.user;
    if (!user?.email || !user.emailVerifiedAt) {
      throw new ForbiddenException({
        code: 'EMAIL_VERIFICATION_REQUIRED',
        message: 'Verify your email address to continue.',
      });
    }
    return true;
  }
}
