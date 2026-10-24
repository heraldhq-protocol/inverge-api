import { buildAccountCapabilities, CapabilityInput } from './capabilities';

const NOW = new Date('2026-10-22T12:00:00.000Z');

const base = (overrides: Partial<CapabilityInput> = {}): CapabilityInput => ({
  role: 'USER',
  bannedAt: null,
  kycStatus: 'NOT_REQUIRED',
  amlStatus: 'NOT_SCREENED',
  displayName: 'Ada',
  username: 'ada',
  ...overrides,
});

describe('buildAccountCapabilities', () => {
  it('keeps ordinary authenticated actions available before verification', () => {
    // #given an unverified account
    const caps = buildAccountCapabilities(base(), NOW);

    // #then idea actions are allowed but campaign submission is not
    expect(caps.capabilities).toMatchObject({
      createIdeas: true,
      supportIdeas: true,
      prePledge: true,
      purchaseBoosts: true,
      submitCampaigns: false,
    });
  });

  it('lists the KYC and AML blockers that stop campaign submission', () => {
    // #given an unverified account
    const caps = buildAccountCapabilities(base(), NOW);

    // #then both outstanding checks are surfaced
    expect(caps.verification).toEqual({
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
});
