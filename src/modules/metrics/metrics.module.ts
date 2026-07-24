import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PlatformParamsModule } from '../platform-params/platform-params.module';
import { MetricsService } from './metrics.service';
import { SNAPSHOT_QUEUE, SnapshotProcessor } from './snapshot.processor';
import { SnapshotScheduler } from './snapshot.scheduler';

@Module({
  imports: [PlatformParamsModule, BullModule.registerQueue({ name: SNAPSHOT_QUEUE })],
  providers: [MetricsService, SnapshotProcessor, SnapshotScheduler],
  exports: [MetricsService],
})
export class MetricsModule {}
