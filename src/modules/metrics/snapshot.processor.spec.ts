import { SnapshotProcessor } from './snapshot.processor';

describe('SnapshotProcessor (FR-204a daily job)', () => {
  it('captures snapshots via MetricsService and reports the count', async () => {
    const metrics = { snapshotAllValidating: jest.fn().mockResolvedValue(3) } as any;
    const proc = new SnapshotProcessor(metrics);
    const res = await proc.process({} as any);
    expect(metrics.snapshotAllValidating).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ captured: 3 });
  });
});
