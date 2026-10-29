import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { EmailVerifiedGuard } from './email-verified.guard';

function contextFor(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('EmailVerifiedGuard', () => {
  const guard = new EmailVerifiedGuard();

  it('accepts an account with a stored address and verification timestamp', () => {
    // #given a verified user row
    const ctx = contextFor({
      email: 'ada@example.com',
      emailVerifiedAt: new Date(),
    });

    // #then the guarded action proceeds
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects a row whose address has never been proven', () => {
    // #given an address with no verification timestamp
    const ctx = contextFor({
      email: 'ada@example.com',
      emailVerifiedAt: null,
    });

    // #then the action is forbidden with a stable code
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    try {
      guard.canActivate(ctx);
    } catch (error) {
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'EMAIL_VERIFICATION_REQUIRED',
      });
    }
  });

  it('rejects an account with no address at all', () => {
    // #given a row with a null address
    const ctx = contextFor({ email: null, emailVerifiedAt: null });

    // #then the gate is closed
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
