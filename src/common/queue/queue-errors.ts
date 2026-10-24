import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

/**
 * BullMQ queues emit `error` on every failed connection attempt. Node treats an
 * EventEmitter `error` with no listener as an uncaught exception, so a Redis
 * outage would crash the process even though the schedulers already treat Redis
 * as optional.
 *
 * Attach one logger per queue. Connection retries stay owned by ioredis/BullMQ;
 * enqueue callers still time out and fall back on their own.
 */
export function logQueueErrors(queue: Queue, logger: Logger): void {
  if (queue.listenerCount('error') > 0) return;

  queue.on('error', (error: Error) => {
    logger.warn(
      `Queue ${queue.name} is unavailable (${error.message}); ` +
        'jobs will resume when Redis is reachable.',
    );
  });
}
