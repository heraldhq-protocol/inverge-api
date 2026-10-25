import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsAggregationService } from './analytics-aggregation.service';

describe('AnalyticsAggregationService', () => {
  it('merges signal counts and unique actors into one idempotent row per idea', async () => {
    // #given a day of raw signal events for two ideas
    const groupBy = jest.fn().mockResolvedValue([
      { ideaId: 'idea-1', signalType: 'SUPPORT', _count: { _all: 3 } },
      { ideaId: 'idea-1', signalType: 'PRE_PLEDGE', _count: { _all: 1 } },
      { ideaId: 'idea-2', signalType: 'SUPPORT', _count: { _all: 1 } },
    ]);
    const findMany = jest.fn().mockResolvedValue([
      { ideaId: 'idea-1', userId: 'a' },
      { ideaId: 'idea-1', userId: 'b' },
      { ideaId: 'idea-1', userId: 'c' },
      { ideaId: 'idea-2', userId: 'a' },
    ]);
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = {
      productAnalyticsEvent: { groupBy, findMany },
      ideaSignalDailyMetric: { upsert },
      $transaction: jest.fn().mockResolvedValue([]),
    } as unknown as PrismaService;
    const service = new AnalyticsAggregationService(prisma);

    // #when the day is aggregated
    const result = await service.aggregateIdeaSignals('2026-10-21');

    // #then each idea gets an upsert keyed by (ideaId, day)
    expect(result).toEqual({ day: '2026-10-21', ideas: 2 });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ideaId_day: {
            ideaId: 'idea-1',
            day: new Date('2026-10-21T00:00:00.000Z'),
          },
        },
        update: { supportCount: 3, prePledgeCount: 1, uniqueActors: 3 },
      }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { supportCount: 1, prePledgeCount: 0, uniqueActors: 1 },
      }),
    );
  });

  it('scopes the aggregation to one UTC day and to signal events', async () => {
    // #given an empty day
    const groupBy = jest.fn().mockResolvedValue([]);
    const prisma = {
      productAnalyticsEvent: { groupBy, findMany: jest.fn().mockResolvedValue([]) },
      ideaSignalDailyMetric: { upsert: jest.fn() },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    const service = new AnalyticsAggregationService(prisma);

    // #when it is aggregated
    await service.aggregateIdeaSignals('2026-10-21');

    // #then the query is half-open and name-scoped
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: 'IDEA_SIGNAL',
          occurredAt: {
            gte: new Date('2026-10-21T00:00:00.000Z'),
            lt: new Date('2026-10-22T00:00:00.000Z'),
          },
        }),
      }),
    );
  });
});
