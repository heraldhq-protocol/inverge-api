import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
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
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.log('Queue disabled; analytics maintenance not scheduled.');
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.queue.add(
          'daily-maintenance',
          {},
          {
            repeat: { pattern: '15 4 * * *' },
            jobId: 'analytics-daily-maintenance',
            removeOnComplete: true,
            removeOnFail: 100,
          },
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('enqueue timed out')), 3000);
        }),
      ]);
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
