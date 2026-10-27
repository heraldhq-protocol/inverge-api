import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AnalyticsIngestService } from './analytics-ingest.service';
import { ProductAnalyticsService } from './product-analytics.service';

// Relative to the test run so the retention window never expires.
const OCCURRED_AT = new Date(Date.now() - 60_000).toISOString();

function view(overrides: Record<string, unknown> = {}) {
  return {
    eventKey: 'view-1',
    name: 'idea_viewed',
    occurredAt: OCCURRED_AT,
    sessionId: 'session-1',
    ideaId: 'idea-1',
    source: 'feed',
    countryCode: 'NG',
    ...overrides,
  };
}

function setup(persisted = 1, queue?: { add: jest.Mock }) {
  const analytics = {
    persistBatch: jest.fn().mockResolvedValue(persisted),
  } as unknown as ProductAnalyticsService;
  return {
    service: new AnalyticsIngestService(analytics, queue as never),
    persistBatch: analytics.persistBatch as jest.Mock,
  };
}

describe('AnalyticsIngestService', () => {
  it('rejects a batch larger than the cap', async () => {
    // #given 51 events
    const { service, persistBatch } = setup();

    // #when the batch is ingested
    // #then it is refused before any validation or write
    await expect(
      service.ingest(Array.from({ length: 51 }, () => view())),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(persistBatch).not.toHaveBeenCalled();
  });

  it('accepts exactly the batch cap', async () => {
    // #given 50 valid events
    const { service, persistBatch } = setup(50);

    // #when the batch is ingested
    const result = await service.ingest(
      Array.from({ length: 50 }, (_, index) =>
        view({ eventKey: `view-${index}` }),
      ),
    );

    // #then all are written in one call
    expect(result).toMatchObject({ accepted: 50, persisted: 50 });
    expect(persistBatch).toHaveBeenCalledTimes(1);
  });

  it('reports the index and reason of each invalid event', async () => {
    // #given one valid view and one confirmed outcome
    const { service } = setup();

    // #when the batch is ingested
    const result = await service.ingest([
      view(),
      view({ eventKey: 'signal-1', name: 'idea_supported' }),
    ]);

    // #then the valid event is written and the other is rejected by index
    expect(result).toMatchObject({ received: 2, accepted: 1, persisted: 1 });
    expect(result.rejected).toEqual([
      {
        index: 1,
        reason: 'confirmed events are emitted by the domain, not ingested',
      },
    ]);
  });

  it('writes nothing when every event is invalid', async () => {
    // #given only confirmed outcomes
    const { service, persistBatch } = setup();

    // #when the batch is ingested
    const result = await service.ingest([
      view({ name: 'campaign_backing_completed' }),
    ]);

    // #then the response is a no-op with no queue or write
    expect(result).toMatchObject({
      received: 1,
      accepted: 0,
      persisted: 0,
      duplicates: 0,
      queued: false,
    });
    expect(result.rejected).toHaveLength(1);
    expect(persistBatch).not.toHaveBeenCalled();
  });

  it('rejects a view without an idempotency key', async () => {
    // #given an event with no eventKey
    const { service } = setup();

    // #when the batch is ingested
    const result = await service.ingest([view({ eventKey: undefined })]);

    // #then the missing key is reported
    expect(result.rejected[0]).toMatchObject({
      index: 0,
      reason: 'eventKey is required',
    });
  });

  it('rejects a non-ISO timestamp', async () => {
    // #given an unparseable occurredAt
    const { service } = setup();

    // #when the batch is ingested
    const result = await service.ingest([
      view({ occurredAt: 'not-a-date' }),
    ]);

    // #then it is rejected
    expect(result.rejected[0]).toMatchObject({
      index: 0,
      reason: 'occurredAt must be an ISO timestamp',
    });
  });

  it('rejects an undeclared free-text field', async () => {
    // #given an event carrying an email
    const { service, persistBatch } = setup();

    // #when the batch is ingested
    const result = await service.ingest([view({ email: 'person@example.com' })]);

    // #then the closed taxonomy refuses it before persistence
    expect(result.accepted).toBe(0);
    expect(result.rejected[0].reason).toContain(
      'email is not a field of IDEA_VIEWED',
    );
    expect(persistBatch).not.toHaveBeenCalled();
  });

  it('queues JSON-safe events when a queue is configured', async () => {
    // #given a working ingest queue
    const add = jest.fn().mockResolvedValue({});
    const { service, persistBatch } = setup(1, { add });

    // #when the batch is ingested
    const result = await service.ingest([view()]);

    // #then it is queued rather than written inline
    expect(result).toMatchObject({
      accepted: 1,
      persisted: 0,
      queued: true,
    });
    expect(persistBatch).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(
      'ingest',
      {
        events: [
          expect.objectContaining({
            eventKey: 'view-1',
            name: 'IDEA_VIEWED',
            occurredAt: OCCURRED_AT,
          }),
        ],
      },
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it('falls back to an inline write when the queue rejects', async () => {
    // #given a queue that cannot reach Redis
    const add = jest.fn().mockRejectedValue(new Error('redis down'));
    const { service, persistBatch } = setup(1, { add });

    // #when the batch is ingested
    const result = await service.ingest([view()]);

    // #then the event is still persisted
    expect(result).toMatchObject({
      accepted: 1,
      persisted: 1,
      queued: false,
    });
    expect(persistBatch).toHaveBeenCalledTimes(1);
  });

  it('counts replayed keys as duplicates rather than failures', async () => {
    // #given a batch whose keys already exist
    const { service } = setup(0);

    // #when two valid events are written
    const result = await service.ingest([
      view({ eventKey: 'view-a' }),
      view({ eventKey: 'view-b' }),
    ]);

    // #then both are accepted and both are reported as duplicates
    expect(result).toMatchObject({
      accepted: 2,
      persisted: 0,
      duplicates: 2,
      rejected: [],
    });
  });

  it('surfaces a persistence outage as 503', async () => {
    // #given a store that is down
    const { service, persistBatch } = setup();
    persistBatch.mockRejectedValueOnce(new Error('connection refused'));

    // #when the batch is written
    // #then the caller can retry instead of losing the batch silently
    await expect(service.ingest([view()])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
