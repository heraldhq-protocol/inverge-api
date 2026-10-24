import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PlatformParamsModule } from '../platform-params/platform-params.module';
import { AuthModule } from '../auth/auth.module';
import { envFlag } from '../../config/feature-flags';
import { MetricsService } from './metrics.service';
import { SNAPSHOT_QUEUE, SnapshotProcessor } from './snapshot.processor';
import { SnapshotScheduler } from './snapshot.scheduler';
import { InsightsService } from './insights.service';
import { InsightsController } from './insights.controller';

// Registering a BullMQ queue creates a Worker, and a Worker dials Redis during
// bootstrap. When queues are disabled (tests, a web-only replica) the module must
// not register the queue at all - a lazy connection option cannot stop a Worker.
const queueEnabled = envFlag('QUEUE_ENABLED');

@Module({
  imports: [
    PlatformParamsModule,
    AuthModule,
    ...(queueEnabled ? [BullModule.registerQueue({ name: SNAPSHOT_QUEUE })] : []),
  ],
  controllers: [InsightsController],
  providers: [
    MetricsService,
    InsightsService,
    ...(queueEnabled ? [SnapshotProcessor, SnapshotScheduler] : []),
  ],
  exports: [MetricsService, InsightsService],
})
export class MetricsModule {}
