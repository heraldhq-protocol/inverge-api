import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { SnapshotScheduler } from './snapshot.scheduler';

const config = (enabled: boolean) =>
  ({
    get: (key: string) => (key === 'QUEUE_ENABLED' ? enabled : undefined),
  }) as unknown as ConfigService<Env, true>;

function queueMock() {
  return {
    add: jest.fn(),
    waitUntilReady: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    listenerCount: () => 0,
    name: 'metrics-snapshot',
  } as any;
}

describe('SnapshotScheduler (FR-204a)', () => {
  it('registers the daily repeatable job with a stable jobId', async () => {
    const queue = queueMock();
    queue.add.mockResolvedValue({});
    await new SnapshotScheduler(queue, config(true)).onModuleInit();
    expect(queue.add).toHaveBeenCalledWith(
      'daily-snapshot',
      {},
      expect.objectContaining({
        jobId: 'metrics-daily-snapshot',
        repeat: { pattern: '0 3 * * *' },
      }),
    );
  });

  it('never throws when Redis is unavailable - boot stays resilient', async () => {
    const queue = queueMock();
    queue.waitUntilReady.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      new SnapshotScheduler(queue, config(true)).onModuleInit(),
    ).resolves.toBeUndefined();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not touch the queue when queues are disabled on this instance', async () => {
    const queue = queueMock();
    await new SnapshotScheduler(queue, config(false)).onModuleInit();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
