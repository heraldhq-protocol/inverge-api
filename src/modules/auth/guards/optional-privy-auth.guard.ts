import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { SessionService } from '../session.service';

// Like PrivyAuthGuard, but never rejects: it attaches req.user when a valid session token
// is present and otherwise lets the request through anonymously. The discovery feed uses
// this so it serves a personalised feed to signed-in users and a global-popular feed to
// everyone else — a login wall on discovery would defeat the point.
@Injectable()
export class OptionalPrivyAuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        const { sub } = await this.sessions.verify(header.slice(7));
        const user = await this.prisma.user.findUnique({ where: { id: sub } });
        // A banned account is anonymous here, never an authenticated actor. Routes
        // that need identity also run the strict guard, which returns 403.
        if (user && !user.bannedAt) req.user = user;
      } catch {
        // Invalid/expired token → treat as anonymous rather than 401.
      }
    }
    return true;
  }
}
