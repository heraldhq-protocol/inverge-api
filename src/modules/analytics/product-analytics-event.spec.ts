import {
  assertProductAnalyticsEvent,
  ProductAnalyticsEventInput,
} from './product-analytics-event';

const NOW = new Date('2026-10-22T12:00:00.000Z');

const signal = (overrides: Partial<ProductAnalyticsEventInput> = {}) =>
  ({
    name: 'IDEA_SIGNAL',
    occurredAt: NOW,
    userId: 'user-1',
    ideaId: 'idea-1',
    signalType: 'SUPPORT',
    ...overrides,
  }) as ProductAnalyticsEventInput;

describe('assertProductAnalyticsEvent', () => {
  it('accepts a server-authored signal event', () => {
    expect(() => assertProductAnalyticsEvent(signal(), NOW)).not.toThrow();
  });

  it('rejects an event older than the raw retention window', () => {
    const stale = new Date(NOW.getTime() - 91 * 24 * 60 * 60 * 1000);

    expect(() =>
      assertProductAnalyticsEvent(signal({ occurredAt: stale }), NOW),
    ).toThrow(/older than the retention window/);
  });

  it('rejects a future clock value beyond the skew allowance', () => {
    const future = new Date(NOW.getTime() + 6 * 60 * 1000);

    expect(() =>
      assertProductAnalyticsEvent(signal({ occurredAt: future }), NOW),
    ).toThrow(/future/);
  });

  it('never mixes an authenticated and an anonymous subject', () => {
    expect(() =>
      assertProductAnalyticsEvent(signal({ sessionId: 'session-1' }), NOW),
    ).toThrow(/either authenticated or anonymous/);
  });

  it('rejects a field the event name does not declare', () => {
    const withEmail = {
      ...signal(),
      email: 'someone@example.com',
    } as unknown as ProductAnalyticsEventInput;

    expect(() => assertProductAnalyticsEvent(withEmail, NOW)).toThrow(
      /email is not a field of IDEA_SIGNAL/,
    );
  });

  it('requires a signal type and an idea for a signal', () => {
    expect(() => assertProductAnalyticsEvent(signal({ ideaId: undefined }), NOW)).toThrow(
      /ideaId/,
    );
    expect(() =>
      assertProductAnalyticsEvent(signal({ signalType: undefined }), NOW),
    ).toThrow(/signalType/);
  });

  it('requires an authenticated user for a signal', () => {
    expect(() =>
      assertProductAnalyticsEvent(signal({ userId: undefined }), NOW),
    ).toThrow(/authenticated/);
  });

  it('accepts a search event with structural fields only', () => {
    expect(() =>
      assertProductAnalyticsEvent(
        {
          name: 'SEARCH_PERFORMED',
          occurredAt: NOW,
          queryLength: 12,
          resultCount: 8,
          filterKeys: ['category', 'region'],
        },
        NOW,
      ),
    ).not.toThrow();
  });

  it('rejects a free-text search query', () => {
    const withQuery = {
      name: 'SEARCH_PERFORMED',
      occurredAt: NOW,
      queryLength: 12,
      resultCount: 8,
      query: 'my home address',
    } as unknown as ProductAnalyticsEventInput;

    expect(() => assertProductAnalyticsEvent(withQuery, NOW)).toThrow(
      /query is not a field/,
    );
  });

  it('requires an amount and currency for a confirmed contribution', () => {
    expect(() =>
      assertProductAnalyticsEvent(
        {
          name: 'CONTRIBUTION_CONFIRMED',
          occurredAt: NOW,
          campaignId: 'campaign-1',
          amountMinor: 5000n,
          currency: 'usd',
        },
        NOW,
      ),
    ).toThrow(/currency/);
  });

  it('accepts only an uppercase ISO country code', () => {
    expect(() =>
      assertProductAnalyticsEvent(signal({ countryCode: 'ng' }), NOW),
    ).toThrow(/countryCode/);
    expect(() =>
      assertProductAnalyticsEvent(signal({ countryCode: 'NG' }), NOW),
    ).not.toThrow();
  });
});
