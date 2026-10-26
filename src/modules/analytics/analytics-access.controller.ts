import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { AnalyticsAccessService } from './analytics-access.service';
import { AnalyticsReadGuard } from './analytics-read.guard';
import { AnalyticsAccessDto } from './dto/analytics-access.dto';

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('analytics')
@UseGuards(AnalyticsReadGuard, PrivyAuthGuard)
export class AnalyticsAccessController {
  constructor(private readonly access: AnalyticsAccessService) {}

  @Get('access')
  @RateLimit('analytics_read')
  @ApiOperation({ summary: 'Premium analytics access for the signed-in account' })
  @ApiOkResponse({ type: AnalyticsAccessDto })
  getAccess(@CurrentUser() user: AuthenticatedUser): Promise<AnalyticsAccessDto> {
    return this.access.getAccess(user);
  }

  @Post('access-requests')
  @HttpCode(200)
  @RateLimit('analytics_request')
  @ApiOperation({
    summary: 'Request premium analytics access',
    description:
      'Idempotent. A pending request or an active approval is returned unchanged; a rejected or expired grant becomes pending again.',
  })
  @ApiOkResponse({ type: AnalyticsAccessDto })
  requestAccess(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AnalyticsAccessDto> {
    return this.access.requestAccess(user);
  }
}
