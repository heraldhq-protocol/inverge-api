import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { envFlag } from '../../config/feature-flags';
import { WebhookInboxModule } from '../../common/webhooks/webhook-inbox.module';
import { AuthModule } from '../auth/auth.module';
import { ComplianceReviewerGuard } from '../auth/guards/compliance-reviewer.guard';
import { KycController } from './kyc.controller';
import { KybController } from './kyb.controller';
import { KycService } from './kyc.service';
import { VerificationController } from './verification.controller';
import { VerificationRepository } from './verification.repository';
import { VerificationService } from './verification.service';
import {
  VerificationReconcileProcessor,
  VerificationWebhookProcessor,
} from './verification.processor';
import {
  VerificationIntervalReconciler,
  VerificationReconcileScheduler,
} from './verification.scheduler';
import {
  VERIFICATION_RECONCILE_QUEUE,
  VERIFICATION_WEBHOOK_QUEUE,
} from './verification.queue';

// A BullMQ Worker dials Redis during bootstrap, so queues must not be registered when
// QUEUE_ENABLED=false. The interval reconciler covers that deployment without Redis.
const queueEnabled = envFlag('QUEUE_ENABLED');

@Module({
  imports: [
    AuthModule,
    WebhookInboxModule,
    ...(queueEnabled
      ? [
          BullModule.registerQueue({ name: VERIFICATION_WEBHOOK_QUEUE }),
          BullModule.registerQueue({ name: VERIFICATION_RECONCILE_QUEUE }),
        ]
      : []),
  ],
  controllers: [KycController, KybController, VerificationController],
  providers: [
    VerificationRepository,
    VerificationService,
    KycService,
    ComplianceReviewerGuard,
    VerificationIntervalReconciler,
    ...(queueEnabled
      ? [
          VerificationWebhookProcessor,
          VerificationReconcileProcessor,
          VerificationReconcileScheduler,
        ]
      : []),
  ],
  exports: [VerificationService, VerificationRepository, KycService],
})
export class KycModule {}
