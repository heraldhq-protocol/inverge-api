import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuthModule } from '../auth/auth.module';
import { MetricsModule } from '../metrics/metrics.module';
import { SurveyController } from './survey.controller';
import { SurveyService } from './survey.service';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

// Idea feedback surface: the creator-built structured survey (responses feed feedbackScore)
// and the free-form comments thread. MetricsModule provides recompute; Auth provides the guard.
@Module({
  imports: [AuthModule, MetricsModule, AnalyticsModule],
  controllers: [SurveyController, CommentsController],
  providers: [SurveyService, CommentsService],
  exports: [SurveyService, CommentsService],
})
export class SurveyModule {}
