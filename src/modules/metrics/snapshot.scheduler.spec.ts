import { SnapshotScheduler } from './snapshot.scheduler';

describe('SnapshotScheduler (FR-204a)', () => {
  it('registers the daily repeatable job with a stable jobId', async () => {
    const queue = { add: jest.fn().mockResolvedValue({}) } as any;
    await new SnapshotScheduler(queue).onModuleInit();
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
    await expect(new SnapshotScheduler(queue).onModuleInit()).resolves.toBeUndefined();
  });
});
