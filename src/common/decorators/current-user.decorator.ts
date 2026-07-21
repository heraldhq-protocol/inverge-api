import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { User } from '../../generated/prisma/client';

export type AuthenticatedUser = User;

/** Resolves the request-bound user attached by PrivyAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const req = ctx.switchToHttp().getRequest();
    return req.user;
  },
);
