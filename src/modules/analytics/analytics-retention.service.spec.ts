import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsRetentionService } from './analytics-retention.service';

function setup() {
  const deleteEvents = jest.fn().mockReturnValue('events-op');
  const deleteAggregates = jest.fn().mockReturnValue('aggregates-op');
  const prisma = {
    productAnalyticsEvent: { deleteMany: deleteEvents },
    ideaSignalDailyMetric: { deleteMany: deleteAggregates },
    $transaction: jest.fn().mockResolvedValue([{ count: 4 }, { count: 2 }]),
  } as unknown as PrismaService;
  const config = {
    get: jest.fn((key: keyof Env) =>
      key === 'ANALYTICS_RAW_RETENTION_DAYS' ? 90 : 25,
    ),
  } as unknown as ConfigService<Env, true>;

  return {
    svc: new AnalyticsRetentionService(prisma, config),
    deleteEvents,
    deleteAggregates,
  };
}

describe('AnalyticsRetentionService', () => {
  it('deletes raw events and whole aggregate months at their cutoffs', async () => {
    // #given the configured retention windows
    const { svc, deleteEvents, deleteAggregates } = setup();

    // #when the purge runs
    const result = await svc.purge(new Date('2026-10-22T00:00:00.000Z'));

    // #then both stores are bounded and the counts are reported
    expect(result).toEqual({ events: 4, aggregates: 2 });
    expect(deleteEvents).toHaveBeenCalledWith({
      where: { receivedAt: { lt: new Date('2026-07-24T00:00:00.000Z') } },
    });
    expect(deleteAggregates).toHaveBeenCalledWith({
      where: { day: { lt: new Date('2024-09-01T00:00:00.000Z') } },
    });
  });
});
