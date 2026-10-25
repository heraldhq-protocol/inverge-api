import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsRetentionService } from './analytics-retention.service';

function setup() {
  const deleteEvents = jest.fn().mockReturnValue('events-op');
  const deleteSignals = jest.fn().mockReturnValue('signals-op');
  const deleteReach = jest.fn().mockReturnValue('reach-op');
  const deleteAcquisition = jest.fn().mockReturnValue('acquisition-op');
  const deleteCountries = jest.fn().mockReturnValue('countries-op');
  const deleteFunnel = jest.fn().mockReturnValue('funnel-op');
  const prisma = {
    productAnalyticsEvent: { deleteMany: deleteEvents },
    ideaSignalDailyMetric: { deleteMany: deleteSignals },
    resourceReachDailyMetric: { deleteMany: deleteReach },
    resourceAcquisitionDailyMetric: { deleteMany: deleteAcquisition },
    resourceCountryDailyMetric: { deleteMany: deleteCountries },
    campaignFunnelDailyMetric: { deleteMany: deleteFunnel },
    $transaction: jest
      .fn()
      .mockResolvedValue([
        { count: 4 },
        { count: 2 },
        { count: 3 },
        { count: 1 },
        { count: 1 },
        { count: 1 },
      ]),
  } as unknown as PrismaService;
  const config = {
    get: jest.fn((key: keyof Env) =>
      key === 'ANALYTICS_RAW_RETENTION_DAYS' ? 90 : 25,
    ),
  } as unknown as ConfigService<Env, true>;

  return {
    svc: new AnalyticsRetentionService(prisma, config),
    deleteEvents,
    deleteSignals,
    deleteReach,
    deleteAcquisition,
    deleteCountries,
    deleteFunnel,
  };
}

describe('AnalyticsRetentionService', () => {
  it('deletes raw events and whole aggregate months at their cutoffs', async () => {
    // #given the configured retention windows
    const {
      svc,
      deleteEvents,
      deleteSignals,
      deleteReach,
      deleteAcquisition,
      deleteCountries,
      deleteFunnel,
    } = setup();

    // #when the purge runs
    const result = await svc.purge(new Date('2026-10-22T00:00:00.000Z'));

    // #then every aggregate store is bounded and the counts are reported
    expect(result).toEqual({ events: 4, aggregates: 8 });
    expect(deleteEvents).toHaveBeenCalledWith({
      where: { receivedAt: { lt: new Date('2026-07-24T00:00:00.000Z') } },
    });
    for (const remove of [
      deleteSignals,
      deleteReach,
      deleteAcquisition,
      deleteCountries,
      deleteFunnel,
    ]) {
      expect(remove).toHaveBeenCalledWith({
        where: { day: { lt: new Date('2024-09-01T00:00:00.000Z') } },
      });
    }
  });
});
