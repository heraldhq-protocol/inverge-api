import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MetricsModule } from '../metrics/metrics.module';
import { QualityModule } from '../quality/quality.module';
import { ModerationModule } from '../moderation/moderation.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { IdeasController } from './ideas.controller';
import { IdeasService } from './ideas.service';
import { MePrePledgesController } from './me-pre-pledges.controller';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [AuthModule, MetricsModule, QualityModule, ModerationModule, AnalyticsModule, MediaModule],
  controllers: [IdeasController, MePrePledgesController],
  providers: [IdeasService],
  exports: [IdeasService],
})
export class IdeasModule {}
