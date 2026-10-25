import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { envFlag } from '../../config/feature-flags';
import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { ANALYTICS_INGEST_QUEUE } from './analytics-ingest.job';
import { AnalyticsIngestProcessor } from './analytics-ingest.processor';
import { AnalyticsIngestGuard } from './analytics-ingest.guard';
import { AnalyticsIngestService } from './analytics-ingest.service';
import { AnalyticsRetentionService } from './analytics-retention.service';
import { ANALYTICS_QUEUE, AnalyticsProcessor } from './analytics.processor';
import { AnalyticsScheduler } from './analytics.scheduler';
import { InternalAnalyticsController } from './internal-analytics.controller';
import { ProductAnalyticsService } from './product-analytics.service';

// A BullMQ Worker dials Redis during bootstrap, so the queue must not be registered
// at all when queues are disabled (tests, a web-only replica).
const queueEnabled = envFlag('QUEUE_ENABLED');

@Module({
  imports: [
    ...(queueEnabled
      ? [
          BullModule.registerQueue({ name: ANALYTICS_QUEUE }),
          BullModule.registerQueue({ name: ANALYTICS_INGEST_QUEUE }),
        ]
      : []),
  ],
  controllers: [InternalAnalyticsController],
  providers: [
    ProductAnalyticsService,
    AnalyticsAggregationService,
    AnalyticsRetentionService,
    AnalyticsIngestService,
    AnalyticsIngestGuard,
    ...(queueEnabled
      ? [AnalyticsProcessor, AnalyticsScheduler, AnalyticsIngestProcessor]
      : []),
  ],
  exports: [ProductAnalyticsService, AnalyticsAggregationService],
})
export class AnalyticsModule {}
