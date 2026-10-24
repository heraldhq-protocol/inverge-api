import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { logQueueErrors } from '../../common/queue/queue-errors';
import { Env } from '../../config/env.validation';
import { ANALYTICS_QUEUE } from './analytics.processor';

// Schedules the nightly analytics pass. The stable jobId makes boot idempotent, and
// a Redis outage is time-boxed and non-fatal: the job schedules on the next boot.
@Injectable()
export class AnalyticsScheduler implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsScheduler.name);
  private readonly enabled: boolean;

  constructor(
    @InjectQueue(ANALYTICS_QUEUE) private readonly queue: Queue,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('QUEUE_ENABLED', { infer: true });
    logQueueErrors(queue, this.logger);
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.log('Queue disabled; analytics maintenance not scheduled.');
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      // BullMQ's repeatable add starts background work that rejects unhandled when
      // the lazy connection closes, so only enqueue once the queue reports ready.
      await Promise.race([
        this.queue.waitUntilReady(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('connection timed out')), 3000);
        }),
      ]);

      const enqueue = this.queue.add(
        'daily-maintenance',
        {},
        {
          repeat: { pattern: '15 4 * * *' },
          jobId: 'analytics-daily-maintenance',
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      // The enqueue can still reject after the readiness probe when the
      // connection closes. Mark it handled now; the outer catch is the verdict.
      void enqueue.catch(() => undefined);
      await enqueue;

      this.logger.log('Scheduled analytics aggregation and retention (04:15)');
    } catch (error) {
      this.logger.warn(
        `Analytics maintenance not scheduled (Redis unavailable: ${(error as Error).message}); ` +
          'will schedule on next boot with Redis reachable.',
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
