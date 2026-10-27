import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { utcDayRange } from './analytics-time';

type DailySignals = {
  supportCount: number;
  prePledgeCount: number;
  uniqueActors: number;
};

type ResourceType = 'IDEA' | 'CAMPAIGN' | 'PAGE';

interface ReachRow {
  resourceType: ResourceType;
  resourceId: string;
  views: number;
  uniqueSessions: number;
}

interface AcquisitionRow extends ReachRow {
  source: string;
}

interface CountryRow extends ReachRow {
  countryCode: string;
}

interface FunnelRow {
  campaignId: string;
  stepStarted: number;
  stepCompleted: number;
  contributionStarted: number;
}

const UPSERT_CHUNK = 100;

/**
 * Rebuilds every daily roll-up from raw events. Each pass is idempotent per key:
 * a rerun replaces the day's counts rather than adding to them, and the raw event
 * table remains the only source of truth. The nightly job calls this for
 * yesterday; a manual rerun is safe within raw-event retention.
 */
@Injectable()
export class AnalyticsAggregationService {
  constructor(private readonly prisma: PrismaService) {}

  async aggregateIdeaSignals(day: string): Promise<{ day: string; ideas: number }> {
    const { start, end } = utcDayRange(day);

    const [byType, actors] = await Promise.all([
      this.prisma.productAnalyticsEvent.groupBy({
        by: ['ideaId', 'signalType'],
        where: {
          name: 'IDEA_SIGNAL',
          ideaId: { not: null },
          occurredAt: { gte: start, lt: end },
        },
        _count: { _all: true },
      }),
      // Prisma's groupBy `_count` counts rows, not distinct values. One row per
      // (idea, actor) is both the correct estimate and bounded by the day's events.
      this.prisma.productAnalyticsEvent.findMany({
        where: {
          name: 'IDEA_SIGNAL',
          ideaId: { not: null },
          userId: { not: null },
          occurredAt: { gte: start, lt: end },
        },
        select: { ideaId: true, userId: true },
        distinct: ['ideaId', 'userId'],
      }),
    ]);

    const daily = new Map<string, DailySignals>();
    const rowFor = (ideaId: string): DailySignals => {
      const existing = daily.get(ideaId);
      if (existing) return existing;
      const created = { supportCount: 0, prePledgeCount: 0, uniqueActors: 0 };
      daily.set(ideaId, created);
      return created;
    };

    for (const row of byType) {
      if (!row.ideaId) continue;
      const target = rowFor(row.ideaId);
      if (row.signalType === 'SUPPORT') target.supportCount += row._count._all;
      if (row.signalType === 'PRE_PLEDGE') target.prePledgeCount += row._count._all;
    }
    for (const row of actors) {
      if (!row.ideaId) continue;
      rowFor(row.ideaId).uniqueActors += 1;
    }

    await this.chunked(
      [...daily.entries()].map(([ideaId, counts]) =>
        this.prisma.ideaSignalDailyMetric.upsert({
          where: { ideaId_day: { ideaId, day: start } },
          update: counts,
          create: { ideaId, day: start, ...counts },
        }),
      ),
    );

    return { day, ideas: daily.size };
  }

  async aggregateReach(day: string): Promise<{ day: string; resources: number }> {
    const { start, end } = utcDayRange(day);
    const rows = await this.prisma.$queryRaw<ReachRow[]>`
      SELECT
        "resourceType",
        "resourceId",
        COUNT(*)::int AS "views",
        COUNT(DISTINCT COALESCE("userId", "sessionId"))::int AS "uniqueSessions"
      FROM "ProductAnalyticsEvent"
      WHERE "name" IN (
        'IDEA_VIEWED'::"ProductAnalyticsEventName",
        'CAMPAIGN_VIEWED'::"ProductAnalyticsEventName",
        'PAGE_VIEWED'::"ProductAnalyticsEventName"
      )
        AND "resourceType" IS NOT NULL
        AND "resourceId" IS NOT NULL
        AND "occurredAt" >= ${start}
        AND "occurredAt" < ${end}
      GROUP BY "resourceType", "resourceId"
    `;

    await this.chunked(
      rows.map((row) =>
        this.prisma.resourceReachDailyMetric.upsert({
          where: {
            resourceType_resourceId_day: {
              resourceType: row.resourceType,
              resourceId: row.resourceId,
              day: start,
            },
          },
          update: {
            views: row.views,
            uniqueSessions: row.uniqueSessions,
          },
          create: {
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            day: start,
            views: row.views,
            uniqueSessions: row.uniqueSessions,
          },
        }),
      ),
    );

    return { day, resources: rows.length };
  }

  async aggregateAcquisition(
    day: string,
  ): Promise<{ day: string; resources: number }> {
    const { start, end } = utcDayRange(day);
    const rows = await this.prisma.$queryRaw<AcquisitionRow[]>`
      SELECT
        "resourceType",
        "resourceId",
        COALESCE("source", 'direct') AS "source",
        COUNT(*)::int AS "views",
        COUNT(DISTINCT COALESCE("userId", "sessionId"))::int AS "uniqueSessions"
      FROM "ProductAnalyticsEvent"
      WHERE "name" IN (
        'IDEA_VIEWED'::"ProductAnalyticsEventName",
        'CAMPAIGN_VIEWED'::"ProductAnalyticsEventName",
        'PAGE_VIEWED'::"ProductAnalyticsEventName"
      )
        AND "resourceType" IS NOT NULL
        AND "resourceId" IS NOT NULL
        AND "occurredAt" >= ${start}
        AND "occurredAt" < ${end}
      GROUP BY "resourceType", "resourceId", COALESCE("source", 'direct')
    `;

    await this.chunked(
      rows.map((row) =>
        this.prisma.resourceAcquisitionDailyMetric.upsert({
          where: {
            resourceType_resourceId_day_source: {
              resourceType: row.resourceType,
              resourceId: row.resourceId,
              day: start,
              source: row.source,
            },
          },
          update: {
            views: row.views,
            uniqueSessions: row.uniqueSessions,
          },
          create: {
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            day: start,
            source: row.source,
            views: row.views,
            uniqueSessions: row.uniqueSessions,
          },
        }),
      ),
    );

    return { day, resources: rows.length };
  }

  async aggregateCountries(
    day: string,
  ): Promise<{ day: string; resources: number }> {
    const { start, end } = utcDayRange(day);
    const rows = await this.prisma.$queryRaw<CountryRow[]>`
      SELECT
        "resourceType",
        "resourceId",
        "countryCode",
        COUNT(*)::int AS "views",
        COUNT(DISTINCT COALESCE("userId", "sessionId"))::int AS "uniqueSessions"
      FROM "ProductAnalyticsEvent"
      WHERE "name" IN (
        'IDEA_VIEWED'::"ProductAnalyticsEventName",
        'CAMPAIGN_VIEWED'::"ProductAnalyticsEventName",
        'PAGE_VIEWED'::"ProductAnalyticsEventName"
      )
        AND "resourceType" IS NOT NULL
        AND "resourceId" IS NOT NULL
        AND "countryCode" IS NOT NULL
        AND char_length("countryCode") = 2
        AND "occurredAt" >= ${start}
        AND "occurredAt" < ${end}
      GROUP BY "resourceType", "resourceId", "countryCode"
    `;

    await this.chunked(
      rows.map((row) =>
        this.prisma.resourceCountryDailyMetric.upsert({
          where: {
            resourceType_resourceId_day_countryCode: {
              resourceType: row.resourceType,
              resourceId: row.resourceId,
              day: start,
              countryCode: row.countryCode,
            },
          },
          update: {
            views: row.views,
            uniqueSessions: row.uniqueSessions,
          },
          create: {
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            day: start,
            countryCode: row.countryCode,
            views: row.views,
            uniqueSessions: row.uniqueSessions,
          },
        }),
      ),
    );

    return { day, resources: rows.length };
  }

  async aggregateCampaignFunnel(
    day: string,
  ): Promise<{ day: string; campaigns: number }> {
    const { start, end } = utcDayRange(day);
    const rows = await this.prisma.$queryRaw<FunnelRow[]>`
      SELECT
        "campaignId",
        COUNT(*) FILTER (
          WHERE "name" = 'CAMPAIGN_STEP_STARTED'::"ProductAnalyticsEventName"
        )::int AS "stepStarted",
        COUNT(*) FILTER (
          WHERE "name" = 'CAMPAIGN_STEP_COMPLETED'::"ProductAnalyticsEventName"
        )::int AS "stepCompleted",
        COUNT(*) FILTER (
          WHERE "name" = 'CONTRIBUTION_STARTED'::"ProductAnalyticsEventName"
        )::int AS "contributionStarted"
      FROM "ProductAnalyticsEvent"
      WHERE "name" IN (
        'CAMPAIGN_STEP_STARTED'::"ProductAnalyticsEventName",
        'CAMPAIGN_STEP_COMPLETED'::"ProductAnalyticsEventName",
        'CONTRIBUTION_STARTED'::"ProductAnalyticsEventName"
      )
        AND "campaignId" IS NOT NULL
        AND "occurredAt" >= ${start}
        AND "occurredAt" < ${end}
      GROUP BY "campaignId"
    `;

    await this.chunked(
      rows.map((row) =>
        this.prisma.campaignFunnelDailyMetric.upsert({
          where: {
            campaignId_day: { campaignId: row.campaignId, day: start },
          },
          update: {
            stepStarted: row.stepStarted,
            stepCompleted: row.stepCompleted,
            contributionStarted: row.contributionStarted,
          },
          create: {
            campaignId: row.campaignId,
            day: start,
            stepStarted: row.stepStarted,
            stepCompleted: row.stepCompleted,
            contributionStarted: row.contributionStarted,
          },
        }),
      ),
    );

    return { day, campaigns: rows.length };
  }

  private async chunked(
    operations: Array<Prisma.PrismaPromise<unknown>>,
  ): Promise<void> {
    for (let offset = 0; offset < operations.length; offset += UPSERT_CHUNK) {
      await this.prisma.$transaction(operations.slice(offset, offset + UPSERT_CHUNK));
    }
  }
}
