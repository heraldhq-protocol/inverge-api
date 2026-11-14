import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthService } from './admin-auth.service';
import type { AdminSessionContext } from './admin-auth.types';

export interface AdminAuthenticatedRequest extends Request {
  adminSession?: AdminSessionContext;
}

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * Resolves `Authorization: Bearer inv_adm_...` into an admin session.
 *
 * This is the only place the raw token is read. Handlers receive the resolved
 * identity, so a missing or stale session can never be mistaken for a valid one
 * after a role change or suspension (the admin row is re-read on every request).
 */
@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(private readonly adminAuth: AdminAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AdminAuthenticatedRequest>();
    const token = readAdminBearerToken(request.headers.authorization);
    if (!token) throw invalidSession();

    request.adminSession = await this.adminAuth.resolveSession(token, {
      ip: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
    return true;
  }
}

export function readAdminBearerToken(
  authorization: string | undefined,
): string | null {
  const match = authorization?.match(BEARER);
  return match?.[1]?.trim() || null;
}

export function requireAdminSession(
  request: AdminAuthenticatedRequest,
): AdminSessionContext {
  if (!request.adminSession) throw invalidSession();
  return request.adminSession;
}

function invalidSession(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'SESSION_EXPIRED',
    message: 'Admin authentication required.',
  });
}
