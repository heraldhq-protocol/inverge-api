import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { JOBS_QUEUE } from '../../common/queue/job-names';
import { envFlag } from '../../config/feature-flags';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { KycModule } from '../kyc/kyc.module';
import { MetricsModule } from '../metrics/metrics.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { JobsProcessor } from './jobs.processor';
import { PeriodicJobsService } from './periodic-jobs.service';

// The composition root for background work: one Worker for every queued job,
// plus the in-process timers that replaced repeatable jobs. The feature modules
// own their handlers and export them; this module only wires them together.
const queueEnabled = envFlag('QUEUE_ENABLED');

@Module({
  imports: [
    KycModule,
    NotificationsModule,
    AnalyticsModule,
    MetricsModule,
    CampaignsModule,
    ...(queueEnabled ? [BullModule.registerQueue({ name: JOBS_QUEUE })] : []),
  ],
  providers: [
    PeriodicJobsService,
    ...(queueEnabled ? [JobsProcessor] : []),
  ],
})
export class JobsModule {}
