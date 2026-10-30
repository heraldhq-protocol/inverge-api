import { Module } from '@nestjs/common';
import { PlatformParamsModule } from '../platform-params/platform-params.module';
import { AuthModule } from '../auth/auth.module';
import { MetricsService } from './metrics.service';
import { InsightsService } from './insights.service';
import { InsightsController } from './insights.controller';

// The daily snapshot (FR-204a) is time-driven and runs in-process from
// `modules/jobs/periodic-jobs.service.ts`; this module no longer registers a queue.
@Module({
  imports: [PlatformParamsModule, AuthModule],
  controllers: [InsightsController],
  providers: [MetricsService, InsightsService],
  exports: [MetricsService, InsightsService],
})
export class MetricsModule {}
