import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { SessionService } from '../session.service';

// Guards routes behind the Inverge session (FR-101, NFR-03). The class name is
// historical: sessions have been provider-neutral since the Web3Auth migration.
@Injectable()
export class PrivyAuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const { sub } = await this.sessions.verify(header.slice(7));
    const user = await this.prisma.user.findUnique({ where: { id: sub } });
    if (!user) throw new UnauthorizedException('User not found');
    // FR-216 / F-11: a ban must end the session immediately. Rejecting here
    // covers every protected route, not only the sign-in exchange.
    if (user.bannedAt) throw new ForbiddenException('Account is not permitted');
    req.user = user;
    return true;
  }
}
