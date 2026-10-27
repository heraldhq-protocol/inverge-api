import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
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
import { AdminGuard } from '../auth/guards/admin.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { AnalyticsAccessService } from './analytics-access.service';
import { AnalyticsQueryService } from './analytics-query.service';
import { AnalyticsReadGuard } from './analytics-read.guard';
import {
  AdminAnalyticsAccessRequestDto,
  AdminAnalyticsAccessRequestListDto,
  DecideAnalyticsAccessRequestDto,
  ListAnalyticsAccessRequestsQueryDto,
} from './dto/analytics-access.dto';
import {
  AdminAnalyticsOverviewDto,
  AnalyticsRangeQueryDto,
  CampaignAnalyticsFunnelDto,
  CampaignAnalyticsSummaryDto,
  IdeaAnalyticsAcquisitionDto,
  IdeaAnalyticsGeographyDto,
  IdeaAnalyticsSummaryDto,
  IdeaAnalyticsTimeseriesDto,
  IdeaAnalyticsValidationDto,
} from './dto/analytics-read.dto';

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('ideas')
@UseGuards(AnalyticsReadGuard, PrivyAuthGuard)
export class IdeaAnalyticsController {
  constructor(private readonly analytics: AnalyticsQueryService) {}

  @Get(':id/analytics/summary')
  @RateLimit('analytics_read')
  @ApiOperation({ summary: 'Idea reach and current validation totals' })
  @ApiOkResponse({ type: IdeaAnalyticsSummaryDto })
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<IdeaAnalyticsSummaryDto> {
    return this.analytics.getIdeaSummary(user, id, query);
  }

  @Get(':id/analytics/timeseries')
  @RateLimit('analytics_read')
  @ApiOperation({ summary: 'Idea reach and signal series, UTC buckets' })
  @ApiOkResponse({ type: IdeaAnalyticsTimeseriesDto })
  timeseries(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<IdeaAnalyticsTimeseriesDto> {
    return this.analytics.getIdeaTimeseries(user, id, query);
  }

  @Get(':id/analytics/validation')
  @RateLimit('analytics_read')
  @ApiOperation({ summary: 'Idea validation totals and premium conversion rates' })
  @ApiOkResponse({ type: IdeaAnalyticsValidationDto })
  validation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<IdeaAnalyticsValidationDto> {
    return this.analytics.getIdeaValidation(user, id, query);
  }

  @Get(':id/analytics/acquisition')
  @RateLimit('analytics_premium')
  @ApiOperation({ summary: 'Idea view sources (premium)' })
  @ApiOkResponse({ type: IdeaAnalyticsAcquisitionDto })
  acquisition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<IdeaAnalyticsAcquisitionDto> {
    return this.analytics.getIdeaAcquisition(user, id, query);
  }

  @Get(':id/analytics/geography')
  @RateLimit('analytics_premium')
  @ApiOperation({ summary: 'Idea views by country (premium)' })
  @ApiOkResponse({ type: IdeaAnalyticsGeographyDto })
  geography(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<IdeaAnalyticsGeographyDto> {
    return this.analytics.getIdeaGeography(user, id, query);
  }
}

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('campaigns')
@UseGuards(AnalyticsReadGuard, PrivyAuthGuard)
export class CampaignAnalyticsController {
  constructor(private readonly analytics: AnalyticsQueryService) {}

  @Get(':id/analytics/summary')
  @RateLimit('analytics_read')
  @ApiOperation({ summary: 'Campaign reach, funnel and confirmed backing' })
  @ApiOkResponse({ type: CampaignAnalyticsSummaryDto })
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<CampaignAnalyticsSummaryDto> {
    return this.analytics.getCampaignSummary(user, id, query);
  }

  @Get(':id/analytics/funnel')
  @RateLimit('analytics_premium')
  @ApiOperation({ summary: 'Campaign creator-flow funnel (premium)' })
  @ApiOkResponse({ type: CampaignAnalyticsFunnelDto })
  funnel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<CampaignAnalyticsFunnelDto> {
    return this.analytics.getCampaignFunnel(user, id, query);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/analytics')
@UseGuards(AnalyticsReadGuard, PrivyAuthGuard, AdminGuard)
export class AdminAnalyticsController {
  constructor(
    private readonly analytics: AnalyticsQueryService,
    private readonly access: AnalyticsAccessService,
  ) {}

  @Get('overview')
  @RateLimit('analytics_admin')
  @ApiOperation({ summary: 'Platform analytics overview' })
  @ApiOkResponse({ type: AdminAnalyticsOverviewDto })
  overview(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<AdminAnalyticsOverviewDto> {
    return this.analytics.getAdminOverview(user, query);
  }

  @Get('access-requests')
  @RateLimit('analytics_admin')
  @ApiOperation({ summary: 'List premium analytics access requests' })
  @ApiOkResponse({ type: AdminAnalyticsAccessRequestListDto })
  listAccessRequests(
    @Query() query: ListAnalyticsAccessRequestsQueryDto,
  ): Promise<AdminAnalyticsAccessRequestListDto> {
    return this.access.listRequests(query);
  }

  @Patch('access-requests/:id')
  @RateLimit('analytics_admin')
  @ApiOperation({ summary: 'Approve or reject a premium analytics request' })
  @ApiOkResponse({ type: AdminAnalyticsAccessRequestDto })
  decideAccessRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecideAnalyticsAccessRequestDto,
  ): Promise<AdminAnalyticsAccessRequestDto> {
    return this.access.decide(user.id, id, dto);
  }
}
