import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { logQueueErrors } from '../../common/queue/queue-errors';
import { Env } from '../../config/env.validation';
import { VERIFICATION_RECONCILE_QUEUE } from './verification.queue';
import { VerificationService } from './verification.service';

/**
 * Schedules reconciliation every N minutes. With Redis enabled this is a repeatable
 * BullMQ job. The queue-less companion below provides the same guarantee on an instance
 * that must not dial Redis (tests, a web-only replica).
 */
@Injectable()
export class VerificationReconcileScheduler implements OnModuleInit {
  private readonly logger = new Logger(VerificationReconcileScheduler.name);
  private readonly intervalMs: number;

  constructor(
    @InjectQueue(VERIFICATION_RECONCILE_QUEUE) private readonly queue: Queue,
    config: ConfigService<Env, true>,
  ) {
    this.intervalMs =
      config.get('VERIFICATION_RECONCILE_INTERVAL_MINUTES', { infer: true }) *
      60_000;
    logQueueErrors(queue, this.logger);
  }

  async onModuleInit() {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.queue.waitUntilReady(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('connection timed out')),
            3000,
          );
        }),
      ]);
      const enqueue = this.queue.add(
        'reconcile',
        {},
        {
          jobId: 'verification-reconcile',
          removeOnComplete: true,
          removeOnFail: 50,
          repeat: { every: this.intervalMs },
        },
      );
      void enqueue.catch(() => undefined);
      await enqueue;
      this.logger.log(
        `Scheduled verification reconciliation (every ${Math.round(
          this.intervalMs / 60_000,
        )} minutes)`,
      );
    } catch (error) {
      this.logger.warn(
        `Verification reconciliation not scheduled (Redis unavailable: ${
          (error as Error).message
        }); will schedule on next boot.`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * The queue-disabled path. A single unref'd interval means the process can still exit
 * cleanly, and it is installed only when QUEUE_ENABLED=false.
 */
@Injectable()
export class VerificationIntervalReconciler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(VerificationIntervalReconciler.name);
  private timer?: NodeJS.Timeout;

  constructor(
    config: ConfigService<Env, true>,
    private readonly verification: VerificationService,
  ) {
    const enabled = config.get('QUEUE_ENABLED', { infer: true });
    if (enabled) return;
    this.timer = setInterval(
      () => {
        void this.verification.reconcileDue().catch((error: unknown) => {
          this.logger.warn(
            `Verification reconcile failed: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
        });
      },
      config.get('VERIFICATION_RECONCILE_INTERVAL_MINUTES', { infer: true }) *
        60_000,
    );
    this.timer.unref?.();
  }

  onModuleInit() {
    if (this.timer) {
      this.logger.log('Queue disabled; verification reconciliation runs in-process.');
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
