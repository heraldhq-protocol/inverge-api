import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  ANALYTICS_INGEST_QUEUE,
  AnalyticsIngestJobData,
  fromAnalyticsIngestJobEvent,
} from './analytics-ingest.job';
import { ProductAnalyticsService } from './product-analytics.service';

/**
 * Asynchronous ingest worker. Duplicate `eventKey`s are skipped by the bulk
 * insert, so a BullMQ retry after a partial failure is safe.
 */
@Processor(ANALYTICS_INGEST_QUEUE)
export class AnalyticsIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalyticsIngestProcessor.name);

  constructor(private readonly analytics: ProductAnalyticsService) {
    super();
  }

  async process(job: Job<AnalyticsIngestJobData>): Promise<{ persisted: number }> {
    const events = job.data.events.map(fromAnalyticsIngestJobEvent);
    const persisted = await this.analytics.persistBatch(events);
    return { persisted };
  }

  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.warn(`Analytics ingest worker error: ${error.message}`);
  }
}
