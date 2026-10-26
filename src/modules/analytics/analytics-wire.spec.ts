import {
  CLIENT_INGEST_WIRE_NAMES,
  CONFIRMED_WIRE_NAMES,
  isClientIngestWireName,
  isConfirmedWireName,
  toInternalEventName,
  wireEventToInput,
} from './analytics-wire';

describe('analytics wire vocabulary', () => {
  it('maps every client name to an internal event name', () => {
    // #given the closed client list
    // #when each name is translated
    // #then none is missing or duplicated
    const internal = CLIENT_INGEST_WIRE_NAMES.map(toInternalEventName);
    expect(internal).toEqual([
      'PAGE_VIEWED',
      'IDEA_VIEWED',
      'CAMPAIGN_VIEWED',
      'CAMPAIGN_STEP_STARTED',
      'CAMPAIGN_STEP_COMPLETED',
      'SEARCH_PERFORMED',
    ]);
    expect(new Set(internal).size).toBe(internal.length);
  });

  it('never accepts a confirmed outcome on the client route', () => {
    // #given the names the product brief reserves for the domain
    // #when each is checked against the client allowlist
    // #then none can be ingested
    for (const name of CONFIRMED_WIRE_NAMES) {
      expect(isClientIngestWireName(name)).toBe(false);
      expect(isConfirmedWireName(name)).toBe(true);
    }
  });

  it('rejects an unknown name from both lists', () => {
    expect(isClientIngestWireName('idea_deleted')).toBe(false);
    expect(isConfirmedWireName('idea_deleted')).toBe(false);
  });

  it('keeps views in the client list and confirmations out', () => {
    expect(isClientIngestWireName('idea_viewed')).toBe(true);
    expect(isClientIngestWireName('idea_supported')).toBe(false);
    expect(isClientIngestWireName('feedback_submitted')).toBe(false);
    expect(isClientIngestWireName('campaign_backing_completed')).toBe(false);
  });

  it('translates a wire event without dropping its fields', () => {
    // #given a wire event with an idempotency key and coarse geography
    const input = wireEventToInput({
      eventKey: 'view-1',
      name: 'idea_viewed',
      occurredAt: new Date('2026-10-25T12:00:00.000Z'),
      sessionId: 'session-1',
      ideaId: 'idea-1',
      source: 'feed',
      countryCode: 'NG',
    });

    // #then the internal name is used and the rest is preserved
    expect(input).toMatchObject({
      eventKey: 'view-1',
      name: 'IDEA_VIEWED',
      sessionId: 'session-1',
      ideaId: 'idea-1',
      source: 'feed',
      countryCode: 'NG',
    });
  });
});
