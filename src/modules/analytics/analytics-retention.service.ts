import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { retentionCutoffs } from './analytics-time';

/** Enforces the retention table in docs/api/analytics-privacy.md. */
@Injectable()
export class AnalyticsRetentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async purge(now: Date): Promise<{ events: number; aggregates: number }> {
    const cutoffs = retentionCutoffs(
      now,
      this.config.get('ANALYTICS_RAW_RETENTION_DAYS', { infer: true }),
      this.config.get('ANALYTICS_AGGREGATE_RETENTION_MONTHS', { infer: true }),
    );

    const [events, aggregates] = await this.prisma.$transaction([
      this.prisma.productAnalyticsEvent.deleteMany({
        where: { receivedAt: { lt: cutoffs.eventsBefore } },
      }),
      this.prisma.ideaSignalDailyMetric.deleteMany({
        where: { day: { lt: cutoffs.aggregatesBefore } },
      }),
    ]);

    return { events: events.count, aggregates: aggregates.count };
  }
}
