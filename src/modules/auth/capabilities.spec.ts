import { buildAccountCapabilities, CapabilityInput } from './capabilities';
import { analyticsEntitlement } from '../analytics/analytics-entitlements';

const NOW = new Date('2026-10-22T12:00:00.000Z');

const base = (overrides: Partial<CapabilityInput> = {}): CapabilityInput => ({
  role: 'USER',
  bannedAt: null,
  kycStatus: 'NOT_REQUIRED',
  amlStatus: 'NOT_SCREENED',
  displayName: 'Ada',
  username: 'ada',
  emailVerified: true,
  ...overrides,
});

describe('buildAccountCapabilities', () => {
  it('keeps verified-email actions available before identity verification', () => {
    // #given an email-verified account with no KYC
    const caps = buildAccountCapabilities(base(), NOW);

    // #then authored actions are allowed but campaign submission is not
    expect(caps.capabilities).toMatchObject({
      createIdeas: true,
      supportIdeas: true,
      prePledge: true,
      commentOnIdeas: true,
      purchaseBoosts: true,
      submitCampaigns: false,
    });
  });

  it('allows support and pre-pledges but gates other writes on email verification', () => {
    // #given an account that has not verified an email
    const caps = buildAccountCapabilities(base({ emailVerified: false }), NOW);

    // #then the demand signal stays open; authored and financial actions do not
    expect(caps.verification.emailVerified).toBe(false);
    expect(caps.capabilities).toMatchObject({
      createIdeas: false,
      supportIdeas: true,
      prePledge: true,
      commentOnIdeas: false,
      submitSurveyResponses: false,
      purchaseBoosts: false,
      submitCampaigns: false,
    });
  });

  it('lists the KYC and AML blockers that stop campaign submission', () => {
    // #given an unverified account
    const caps = buildAccountCapabilities(base(), NOW);

    // #then both outstanding checks are surfaced
    expect(caps.verification).toEqual({
      emailVerified: true,
      identityVerified: false,
      fundsEligible: false,
      blockers: [
        'Identity verification (KYC) is required',
        'AML screening is required',
      ],
    });
  });

  it('allows campaign submission only when identity and AML both clear', () => {
    // #given a fully verified account
    const caps = buildAccountCapabilities(
      base({ kycStatus: 'VERIFIED', amlStatus: 'CLEAR' }),
      NOW,
    );

    // #then the funds bar is met and no blockers remain
    expect(caps.verification).toEqual({
      emailVerified: true,
      identityVerified: true,
      fundsEligible: true,
      blockers: [],
    });
    expect(caps.capabilities.submitCampaigns).toBe(true);
  });

  it('keeps an AML flag visible even when identity is verified', () => {
    // #given KYC cleared but AML flagged
    const caps = buildAccountCapabilities(
      base({ kycStatus: 'VERIFIED', amlStatus: 'FLAGGED' }),
      NOW,
    );

    // #then identity is true, funds eligibility is not
    expect(caps.verification.identityVerified).toBe(true);
    expect(caps.verification.fundsEligible).toBe(false);
    expect(caps.verification.blockers).toEqual([
      'AML screening flagged this account',
    ]);
  });

  it('grants admin capabilities only to ADMIN', () => {
    // #given the same verified account under both roles
    const user = buildAccountCapabilities(
      base({ kycStatus: 'VERIFIED', amlStatus: 'CLEAR', role: 'USER' }),
      NOW,
    );
    const admin = buildAccountCapabilities(
      base({ kycStatus: 'VERIFIED', amlStatus: 'CLEAR', role: 'ADMIN' }),
      NOW,
    );

    // #then only the admin may review, moderate or manage the platform
    expect(user.capabilities).toMatchObject({
      reviewCampaigns: false,
      moderateContent: false,
      managePlatform: false,
    });
    expect(admin.capabilities).toMatchObject({
      reviewCampaigns: true,
      moderateContent: true,
      managePlatform: true,
    });
  });

  it('requires onboarding until both display name and username exist', () => {
    // #given profiles with one or both fields missing
    const complete = buildAccountCapabilities(base(), NOW);
    const noUsername = buildAccountCapabilities(base({ username: null }), NOW);
    const noProfile = buildAccountCapabilities(
      base({ displayName: null, username: null }),
      NOW,
    );

    // #then only the complete profile is ready
    expect(complete.requiresOnboarding).toBe(false);
    expect(noUsername.requiresOnboarding).toBe(true);
    expect(noProfile.requiresOnboarding).toBe(true);
  });

  it('reports a suspended account as inactive without hiding its verification facts', () => {
    // #given a banned but verified account
    const caps = buildAccountCapabilities(
      base({
        bannedAt: new Date('2026-10-01T00:00:00.000Z'),
        kycStatus: 'VERIFIED',
        amlStatus: 'CLEAR',
      }),
      NOW,
    );

    // #then suspension and verification are separate facts
    expect(caps.accountActive).toBe(false);
    expect(caps.verification.fundsEligible).toBe(true);
  });

  it('stamps the projection with the supplied time', () => {
    // #given a deterministic clock
    const caps = buildAccountCapabilities(base(), NOW);

    // #then the payload advertises its own freshness
    expect(caps.asOf).toBe('2026-10-22T12:00:00.000Z');
  });

  it('reports basic analytics with an open request for an ordinary account', () => {
    // #given an account with no analytics grant
    const caps = buildAccountCapabilities(base(), NOW);

    // #then only basic reports are advertised and the request CTA is open
    expect(caps.analytics).toMatchObject({
      tier: 'basic',
      premium: false,
      requestStatus: 'NONE',
      canRequest: true,
    });
  });

  it('reports admin analytics for an admin account', () => {
    // #given an admin with no grant row
    const caps = buildAccountCapabilities(base({ role: 'ADMIN' }), NOW);

    // #then admin reports are advertised without a request
    expect(caps.analytics).toMatchObject({
      tier: 'admin',
      premium: true,
      requestStatus: 'NOT_REQUIRED',
      canRequest: false,
      available: true,
    });
  });

  it('reports analytics availability separately from entitlement', () => {
    // #given an approved account while the read surface is disabled
    const caps = buildAccountCapabilities(
      base({
        analytics: analyticsEntitlement({
          role: 'USER',
          access: { status: 'APPROVED', source: 'ADMIN', expiresAt: null },
          available: false,
          now: NOW,
        }),
      }),
      NOW,
    );

    // #then the grant is still reported but the surface is marked unavailable
    expect(caps.analytics).toMatchObject({
      available: false,
      premium: true,
      requestStatus: 'APPROVED',
    });
  });
});
