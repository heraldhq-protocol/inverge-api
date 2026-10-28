import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.validation';
import type { User } from '../../../generated/prisma/client';

// FR-901: gates the /admin surface. Runs AFTER PrivyAuthGuard (which attaches req.user).
// Grants when the user's DB role is ADMIN, or when they're in the ADMIN_ALLOWLIST
// break-glass set (emails / provider user ids) that bootstraps the very first admin.
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const user: User | undefined = req.user;
    if (!user) {
      throw new ForbiddenException('Admin access requires authentication');
    }
    // Defence in depth: this guard is normally chained after PrivyAuthGuard, but
    // must never authorise a banned account if the chain changes.
    if (user.bannedAt) throw new ForbiddenException('Admin access denied');
    if (user.role === 'ADMIN' || this.isAllowlisted(user)) return true;
    throw new ForbiddenException('Admin access required');
  }

  private isAllowlisted(user: User): boolean {
    const raw = this.config.get('ADMIN_ALLOWLIST', { infer: true }) ?? '';
    const allow = new Set(
      raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
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
