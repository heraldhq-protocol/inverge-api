import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { VerificationService } from './verification.service';
import type { VerificationWebhookJob } from './verification.queue';

// Contains no business logic: it unpacks a bounded payload and calls the domain
// service. A provider call therefore never happens inside the HTTP request that
// acknowledges a webhook. `JobsProcessor` owns the only Worker; this class is the
// handler behind one job name.
@Injectable()
export class VerificationWebhookProcessor {
  private readonly logger = new Logger(VerificationWebhookProcessor.name);

  constructor(private readonly verification: VerificationService) {}

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
