import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { logQueueErrors } from '../../common/queue/queue-errors';
import { Env } from '../../config/env.validation';
import { SNAPSHOT_QUEUE } from './snapshot.processor';

// Registers the daily repeatable snapshot job (FR-204a). A stable jobId means the
// repeatable is idempotent across restarts — booting many times never stacks duplicates.
@Injectable()
export class SnapshotScheduler implements OnModuleInit {
  private readonly logger = new Logger(SnapshotScheduler.name);
  private readonly enabled: boolean;

  constructor(
    @InjectQueue(SNAPSHOT_QUEUE) private readonly queue: Queue,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('QUEUE_ENABLED', { infer: true });
    logQueueErrors(queue, this.logger);
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.log('Queue disabled; daily snapshot not scheduled on this instance.');
      return;
    }

    // Best-effort: a Redis outage must never crash or hang boot (the idea-validation
    // flow runs without Redis). BullMQ's repeatable add starts background work that
    // rejects unhandled when the lazy connection closes, so only enqueue once the
    // queue reports ready. A failed probe is the caller's answer: skip this boot.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.queue.waitUntilReady(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('connection timed out')), 3000);
        }),
      ]);

      const enqueue = this.queue.add(
        'daily-snapshot',
        {},
        {
          repeat: { pattern: '0 3 * * *' }, // 03:00 daily — one snapshot/day feeds the consecutive-day check
          jobId: 'metrics-daily-snapshot',
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      // The enqueue can still reject after the readiness probe when the
      // connection closes. Mark it handled now; the outer catch is the verdict.
      void enqueue.catch(() => undefined);
      await enqueue;

      this.logger.log('Scheduled daily idea metric snapshot (03:00)');
    } catch (e) {
      this.logger.warn(
        `Daily snapshot not scheduled (Redis unavailable: ${(e as Error).message}); ` +
          'will schedule on next boot with Redis reachable.',
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
