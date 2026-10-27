import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '../../common/cache/cache.service';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Env } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ANALYTICS_PREMIUM_FEATURE,
  AnalyticsEntitlement,
  analyticsEntitlement,
  AnalyticsFeature,
  hasAnalyticsFeature,
} from './analytics-entitlements';
import {
  AnalyticsRange,
  analyticsBucketKey,
  analyticsBucketKeys,
  parseAnalyticsRange,
  rateOrNull,
} from './analytics-range';
import { utcDayKey } from './analytics-time';
import {
  AdminAnalyticsOverviewDto,
  AdminAnalyticsResourceDto,
  AnalyticsCountryDto,
  AnalyticsRangeQueryDto,
  AnalyticsSeriesPointDto,
  AnalyticsSourceDto,
  CampaignAnalyticsFunnelDto,
  CampaignAnalyticsSummaryDto,
  CampaignConfirmedBackingDto,
  IdeaAnalyticsAcquisitionDto,
  IdeaAnalyticsGeographyDto,
  IdeaAnalyticsSummaryDto,
  IdeaAnalyticsTimeseriesDto,
  IdeaAnalyticsValidationDto,
  IdeaValidationCountsDto,
} from './dto/analytics-read.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_SECONDS = 60;
const MAX_COUNTRY_ROWS = 50;
const SOURCES = ['feed', 'search', 'direct', 'internal'] as const;

type ViewResourceType = 'IDEA' | 'CAMPAIGN' | 'PAGE';
type ViewEventName = 'IDEA_VIEWED' | 'CAMPAIGN_VIEWED' | 'PAGE_VIEWED';

interface ReachRow {
  day: string;
  views: number;
  uniqueSessions: number;
}

function viewEventFor(resourceType: ViewResourceType): ViewEventName {
  if (resourceType === 'IDEA') return 'IDEA_VIEWED';
  if (resourceType === 'CAMPAIGN') return 'CAMPAIGN_VIEWED';
  return 'PAGE_VIEWED';
}

/**
 * Owner/admin analytics reads.
 *
 * Collection is separate from entitlement: every route resolves the resource and
 * checks ownership first, then the `CreatorTier` gate, then reads aggregates. No
 * visitor-level row is ever returned, and a non-owner gets 404 rather than a hint
 * that the resource exists.
 */
@Injectable()
export class AnalyticsQueryService {
  private readonly rawRetentionDays: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    @Optional() private readonly cache?: CacheService,
  ) {
    this.rawRetentionDays = config.get('ANALYTICS_RAW_RETENTION_DAYS', {
      infer: true,
    });
  }

  async getIdeaSummary(
    user: AuthenticatedUser,
    idOrSlug: string,
    input: AnalyticsRangeQueryDto,
  ): Promise<IdeaAnalyticsSummaryDto> {
    const range = this.range(input);
    const idea = await this.resolveIdea(user, idOrSlug);

    const [reach, exact, validation, lastAggregatedDay] = await Promise.all([
      this.readReach('IDEA', idea.id, range),
      this.exactUniqueSessions('IDEA', idea.id, range),
      this.ideaValidationCounts(idea.id),
      this.lastAggregatedDay('IDEA', idea.id),
    ]);

    return {
      ideaId: idea.id,
      from: range.from,
      to: range.to,
      totals: {
        views: this.sumReach(reach).views,
        uniqueSessions: exact.count,
        uniqueSessionsExact: exact.exact,
      },
      validation,
      lastAggregatedDay,
      generatedAt: new Date().toISOString(),
    };
  }

  async getIdeaTimeseries(
    user: AuthenticatedUser,
    idOrSlug: string,
    input: AnalyticsRangeQueryDto,
  ): Promise<IdeaAnalyticsTimeseriesDto> {
    const range = this.range(input);
    const idea = await this.resolveIdea(user, idOrSlug);

    const [reach, signals] = await Promise.all([
      this.readReach('IDEA', idea.id, range),
      this.prisma.ideaSignalDailyMetric.findMany({
        where: {
          ideaId: idea.id,
          day: { gte: range.start, lt: range.endExclusive },
        },
        orderBy: { day: 'asc' },
        select: {
          day: true,
          supportCount: true,
          prePledgeCount: true,
          uniqueActors: true,
        },
      }),
    ]);

    const points = new Map<string, AnalyticsSeriesPointDto>();
    for (const bucket of analyticsBucketKeys(range)) {
      points.set(bucket, {
        bucket,
        views: 0,
        uniqueSessions: 0,
        supportCount: 0,
        prePledgeCount: 0,
        uniqueActors: 0,
      });
    }

    for (const row of reach) {
      const point = points.get(
        analyticsBucketKey(new Date(`${row.day}T00:00:00.000Z`), range.interval),
      );
      if (!point) continue;
      point.views += row.views;
      point.uniqueSessions += row.uniqueSessions;
    }

    for (const row of signals) {
      const point = points.get(analyticsBucketKey(row.day, range.interval));
      if (!point) continue;
      point.supportCount += row.supportCount;
      point.prePledgeCount += row.prePledgeCount;
      point.uniqueActors += row.uniqueActors;
    }

    return {
      ideaId: idea.id,
      from: range.from,
      to: range.to,
      interval: range.interval,
      uniqueSessionsIsSum: true,
      points: [...points.values()],
      generatedAt: new Date().toISOString(),
    };
  }

  async getIdeaValidation(
    user: AuthenticatedUser,
    idOrSlug: string,
    input: AnalyticsRangeQueryDto,
  ): Promise<IdeaAnalyticsValidationDto> {
    const range = this.range(input);
    const idea = await this.resolveIdea(user, idOrSlug);
    const entitlement = await this.entitlementFor(user);

    const [reach, counts] = await Promise.all([
      this.readReach('IDEA', idea.id, range),
      this.ideaValidationCounts(idea.id),
    ]);
    const views = this.sumReach(reach).views;

    const conversion = entitlement.premium
      ? {
          viewToSupportPct: rateOrNull(counts.supporters, views),
          viewToFeedbackPct: rateOrNull(counts.feedbackCount, views),
          viewToCommentPct: rateOrNull(counts.commentCount, views),
        }
      : null;

    return {
      ideaId: idea.id,
      from: range.from,
      to: range.to,
      counts,
      conversion,
      premium: entitlement.premium,
      generatedAt: new Date().toISOString(),
    };
  }

  async getIdeaAcquisition(
    user: AuthenticatedUser,
    idOrSlug: string,
    input: AnalyticsRangeQueryDto,
  ): Promise<IdeaAnalyticsAcquisitionDto> {
    const range = this.range(input);
    const idea = await this.resolveIdea(user, idOrSlug);
    const entitlement = await this.entitlementFor(user);
    this.assertFeature(entitlement, 'acquisition');

    const key = `idea:${idea.id}:acquisition:${range.from}:${range.to}:${entitlement.tier}`;
    return this.cached(key, async () => {
      const groups = await this.prisma.resourceAcquisitionDailyMetric.groupBy({
        by: ['source'],
        where: {
          resourceType: 'IDEA',
          resourceId: idea.id,
          day: { gte: range.start, lt: range.endExclusive },
          source: { in: [...SOURCES] },
        },
        _sum: { views: true, uniqueSessions: true },
      });

      const totalViews = groups.reduce(
        (total, group) => total + (group._sum.views ?? 0),
        0,
      );
      const sources: AnalyticsSourceDto[] = groups
        .map((group) => {
          const views = group._sum.views ?? 0;
          return {
            source: group.source,
            views,
            uniqueSessions: group._sum.uniqueSessions ?? 0,
            sharePct: rateOrNull(views, totalViews),
          };
        })
        .sort((left, right) => right.views - left.views);

      return {
        ideaId: idea.id,
        from: range.from,
        to: range.to,
        totalViews,
        sources,
        premium: true,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  async getIdeaGeography(
    user: AuthenticatedUser,
    idOrSlug: string,
    input: AnalyticsRangeQueryDto,
  ): Promise<IdeaAnalyticsGeographyDto> {
    const range = this.range(input);
    const idea = await this.resolveIdea(user, idOrSlug);
    const entitlement = await this.entitlementFor(user);
    this.assertFeature(entitlement, 'geography');

    const key = `idea:${idea.id}:geography:${range.from}:${range.to}:${entitlement.tier}`;
    return this.cached(key, async () => {
      const groups = await this.prisma.resourceCountryDailyMetric.groupBy({
        by: ['countryCode'],
        where: {
          resourceType: 'IDEA',
          resourceId: idea.id,
          day: { gte: range.start, lt: range.endExclusive },
        },
        _sum: { views: true, uniqueSessions: true },
      });

      const totalViews = groups.reduce(
        (total, group) => total + (group._sum.views ?? 0),
        0,
      );
      const rows: AnalyticsCountryDto[] = groups
        .map((group) => {
          const views = group._sum.views ?? 0;
          return {
            countryCode: group.countryCode,
            views,
            uniqueSessions: group._sum.uniqueSessions ?? 0,
            sharePct: rateOrNull(views, totalViews),
          };
        })
        .sort((left, right) => right.views - left.views);

      return {
        ideaId: idea.id,
        from: range.from,
        to: range.to,
        totalViews,
        countries: rows.slice(0, MAX_COUNTRY_ROWS),
        truncated: rows.length > MAX_COUNTRY_ROWS,
        premium: true,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  async getCampaignSummary(
    user: AuthenticatedUser,
    campaignId: string,
    input: AnalyticsRangeQueryDto,
  ): Promise<CampaignAnalyticsSummaryDto> {
    const range = this.range(input);
    const campaign = await this.resolveCampaign(user, campaignId);

    const [reach, exact, funnel, confirmed, lastAggregatedDay] = await Promise.all([
      this.readReach('CAMPAIGN', campaign.id, range),
      this.exactUniqueSessions('CAMPAIGN', campaign.id, range),
      this.campaignFunnel(campaign.id, range),
      this.confirmedBacking(campaign.id),
      this.lastAggregatedDay('CAMPAIGN', campaign.id),
    ]);

    return {
      campaignId: campaign.id,
      from: range.from,
      to: range.to,
      totals: {
        views: this.sumReach(reach).views,
        uniqueSessions: exact.count,
        uniqueSessionsExact: exact.exact,
      },
      funnel,
      confirmedBacking: confirmed,
      lastAggregatedDay,
      generatedAt: new Date().toISOString(),
    };
  }

  async getCampaignFunnel(
    user: AuthenticatedUser,
    campaignId: string,
    input: AnalyticsRangeQueryDto,
  ): Promise<CampaignAnalyticsFunnelDto> {
    const range = this.range(input);
    const campaign = await this.resolveCampaign(user, campaignId);
    const entitlement = await this.entitlementFor(user);
    this.assertFeature(entitlement, 'campaign-funnel');

    const key = `campaign:${campaign.id}:funnel:${range.from}:${range.to}:${entitlement.tier}`;
    return this.cached(key, async () => {
      const [reach, exact, funnel, confirmed] = await Promise.all([
        this.readReach('CAMPAIGN', campaign.id, range),
        this.exactUniqueSessions('CAMPAIGN', campaign.id, range),
        this.campaignFunnel(campaign.id, range),
        this.confirmedBacking(campaign.id),
      ]);

      return {
        campaignId: campaign.id,
        from: range.from,
        to: range.to,
        views: this.sumReach(reach).views,
        uniqueSessions: exact.count,
        uniqueSessionsExact: exact.exact,
        stepStarted: funnel.stepStarted,
        stepCompleted: funnel.stepCompleted,
        stepCompletionPct: rateOrNull(funnel.stepCompleted, funnel.stepStarted),
        backingStarted: funnel.contributionStarted,
        confirmedBacking: confirmed,
        premium: true,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  async getAdminOverview(
    user: AuthenticatedUser,
    input: AnalyticsRangeQueryDto,
  ): Promise<AdminAnalyticsOverviewDto> {
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Admin analytics requires an admin account',
      });
    }

    const range = this.range(input);
    const key = `admin:overview:${range.from}:${range.to}`;

    return this.cached(key, async () => {
      const [groups, last, exact] = await Promise.all([
        this.prisma.resourceReachDailyMetric.groupBy({
          by: ['resourceType'],
          where: { day: { gte: range.start, lt: range.endExclusive } },
          _sum: { views: true, uniqueSessions: true },
        }),
        this.prisma.resourceReachDailyMetric.aggregate({ _max: { day: true } }),
        this.exactPlatformUniqueSessions(range),
      ]);

      const resources: AdminAnalyticsResourceDto[] = groups
        .map((group) => ({
          resourceType: group.resourceType,
          views: group._sum.views ?? 0,
          uniqueSessions: group._sum.uniqueSessions ?? 0,
        }))
        .sort((left, right) => right.views - left.views);

      const views = resources.reduce((total, row) => total + row.views, 0);

      return {
        from: range.from,
        to: range.to,
        totals: {
          views,
          uniqueSessions: exact.count,
          uniqueSessionsExact: exact.exact,
        },
        resources,
        lastAggregatedDay: last._max.day ? utcDayKey(last._max.day) : null,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  private range(input: AnalyticsRangeQueryDto): AnalyticsRange {
    try {
      return parseAnalyticsRange(input, new Date());
    } catch (error) {
      throw new BadRequestException({
        code: 'INVALID_ANALYTICS_RANGE',
        message:
          error instanceof Error ? error.message : 'Invalid analytics range',
      });
    }
  }

  private async resolveIdea(
    user: AuthenticatedUser,
    idOrSlug: string,
  ): Promise<{ id: string; creatorId: string }> {
    const idea = await this.prisma.idea.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      select: { id: true, creatorId: true },
    });
    if (!idea) throw new NotFoundException('Idea not found');
    this.assertOwnerOrAdmin(user, idea.creatorId);
    return idea;
  }

  private async resolveCampaign(
    user: AuthenticatedUser,
    campaignId: string,
  ): Promise<{ id: string; creatorId: string }> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, creatorId: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    this.assertOwnerOrAdmin(user, campaign.creatorId);
    return campaign;
  }

  private assertOwnerOrAdmin(user: AuthenticatedUser, creatorId: string): void {
    if (user.role !== 'ADMIN' && creatorId !== user.id) {
      // 404, not 403: a non-owner must not learn that the resource exists.
      throw new NotFoundException('Not found');
    }
  }

  private async entitlementFor(
    user: AuthenticatedUser,
  ): Promise<AnalyticsEntitlement> {
    const [profile, access] = await Promise.all([
      this.prisma.creatorProfile.findUnique({
        where: { userId: user.id },
        select: { tier: true },
      }),
      this.prisma.analyticsAccessGrant.findUnique({
        where: {
          userId_feature: {
            userId: user.id,
            feature: ANALYTICS_PREMIUM_FEATURE,
          },
        },
        select: { status: true, source: true, expiresAt: true },
      }),
    ]);
    return analyticsEntitlement({
      role: user.role === 'ADMIN' ? 'ADMIN' : 'USER',
      creatorTier: profile?.tier ?? null,
      access,
      now: new Date(),
    });
  }

  private assertFeature(
    entitlement: AnalyticsEntitlement,
    feature: AnalyticsFeature,
  ): void {
    if (!hasAnalyticsFeature(entitlement, feature)) {
      throw new ForbiddenException({
        code: 'ANALYTICS_ENTITLEMENT_REQUIRED',
        message:
          'This analytics report requires premium access. Request access from your creator settings.',
        feature,
        tier: entitlement.tier,
        requestStatus: entitlement.requestStatus,
        canRequest: entitlement.canRequest,
      });
    }
  }

  private async ideaValidationCounts(
    ideaId: string,
  ): Promise<IdeaValidationCountsDto> {
    const [idea, prePledges] = await Promise.all([
      this.prisma.idea.findUnique({
        where: { id: ideaId },
        select: {
          supporterCount: true,
          feedbackCount: true,
          feedbackScore: true,
          commentCount: true,
          weightedPrePledgeTotal: true,
        },
      }),
      this.prisma.ideaSignal.count({
        where: { ideaId, type: 'PRE_PLEDGE' },
      }),
    ]);
    if (!idea) throw new NotFoundException('Idea not found');

    return {
      supporters: idea.supporterCount,
      prePledges,
      feedbackCount: idea.feedbackCount,
      feedbackScore: Number(idea.feedbackScore),
      commentCount: idea.commentCount,
      estimatedInterestUsd: idea.weightedPrePledgeTotal.toString(),
      follows: null,
      saves: null,
    };
  }

  private async readReach(
    resourceType: ViewResourceType,
    resourceId: string,
    range: AnalyticsRange,
  ): Promise<ReachRow[]> {
    const rows = await this.prisma.resourceReachDailyMetric.findMany({
      where: {
        resourceType,
        resourceId,
        day: { gte: range.start, lt: range.endExclusive },
      },
      orderBy: { day: 'asc' },
      select: { day: true, views: true, uniqueSessions: true },
    });
    return rows.map((row) => ({
      day: utcDayKey(row.day),
      views: row.views,
      uniqueSessions: row.uniqueSessions,
    }));
  }

  private sumReach(rows: ReachRow[]): { views: number; uniqueSessions: number } {
    return rows.reduce(
      (total, row) => ({
        views: total.views + row.views,
        uniqueSessions: total.uniqueSessions + row.uniqueSessions,
      }),
      { views: 0, uniqueSessions: 0 },
    );
  }

  private async exactUniqueSessions(
    resourceType: ViewResourceType,
    resourceId: string,
    range: AnalyticsRange,
  ): Promise<{ count: number; exact: boolean }> {
    const retentionStart = new Date(
      Date.now() - this.rawRetentionDays * DAY_MS,
    );
    if (range.start.getTime() < retentionStart.getTime()) {
      const reach = await this.readReach(resourceType, resourceId, range);
      return { count: this.sumReach(reach).uniqueSessions, exact: false };
    }

    const eventName = viewEventFor(resourceType);
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(DISTINCT COALESCE("userId", "sessionId"))::bigint AS count
      FROM "ProductAnalyticsEvent"
      WHERE "resourceType" = ${resourceType}::"AnalyticsResourceType"
        AND "resourceId" = ${resourceId}
        AND "name" = ${eventName}::"ProductAnalyticsEventName"
        AND "occurredAt" >= ${range.start}
        AND "occurredAt" < ${range.endExclusive}
    `;
    return { count: Number(rows[0]?.count ?? 0n), exact: true };
  }

  private async exactPlatformUniqueSessions(
    range: AnalyticsRange,
  ): Promise<{ count: number; exact: boolean }> {
    const retentionStart = new Date(
      Date.now() - this.rawRetentionDays * DAY_MS,
    );
    if (range.start.getTime() < retentionStart.getTime()) {
      const aggregate = await this.prisma.resourceReachDailyMetric.aggregate({
        where: { day: { gte: range.start, lt: range.endExclusive } },
        _sum: { uniqueSessions: true },
      });
      return { count: aggregate._sum.uniqueSessions ?? 0, exact: false };
    }

    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(DISTINCT COALESCE("userId", "sessionId"))::bigint AS count
      FROM "ProductAnalyticsEvent"
      WHERE "name" IN (
        'IDEA_VIEWED'::"ProductAnalyticsEventName",
        'CAMPAIGN_VIEWED'::"ProductAnalyticsEventName",
        'PAGE_VIEWED'::"ProductAnalyticsEventName"
      )
        AND "occurredAt" >= ${range.start}
        AND "occurredAt" < ${range.endExclusive}
    `;
    return { count: Number(rows[0]?.count ?? 0n), exact: true };
  }

  private async lastAggregatedDay(
    resourceType: ViewResourceType,
    resourceId: string,
  ): Promise<string | null> {
    const result = await this.prisma.resourceReachDailyMetric.aggregate({
      where: { resourceType, resourceId },
      _max: { day: true },
    });
    return result._max.day ? utcDayKey(result._max.day) : null;
  }

  private async campaignFunnel(
    campaignId: string,
    range: AnalyticsRange,
  ): Promise<{ stepStarted: number; stepCompleted: number; contributionStarted: number }> {
    const result = await this.prisma.campaignFunnelDailyMetric.aggregate({
      where: {
        campaignId,
        day: { gte: range.start, lt: range.endExclusive },
      },
      _sum: {
        stepStarted: true,
        stepCompleted: true,
        contributionStarted: true,
      },
    });
    return {
      stepStarted: result._sum.stepStarted ?? 0,
      stepCompleted: result._sum.stepCompleted ?? 0,
      contributionStarted: result._sum.contributionStarted ?? 0,
    };
  }

  private async confirmedBacking(
    campaignId: string,
  ): Promise<CampaignConfirmedBackingDto> {
    const result = await this.prisma.contribution.aggregate({
      where: { campaignId },
      _count: { _all: true },
      _sum: { amount: true },
    });
    return {
      count: result._count._all,
      amountUsd: result._sum.amount?.toString() ?? '0',
      source: 'contribution_indexer',
    };
  }

  private async cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    return this.cache
      ? this.cache.getOrSet('analytics', key, CACHE_TTL_SECONDS, loader)
      : loader();
  }
}
