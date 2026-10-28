import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { PrismaService } from '../../../prisma/prisma.service';
import { OptionalPrivyAuthGuard } from './optional-privy-auth.guard';
import { PrivyAuthGuard } from './privy-auth.guard';
import type { SessionService } from '../session.service';

interface TestRequest {
  headers: { authorization?: string };
  user?: unknown;
}

const contextFor = (request: TestRequest) =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const sessions = (sub = 'user-1') =>
  ({ verify: jest.fn().mockResolvedValue({ sub }) }) as unknown as SessionService;

describe('PrivyAuthGuard (F-11)', () => {
  it('attaches an active user to the request', async () => {
    const user = { id: 'user-1', bannedAt: null };
    const guard = new PrivyAuthGuard(sessions(), {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
    } as unknown as PrismaService);
    const request = { headers: { authorization: 'Bearer session' } };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request).toHaveProperty('user', user);
  });

  it('rejects a banned user with 403 and never attaches them', async () => {
    const guard = new PrivyAuthGuard(sessions(), {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'user-1', bannedAt: new Date() }),
      },
    } as unknown as PrismaService);
    const request: TestRequest = {
      headers: { authorization: 'Bearer session' },
    };

    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(request.user).toBeUndefined();
  });

  it('rejects a token whose user no longer exists', async () => {
    const guard = new PrivyAuthGuard(sessions(), {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService);

    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: 'Bearer session' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a request without a bearer token', async () => {
    const guard = new PrivyAuthGuard(sessions(), {
      user: { findUnique: jest.fn() },
    } as unknown as PrismaService);

    await expect(guard.canActivate(contextFor({ headers: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('OptionalPrivyAuthGuard (F-11)', () => {
  it('treats a banned user as anonymous rather than authenticated', async () => {
    const guard = new OptionalPrivyAuthGuard(sessions(), {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'user-1', bannedAt: new Date() }),
      },
    } as unknown as PrismaService);
    const request: TestRequest = {
      headers: { authorization: 'Bearer session' },
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('still attaches an active user', async () => {
    const user = { id: 'user-1', bannedAt: null };
    const guard = new OptionalPrivyAuthGuard(sessions(), {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
    } as unknown as PrismaService);
    const request: TestRequest = {
      headers: { authorization: 'Bearer session' },
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toBe(user);
  });
});
