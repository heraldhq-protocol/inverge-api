import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { validateEnv } from './config/env.validation';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    EventEmitterModule.forRoot(),
    // Infrastructure
    PrismaModule,
    PortsModule,
    PlatformParamsModule,
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
  ],
})
export class AppModule {}
