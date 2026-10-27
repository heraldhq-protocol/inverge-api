import { PrismaService } from '../../prisma/prisma.service';
import { ProductAnalyticsService } from './product-analytics.service';

function setup(create: jest.Mock) {
  const prisma = {
    productAnalyticsEvent: { create },
  } as unknown as PrismaService;
  return new ProductAnalyticsService(prisma);
}

const valid = {
  name: 'IDEA_SIGNAL' as const,
  occurredAt: new Date(),
  userId: 'user-1',
  ideaId: 'idea-1',
  signalType: 'PRE_PLEDGE' as const,
};

describe('ProductAnalyticsService', () => {
  it('persists a valid event with the default empty filter keys', async () => {
    // #given a working store
    const create = jest.fn().mockResolvedValue({});
    const service = setup(create);

    // #when an internal caller records a signal
    const recorded = await service.record(valid);

    // #then the row is written and the call reports success
    expect(recorded).toBe(true);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ...valid,
        eventKey: expect.any(String),
        schemaVersion: 1,
        resourceType: 'IDEA',
        resourceId: 'idea-1',
        filterKeys: [],
      }),
    });
  });

  it('drops an invalid event instead of throwing to the caller', async () => {
    // #given a store that must not be touched
    const create = jest.fn();
    const service = setup(create);

    // #when the event is missing its subject
    const recorded = await service.record({ ...valid, userId: undefined });

    // #then the failure is swallowed and nothing is persisted
    expect(recorded).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('drops a store failure without failing the domain action', async () => {
    // #given a store that is down
    const create = jest.fn().mockRejectedValue(new Error('connection refused'));
    const service = setup(create);

    // #when a valid event cannot be written
    const recorded = await service.record(valid);

    // #then the caller sees a dropped event, not an exception
    expect(recorded).toBe(false);
  });

  it('stores no raw IP, user agent or free-text column', async () => {
    // #given a valid event
    const create = jest.fn().mockResolvedValue({});
    const service = setup(create);

    // #when it is persisted
    await service.record(valid);

    // #then the write carries only the declared taxonomy fields
    const payload = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(payload).not.toHaveProperty('ip');
    expect(payload).not.toHaveProperty('userAgent');
    expect(payload).not.toHaveProperty('email');
    expect(payload).not.toHaveProperty('walletAddress');
  });
});
