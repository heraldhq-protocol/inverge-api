import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminGuard } from '../auth/guards/admin.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { PlatformParamsService } from '../platform-params/platform-params.service';
import { AuditQueryDto } from './dto/audit-query.dto';
import { BoostPricesDto } from './dto/boost-prices.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateParamsDto } from './dto/update-params.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';

const BOOST_KEYS = {
  basicPriceUSD: 'boost.basic.priceUSD',
  featuredPriceUSD: 'boost.featured.priceUSD',
  basicDurationDays: 'boost.basic.durationDays',
  featuredDurationDays: 'boost.featured.durationDays',
} as const;

// Admin projection — never leak KYC provider refs or wallet internals.
const USER_SELECT = {
  id: true,
  email: true,
  privyDid: true,
  role: true,
  kycStatus: true,
  bannedAt: true,
  createdAt: true,
} as const;

// FR-901: the /admin surface. PrivyAuthGuard authenticates + attaches req.user; AdminGuard
// then requires role ADMIN (or the ADMIN_ALLOWLIST break-glass set). Every mutation is
// attributed to the acting user and audited.
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(PrivyAuthGuard, AdminGuard)
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly params: PlatformParamsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('params')
  getParams() {
    return this.params.getAll();
  }

  @Patch('params')
  async patchParams(@Body() dto: UpdateParamsDto, @CurrentUser() user: AuthenticatedUser) {
    for (const [key, value] of Object.entries(dto.params)) {
      await this.params.set(key, value, user.id);
    }
    return this.params.getAll();
  }

  // FR-904: change history (who / when / old -> new), newest first.
  @Get('params/audit')
  @ApiOperation({ summary: 'Audit log of platform-param changes' })
  audit(@Query() q: AuditQueryDto) {
    return this.params.auditLog(q);
  }

  // FR-206/904: dedicated, typed Basic/Featured boost-price config.
  @Get('boost-prices')
  async getBoostPrices() {
    return {
      basic: {
        priceUSD: await this.params.getNumber(BOOST_KEYS.basicPriceUSD, 5),
        durationDays: await this.params.getNumber(BOOST_KEYS.basicDurationDays, 7),
      },
      featured: {
        priceUSD: await this.params.getNumber(BOOST_KEYS.featuredPriceUSD, 20),
        durationDays: await this.params.getNumber(BOOST_KEYS.featuredDurationDays, 30),
      },
    };
  }

  @Patch('boost-prices')
  @ApiOperation({ summary: 'Configure Basic/Featured boost prices + durations (audited)' })
  async setBoostPrices(@Body() dto: BoostPricesDto, @CurrentUser() user: AuthenticatedUser) {
    for (const [field, key] of Object.entries(BOOST_KEYS) as [keyof BoostPricesDto, string][]) {
      const value = dto[field];
      if (value !== undefined) await this.params.set(key, value, user.id);
    }
    return this.getBoostPrices();
  }

  // FR-901: list users (search by email / Privy DID, filter by role) to manage access.
  @Get('users')
  @ApiOperation({ summary: 'List users (searchable) for role management' })
  listUsers(@Query() q: ListUsersQueryDto) {
    const query = q.query?.trim();
    return this.prisma.user.findMany({
      where: {
        ...(q.role ? { role: q.role } : {}),
        ...(query
          ? {
              OR: [
                { email: { contains: query, mode: 'insensitive' } },
                { privyDid: { contains: query, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: USER_SELECT,
      orderBy: { createdAt: 'desc' },
      take: Math.min(q.limit ?? 50, 200),
      skip: q.offset ?? 0,
    });
  }

  // FR-901: grant/revoke admin. Self-demotion is blocked so an admin can't lock themselves
  // out (recovery is via the ADMIN_ALLOWLIST env break-glass).
  @Patch('users/:id/role')
  @ApiOperation({ summary: 'Grant or revoke a user admin role' })
  async setUserRole(
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (id === actor.id && dto.role !== 'ADMIN') {
      throw new BadRequestException('You cannot revoke your own admin role');
    }
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User not found');

    if (target.role !== dto.role) {
      await this.prisma.user.update({ where: { id }, data: { role: dto.role } });
      this.logger.warn(
        `role change: user=${id} ${target.role} -> ${dto.role} by=${actor.id}`,
      );
    }
    return this.prisma.user.findUnique({ where: { id }, select: USER_SELECT });
  }
}
