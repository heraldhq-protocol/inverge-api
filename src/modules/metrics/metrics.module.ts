import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PlatformParamsModule } from '../platform-params/platform-params.module';
import { AuthModule } from '../auth/auth.module';
import { MetricsService } from './metrics.service';
import { SNAPSHOT_QUEUE, SnapshotProcessor } from './snapshot.processor';
import { SnapshotScheduler } from './snapshot.scheduler';
import { InsightsService } from './insights.service';
import { InsightsController } from './insights.controller';

@Module({
  imports: [PlatformParamsModule, AuthModule, BullModule.registerQueue({ name: SNAPSHOT_QUEUE })],
  controllers: [InsightsController],
  providers: [MetricsService, SnapshotProcessor, SnapshotScheduler, InsightsService],
  exports: [MetricsService, InsightsService],
})
export class MetricsModule {}
