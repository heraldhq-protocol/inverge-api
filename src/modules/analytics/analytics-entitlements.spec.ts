import {
  analyticsEntitlement,
  hasAnalyticsFeature,
} from './analytics-entitlements';

const NOW = new Date('2026-10-25T12:00:00.000Z');

describe('analyticsEntitlement', () => {
  it('gives an admin every report without a request', () => {
    // #given an admin account
    const entitlement = analyticsEntitlement({ role: 'ADMIN', now: NOW });

    // #then premium and admin reports are available and no request is needed
    expect(entitlement).toMatchObject({
      tier: 'admin',
      premium: true,
      requestStatus: 'NOT_REQUIRED',
      canRequest: false,
    });
    expect(entitlement.features).toEqual(
      expect.arrayContaining(['summary', 'acquisition', 'admin-overview']),
    );
  });

  it('keeps an account without a grant on basic reports and offers a request', () => {
    // #given an ordinary account with no access row
    const entitlement = analyticsEntitlement({
      role: 'USER',
      creatorTier: 'STARTER',
      now: NOW,
    });

    // #then only basic reports are available and the request CTA is open
    expect(entitlement).toMatchObject({
      tier: 'basic',
      premium: false,
      requestStatus: 'NONE',
      canRequest: true,
    });
    expect(hasAnalyticsFeature(entitlement, 'summary')).toBe(true);
    expect(hasAnalyticsFeature(entitlement, 'acquisition')).toBe(false);
  });

  it('does not auto-grant premium from a creator tier', () => {
    // #given a trusted creator who has not requested access
    const entitlement = analyticsEntitlement({
      role: 'USER',
      creatorTier: 'TRUSTED',
      now: NOW,
    });

    // #then the tier is recorded but the report gate is still closed
    expect(entitlement.creatorTier).toBe('TRUSTED');
    expect(entitlement.premium).toBe(false);
    expect(entitlement.canRequest).toBe(true);
  });

  it('keeps a pending request on basic reports without a duplicate request', () => {
    // #given a pending request
    const entitlement = analyticsEntitlement({
      role: 'USER',
      access: { status: 'PENDING', source: 'REQUEST', expiresAt: null },
      now: NOW,
    });

    // #then the gate is closed and the CTA is hidden
    expect(entitlement).toMatchObject({
      tier: 'basic',
      premium: false,
      requestStatus: 'PENDING',
      canRequest: false,
    });
  });

  it('opens premium reports for an approved request', () => {
    // #given an approved request
    const entitlement = analyticsEntitlement({
      role: 'USER',
      access: { status: 'APPROVED', source: 'REQUEST', expiresAt: null },
      now: NOW,
    });

    // #then every premium report is available
    expect(entitlement).toMatchObject({
      tier: 'premium',
      premium: true,
      requestStatus: 'APPROVED',
      canRequest: false,
    });
    expect(hasAnalyticsFeature(entitlement, 'campaign-funnel')).toBe(true);
  });

  it('treats a paid grant like any other approval until it expires', () => {
    // #given a paid-through grant
    const active = analyticsEntitlement({
      role: 'USER',
      access: {
        status: 'APPROVED',
        source: 'PAID',
        expiresAt: new Date('2026-11-25T12:00:00.000Z'),
      },
      now: NOW,
    });

    // #then the report gate does not know how access was paid for
    expect(active.premium).toBe(true);
    expect(active.requestStatus).toBe('APPROVED');
  });

  it('reopens the request CTA after a paid grant expires', () => {
    // #given a grant that expired yesterday
    const entitlement = analyticsEntitlement({
      role: 'USER',
      access: {
        status: 'APPROVED',
        source: 'PAID',
        expiresAt: new Date('2026-10-24T12:00:00.000Z'),
      },
      now: NOW,
    });

    // #then the reports close and the account may request again
    expect(entitlement).toMatchObject({
      tier: 'basic',
      premium: false,
      requestStatus: 'EXPIRED',
      canRequest: true,
    });
  });

  it('allows a rejected account to ask again', () => {
    // #given a rejected request
    const entitlement = analyticsEntitlement({
      role: 'USER',
      access: { status: 'REJECTED', source: 'REQUEST', expiresAt: null },
      now: NOW,
    });

    // #then the gate is closed but a new request is allowed
    expect(entitlement).toMatchObject({
      tier: 'basic',
      premium: false,
      requestStatus: 'REJECTED',
      canRequest: true,
    });
  });

  it('reports availability separately from entitlement', () => {
    // #given an operator-disabled read surface
    const on = analyticsEntitlement({ role: 'USER', now: NOW });
    const off = analyticsEntitlement({
      role: 'USER',
      available: false,
      now: NOW,
    });

    // #then the entitlement is unchanged but the UI can hide the surface
    expect(on.available).toBe(true);
    expect(off).toMatchObject({
      available: false,
      tier: 'basic',
      premium: false,
      canRequest: true,
    });
  });

  it('keeps an admin entitlement when reads are disabled', () => {
    // #given an admin and a disabled read surface
    const entitlement = analyticsEntitlement({
      role: 'ADMIN',
      available: false,
      now: NOW,
    });

    // #then the recorded entitlement is intact and availability is false
    expect(entitlement).toMatchObject({
      available: false,
      tier: 'admin',
      premium: true,
      requestStatus: 'NOT_REQUIRED',
    });
  });
});
