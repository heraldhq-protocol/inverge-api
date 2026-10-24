import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { envFlag } from '../../config/feature-flags';
import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { AnalyticsRetentionService } from './analytics-retention.service';
import { ANALYTICS_QUEUE, AnalyticsProcessor } from './analytics.processor';
import { AnalyticsScheduler } from './analytics.scheduler';
import { ProductAnalyticsService } from './product-analytics.service';

// A BullMQ Worker dials Redis during bootstrap, so the queue must not be registered
// at all when queues are disabled (tests, a web-only replica).
const queueEnabled = envFlag('QUEUE_ENABLED');

@Module({
  imports: [
    ...(queueEnabled ? [BullModule.registerQueue({ name: ANALYTICS_QUEUE })] : []),
  ],
  providers: [
    ProductAnalyticsService,
    AnalyticsAggregationService,
    AnalyticsRetentionService,
    ...(queueEnabled ? [AnalyticsProcessor, AnalyticsScheduler] : []),
  ],
  exports: [ProductAnalyticsService, AnalyticsAggregationService],
})
export class AnalyticsModule {}
