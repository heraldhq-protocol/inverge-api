import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { JOBS_QUEUE, JOB_NAMES } from '../../common/queue/job-names';
import { AnalyticsIngestProcessor } from '../analytics/analytics-ingest.processor';
import type { AnalyticsIngestJobData } from '../analytics/analytics-ingest.job';
import { NotificationDispatchProcessor } from '../notifications/notification-dispatch.processor';
import type { NotificationDispatchJob } from '../notifications/notification-dispatch.contract';
import { VerificationWebhookProcessor } from '../kyc/verification.processor';
import type { VerificationWebhookJob } from '../kyc/verification.queue';

/**
 * A single BullMQ Worker for the whole application.
 *
 * BullMQ polls: an idle Worker re-arms a blocking read on the queue marker every
 * `drainDelay` seconds and re-runs the stalled-check script on `stalledInterval`.
 * Upstash bills those as commands, so the defaults (5 s, 30 s) cost ~37k commands
 * per Worker per day — the reason the free tier ran out. Hence:
 *
 * - one Worker, not one per job family;
 * - `drainDelay` 30 s and `stalledInterval` 5 min, which put an idle Worker at
 *   ~6k commands/day;
 * - no repeatable jobs in Redis (see `PeriodicJobsService`): while any delayed
 *   job is pending, BullMQ caps its blocking read at 10 s
 *   (`maximumBlockTimeout` in `bullmq/classes/worker.js`) and the saving vanishes.
 *
 * `concurrency` does not change the idle cost — the blocking read is per Worker
 * and is serialised — so it stays high enough that one slow provider call does
 * not park every notification behind it.
 */
export const JOB_WORKER_OPTIONS = {
  concurrency: 4,
  drainDelay: 30,
  stalledInterval: 300_000,
};

@Injectable()
@Processor(JOBS_QUEUE, JOB_WORKER_OPTIONS)
export class JobsProcessor extends WorkerHost {
  private readonly logger = new Logger(JobsProcessor.name);

  constructor(
    private readonly verificationWebhook: VerificationWebhookProcessor,
    private readonly analyticsIngest: AnalyticsIngestProcessor,
    private readonly notifications: NotificationDispatchProcessor,
  ) {
    super();
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.warn(
      `Job worker is unavailable (${error.message}); queued work resumes when Redis is reachable.`,
    );
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB_NAMES.verificationWebhook:
        return this.verificationWebhook.process(job as Job<VerificationWebhookJob>);
      case JOB_NAMES.analyticsIngest:
        return this.analyticsIngest.process(job as Job<AnalyticsIngestJobData>);
      case JOB_NAMES.notificationDispatch:
        return this.notifications.process(job as Job<NotificationDispatchJob>);
      default:
        // A job name nobody handles would otherwise be retried forever.
        throw new UnrecoverableError(`Unknown job name "${job.name}"`);
    }
  }
}
