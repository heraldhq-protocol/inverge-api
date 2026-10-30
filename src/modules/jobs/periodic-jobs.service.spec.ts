import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { PeriodicJobsService } from './periodic-jobs.service';

function harness(reconcileMinutes = 10) {
  const verification = { reconcileDue: jest.fn().mockResolvedValue(undefined) };
  const deployments = {
    sweepPending: jest
      .fn()
      .mockResolvedValue({ confirmed: 0, examined: 0, feesSettled: 0 }),
  };
  const snapshots = { snapshotAllValidating: jest.fn().mockResolvedValue(0) };
  const aggregation = {
    aggregateIdeaSignals: jest.fn().mockResolvedValue({ ideas: 0 }),
    aggregateReach: jest.fn().mockResolvedValue({ resources: 0 }),
    aggregateAcquisition: jest.fn().mockResolvedValue({ resources: 0 }),
    aggregateCountries: jest.fn().mockResolvedValue({ resources: 0 }),
    aggregateCampaignFunnel: jest.fn().mockResolvedValue({ campaigns: 0 }),
  };
  const retention = {
    purge: jest.fn().mockResolvedValue({ events: 0, aggregates: 0 }),
  };
  const config = {
    get: (key: string) =>
      key === 'VERIFICATION_RECONCILE_INTERVAL_MINUTES'
        ? reconcileMinutes
        : undefined,
  } as unknown as ConfigService<Env, true>;

  const service = new PeriodicJobsService(
    config,
    verification as never,
    deployments as never,
    snapshots as never,
    aggregation as never,
    retention as never,
  );

  return { service, verification, deployments, snapshots, aggregation, retention };
}

describe('PeriodicJobsService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sweeps campaign deployments every 30 s', async () => {
    const { service, deployments } = harness();
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(61_000);
    service.onModuleDestroy();

    expect(deployments.sweepPending).toHaveBeenCalledTimes(2);
  });

  it('reconciles verification on the configured interval', async () => {
    const { service, verification } = harness(10);
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(20 * 60_000);
    service.onModuleDestroy();

    expect(verification.reconcileDue).toHaveBeenCalledTimes(2);
  });

  it('captures the daily snapshot at 03:00 UTC', async () => {
    jest.setSystemTime(new Date('2026-10-30T02:59:00.000Z'));
    const { service, snapshots } = harness();
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(59_000);
    expect(snapshots.snapshotAllValidating).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);
    service.onModuleDestroy();

    expect(snapshots.snapshotAllValidating).toHaveBeenCalledTimes(1);
  });

  it('keeps ticking after a failed run', async () => {
    const { service, deployments } = harness();
    deployments.sweepPending.mockRejectedValueOnce(new Error('RPC down'));
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(31_000);
    await jest.advanceTimersByTimeAsync(30_000);
    service.onModuleDestroy();

    expect(deployments.sweepPending).toHaveBeenCalledTimes(2);
  });

  it('stops every timer on shutdown', async () => {
    const { service, deployments, verification } = harness();
    service.onModuleInit();
    service.onModuleDestroy();

    await jest.advanceTimersByTimeAsync(60 * 60_000);

    expect(deployments.sweepPending).not.toHaveBeenCalled();
    expect(verification.reconcileDue).not.toHaveBeenCalled();
  });
});
