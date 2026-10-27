import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.validation';
import type { User } from '../../../generated/prisma/client';

/**
 * Least-privilege gate for the verification review surface (FR-901 + compliance
 * separation). A COMPLIANCE_REVIEWER may read cases and record a risk-review decision;
 * they cannot administer campaigns or platform parameters, which still require AdminGuard.
 * Runs AFTER PrivyAuthGuard.
 */
@Injectable()
export class ComplianceReviewerGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const user: User | undefined = req.user;
    if (!user) {
      throw new ForbiddenException('Verification review requires authentication');
    }
    if (user.role === 'ADMIN' || user.role === 'COMPLIANCE_REVIEWER') return true;
    if (user.role === 'USER' && this.isAllowlisted(user)) return true;
    throw new ForbiddenException('Compliance reviewer access required');
  }

  private isAllowlisted(user: User): boolean {
    const raw = this.config.get('ADMIN_ALLOWLIST', { infer: true }) ?? '';
    const allow = new Set(
      raw
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    );
    if (allow.size === 0) return false;
    const email = user.email?.toLowerCase();
    return (
      (email !== undefined && allow.has(email)) ||
      allow.has(user.providerUserId.toLowerCase())
    );
  }
}
