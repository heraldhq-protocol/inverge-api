import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { Queue } from 'bullmq';
import { logQueueErrors } from './queue-errors';

function fakeQueue() {
  const emitter = new EventEmitter() as unknown as Queue;
  Object.defineProperty(emitter, 'name', { value: 'test-queue' });
  return emitter;
}

describe('logQueueErrors', () => {
  it('logs a Redis outage instead of letting Node throw the error event', () => {
    const queue = fakeQueue();
    const logger = { warn: jest.fn() } as unknown as Logger;

    logQueueErrors(queue, logger);
    expect(() => queue.emit('error', new Error('ECONNREFUSED'))).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      'Queue test-queue is unavailable (ECONNREFUSED); ' +
        'jobs will resume when Redis is reachable.',
    );
  });

  it('does not stack duplicate listeners when two providers share a queue', () => {
    const queue = fakeQueue();
    const logger = { warn: jest.fn() } as unknown as Logger;

    logQueueErrors(queue, logger);
    logQueueErrors(queue, logger);
    queue.emit('error', new Error('ECONNREFUSED'));

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
