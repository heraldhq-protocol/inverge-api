import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { utcDayRange } from './analytics-time';

type DailySignals = {
  supportCount: number;
  prePledgeCount: number;
  uniqueActors: number;
};

const UPSERT_CHUNK = 100;

/**
 * Rebuilds the daily idea-signal roll-up from raw events. Idempotent per
 * `(ideaId, day)`: a rerun replaces the day's counts rather than adding to them,
 * and the raw event table remains the only source of truth.
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

    const operations = [...daily.entries()].map(([ideaId, counts]) =>
      this.prisma.ideaSignalDailyMetric.upsert({
        where: { ideaId_day: { ideaId, day: start } },
        update: counts,
        create: { ideaId, day: start, ...counts },
      }),
    );

    for (let offset = 0; offset < operations.length; offset += UPSERT_CHUNK) {
      await this.prisma.$transaction(
        operations.slice(offset, offset + UPSERT_CHUNK),
      );
    }

    return { day, ideas: daily.size };
  }
}
