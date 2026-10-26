import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { AnalyticsRetentionService } from './analytics-retention.service';
import { previousUtcDay } from './analytics-time';

export const ANALYTICS_QUEUE = 'analytics-maintenance';

export type AnalyticsJobData = { day?: string };

// One nightly pass: rebuild yesterday's roll-ups, then enforce retention. Every
// step is idempotent, so retries and manual reruns are safe.
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
    const signals = await this.aggregation.aggregateIdeaSignals(day);
    const reach = await this.aggregation.aggregateReach(day);
    const acquisition = await this.aggregation.aggregateAcquisition(day);
    const countries = await this.aggregation.aggregateCountries(day);
    const funnel = await this.aggregation.aggregateCampaignFunnel(day);
    const purged = await this.retention.purge(new Date());

    this.logger.log(
      `Analytics maintenance ${day}: ${signals.ideas} idea roll-up(s), ` +
        `${reach.resources} reach row(s), ${acquisition.resources} acquisition row(s), ` +
        `${countries.resources} country row(s), ${funnel.campaigns} funnel row(s), ` +
        `${purged.events} raw event(s), ${purged.aggregates} aggregate(s) purged`,
    );

    return { day, signals, reach, acquisition, countries, funnel, purged };
  }
}
