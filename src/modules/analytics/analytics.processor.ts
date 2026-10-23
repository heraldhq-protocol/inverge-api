import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { AnalyticsRetentionService } from './analytics-retention.service';
import { previousUtcDay } from './analytics-time';

export const ANALYTICS_QUEUE = 'analytics-maintenance';

export type AnalyticsJobData = { day?: string };

// One nightly pass: rebuild yesterday's idea-signal roll-up, then enforce retention.
// Both steps are idempotent, so retries and manual reruns are safe.
@Processor(ANALYTICS_QUEUE)
export class AnalyticsProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalyticsProcessor.name);

  constructor(
    private readonly aggregation: AnalyticsAggregationService,
    private readonly retention: AnalyticsRetentionService,
  ) {
    super();
  }

  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.warn(
      `Analytics worker is unavailable (${error.message}); ` +
        'maintenance resumes when Redis is reachable.',
    );
  }

  async process(job: Job<AnalyticsJobData>) {
    const day = job.data?.day ?? previousUtcDay(new Date());
    const aggregated = await this.aggregation.aggregateIdeaSignals(day);
    const purged = await this.retention.purge(new Date());

    this.logger.log(
      `Analytics maintenance ${day}: ${aggregated.ideas} idea roll-up(s), ` +
        `${purged.events} raw event(s), ${purged.aggregates} aggregate(s) purged`,
    );

    return { ...aggregated, ...purged };
  }
}
