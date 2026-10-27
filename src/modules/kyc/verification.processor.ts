import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { VerificationService } from './verification.service';
import {
  VERIFICATION_RECONCILE_QUEUE,
  VERIFICATION_WEBHOOK_QUEUE,
  type VerificationWebhookJob,
} from './verification.queue';

// Both workers contain no business logic: they unpack a bounded payload and call the
// domain service. A provider call therefore never happens inside the HTTP request that
// acknowledges a webhook.

@Processor(VERIFICATION_WEBHOOK_QUEUE)
export class VerificationWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(VerificationWebhookProcessor.name);

  constructor(private readonly verification: VerificationService) {
    super();
  }

  async process(job: Job<VerificationWebhookJob>) {
    try {
      return await this.verification.processWebhookJob(job.data);
    } catch (error) {
      this.logger.warn(
        `Verification webhook job ${job.id ?? 'unknown'} failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw error;
    }
  }
}

@Processor(VERIFICATION_RECONCILE_QUEUE)
export class VerificationReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(VerificationReconcileProcessor.name);

  constructor(private readonly verification: VerificationService) {
    super();
  }

  async process() {
    return this.verification.reconcileDue();
  }
}
