import { Body, Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { PlatformParamsService } from '../platform-params/platform-params.service';
import { UpdateParamsDto } from './dto/update-params.dto';
import { BoostPricesDto } from './dto/boost-prices.dto';
import { AuditQueryDto } from './dto/audit-query.dto';

const BOOST_KEYS = {
  basicPriceUSD: 'boost.basic.priceUSD',
  featuredPriceUSD: 'boost.featured.priceUSD',
  basicDurationDays: 'boost.basic.durationDays',
  featuredDurationDays: 'boost.featured.durationDays',
} as const;

// FR-901/904. NOTE: guarded by session auth; admin RBAC (role/allowlist) is a
// pre-production TODO — every param change is attributed to the acting user and audited.
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(PrivyAuthGuard)
export class AdminController {
  constructor(private readonly params: PlatformParamsService) {}

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
}
