import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  AnalyticsIngestJobData,
  fromAnalyticsIngestJobEvent,
} from './analytics-ingest.job';
import { ProductAnalyticsService } from './product-analytics.service';

/**
 * Asynchronous ingest handler. Duplicate `eventKey`s are skipped by the bulk
 * insert, so a retry after a partial failure is safe. `JobsProcessor` owns the
 * only Worker; this class is the handler behind one job name.
 */
@Injectable()
export class AnalyticsIngestProcessor {
  constructor(private readonly analytics: ProductAnalyticsService) {}

  async process(job: Job<AnalyticsIngestJobData>): Promise<{ persisted: number }> {
    const events = job.data.events.map(fromAnalyticsIngestJobEvent);
    const persisted = await this.analytics.persistBatch(events);
    return { persisted };
  }
}
