import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { AdminAuthService } from './admin-auth.service';
import type { AdminSessionContext } from './admin-auth.types';
import {
  AdminSessionGuard,
  readAdminBearerToken,
  requireAdminSession,
} from './admin-session.guard';

function httpContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('readAdminBearerToken', () => {
  it('reads a bearer token case-insensitively', () => {
    expect(readAdminBearerToken('bearer inv_adm_abc')).toBe('inv_adm_abc');
  });

  it('returns null for a missing or non-bearer header', () => {
    expect(readAdminBearerToken(undefined)).toBeNull();
    expect(readAdminBearerToken('Basic abc')).toBeNull();
  });
});

describe('AdminSessionGuard', () => {
  it('attaches the resolved session to the request', async () => {
    // given
    const session: AdminSessionContext = {
      sessionId: 'session_1',
      expiresAt: new Date(Date.now() + 60_000),
      admin: {
        id: 'admin_1',
        email: 'operator@inverge.example',
        displayName: 'Operator',
        role: 'OPERATOR',
        capabilities: ['campaigns.read'],
      },
    };
    const resolveSession = jest.fn().mockResolvedValue(session);
    const guard = new AdminSessionGuard({
      resolveSession,
    } as unknown as AdminAuthService);
    const request = {
      headers: { authorization: 'Bearer inv_adm_abc' },
      ip: '10.0.0.1',
      get: () => 'jest',
    };

    // when
    const allowed = await guard.canActivate(httpContext(request));

    // then
    expect(allowed).toBe(true);
    expect(request).toMatchObject({ adminSession: session });
    expect(resolveSession).toHaveBeenCalledWith('inv_adm_abc', {
      ip: '10.0.0.1',
      userAgent: 'jest',
    });
  });

  it('rejects a request without a bearer token', async () => {
    // given
    const guard = new AdminSessionGuard({
      resolveSession: jest.fn(),
    } as unknown as AdminAuthService);

    // when
    const attempt = guard.canActivate(
      httpContext({ headers: {}, get: () => undefined }),
    );

    // then
    await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses to return a session that was never attached', () => {
    expect(() => requireAdminSession({} as never)).toThrow(
      UnauthorizedException,
    );
  });
});
