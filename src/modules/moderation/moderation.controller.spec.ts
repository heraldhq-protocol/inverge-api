import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminGuard } from '../auth/guards/admin.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { ModerationController } from './moderation.controller';

describe('ModerationController authorization', () => {
  it('requires an authenticated admin', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ModerationController,
    ) as unknown[];

    // Losing AdminGuard turns a vendor-cost, arbitrary-content endpoint into a
    // signed-in-user endpoint. Assert the guard order, not just "some guard".
    expect(guards).toEqual([PrivyAuthGuard, AdminGuard]);
  });
});
