import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { SnapshotScheduler } from './snapshot.scheduler';

const config = (enabled: boolean) =>
  ({
    get: (key: string) => (key === 'QUEUE_ENABLED' ? enabled : undefined),
  }) as unknown as ConfigService<Env, true>;

describe('SnapshotScheduler (FR-204a)', () => {
  it('registers the daily repeatable job with a stable jobId', async () => {
    const queue = { add: jest.fn().mockResolvedValue({}) } as any;
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

  it('never throws when Redis is unavailable — boot stays resilient', async () => {
    const queue = { add: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as any;
    await expect(
      new SnapshotScheduler(queue, config(true)).onModuleInit(),
    ).resolves.toBeUndefined();
  });

  it('does not touch the queue when queues are disabled on this instance', async () => {
    const queue = { add: jest.fn() } as any;
    await new SnapshotScheduler(queue, config(false)).onModuleInit();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
