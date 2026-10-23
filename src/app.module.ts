import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { validateEnv } from './config/env.validation';
import { ApiExceptionFilter } from './common/http/api-exception.filter';
import { CacheModule } from './common/cache/cache.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { TelemetryModule } from './common/telemetry/telemetry.module';
import { PrismaModule } from './prisma/prisma.module';
import { PortsModule } from './ports/ports.module';
import { QueueModule } from './modules/queue/queue.module';
import { PlatformParamsModule } from './modules/platform-params/platform-params.module';
import { AuthModule } from './modules/auth/auth.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { IdeasModule } from './modules/ideas/ideas.module';
import { FeedModule } from './modules/feed/feed.module';
import { BoostsModule } from './modules/boosts/boosts.module';
import { FlatFeeModule } from './modules/flat-fee/flat-fee.module';
import { KycModule } from './modules/kyc/kyc.module';
import { SyncModule } from './modules/sync/sync.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AdminModule } from './modules/admin/admin.module';
import { ModerationModule } from './modules/moderation/moderation.module';
import { SurveyModule } from './modules/survey/survey.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { TaxonomyModule } from './modules/taxonomy/taxonomy.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    EventEmitterModule.forRoot(),
    // Infrastructure
    PrismaModule,
    PortsModule,
    PlatformParamsModule,
    CacheModule,
    // Telemetry registers the metrics/log interceptors before the limiter so a
    // rejected request still produces a metric and a log line.
    TelemetryModule,
    RateLimitModule,
    QueueModule,
    // Phase 0 domain
    AuthModule,
    WalletsModule,
    IdeasModule,
    FeedModule,
    BoostsModule,
    FlatFeeModule,
    KycModule,
    SyncModule,
    NotificationsModule,
    AdminModule,
    ModerationModule,
    SurveyModule,
    CampaignsModule,
    AnalyticsModule,
    TaxonomyModule,
  ],
  providers: [
    // Registered as a provider (not only in main.ts) so e2e applications get the
    // same error envelope as production.
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}

