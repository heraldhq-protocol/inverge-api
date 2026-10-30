import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { envFlag } from '../../config/feature-flags';
import { JOBS_QUEUE } from '../../common/queue/job-names';
import { WebhookInboxModule } from '../../common/webhooks/webhook-inbox.module';
import { AuthModule } from '../auth/auth.module';
import { ComplianceReviewerGuard } from '../auth/guards/compliance-reviewer.guard';
import { KycController } from './kyc.controller';
import { KybController } from './kyb.controller';
import { KycService } from './kyc.service';
import { VerificationController } from './verification.controller';
import { VerificationRepository } from './verification.repository';
import { VerificationService } from './verification.service';
import { VerificationWebhookProcessor } from './verification.processor';

// A BullMQ Worker dials Redis during bootstrap, so the queue must not be registered when
// QUEUE_ENABLED=false. The webhook then applies inline; reconciliation is time-driven and
// runs in-process either way (`modules/jobs/periodic-jobs.service.ts`).
const queueEnabled = envFlag('QUEUE_ENABLED');

@Module({
  imports: [
    AuthModule,
    WebhookInboxModule,
    ...(queueEnabled ? [BullModule.registerQueue({ name: JOBS_QUEUE })] : []),
  ],
  controllers: [KycController, KybController, VerificationController],
  providers: [
    VerificationRepository,
    VerificationService,
    KycService,
    ComplianceReviewerGuard,
    ...(queueEnabled ? [VerificationWebhookProcessor] : []),
  ],
  exports: [
    VerificationService,
    VerificationRepository,
    KycService,
    ...(queueEnabled ? [VerificationWebhookProcessor] : []),
  ],
})
export class KycModule {}
