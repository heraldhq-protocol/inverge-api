import { ForbiddenException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

const ctxWith = (user: unknown) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;

const guard = (allowlist = '') =>
  new AdminGuard({ get: jest.fn().mockReturnValue(allowlist) } as any);

describe('AdminGuard (FR-901)', () => {
  it('allows a user with the ADMIN role', () => {
    expect(guard().canActivate(ctxWith({ role: 'ADMIN', providerUserId: 'd', email: null }))).toBe(true);
  });

  it('denies an authenticated USER not in the allowlist', () => {
    expect(() =>
      guard().canActivate(ctxWith({ role: 'USER', providerUserId: 'd', email: 'u@x.com' })),
    ).toThrow(ForbiddenException);
  });

  it('allows a USER whose email is allowlisted (case-insensitive)', () => {
    expect(
      guard('Boss@X.com , other@y.com').canActivate(
        ctxWith({ role: 'USER', providerUserId: 'd', email: 'boss@x.com' }),
      ),
    ).toBe(true);
  });

  it('allows a USER whose provider user id is allowlisted', () => {
    expect(
      guard('did:privy:abc').canActivate(
        ctxWith({ role: 'USER', providerUserId: 'did:privy:abc', email: null }),
      ),
    ).toBe(true);
  });

  it('denies when no user is attached (guard misordered)', () => {
    expect(() => guard('x@y.com').canActivate(ctxWith(undefined))).toThrow(ForbiddenException);
  });
});
