import { toPublicCreator } from './creator-profile.projection';

describe('toPublicCreator', () => {
  it('should return null if user is null or undefined', () => {
    expect(toPublicCreator(null)).toBeNull();
    expect(toPublicCreator(undefined)).toBeNull();
  });

  it('should never fall back to user email for displayName', () => {
    const user: any = {
      id: 'user-1',
      email: 'secret@example.com',
      kycStatus: 'VERIFIED',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      creatorProfile: {
        displayName: null,
        avatarUrl: 'https://example.com/avatar.jpg',
        bio: 'Hello world',
        links: [{ label: 'Website', url: 'https://example.com' }],
        tier: 'TRUSTED',
        completedCampaigns: 2,
        tenureStartedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    };

    const projection = toPublicCreator(user);
    expect(projection).toBeDefined();
    expect(projection?.displayName).toBeNull();
    expect(projection?.identityVerified).toBe(true);
    expect(projection?.tier).toBe('TRUSTED');
    expect(projection?.completedCampaigns).toBe(2);
    expect(projection?.links).toEqual([{ label: 'Website', url: 'https://example.com' }]);
  });

  it('should default tier to STARTER and identityVerified to false when missing profile/KYC', () => {
    const user: any = {
      id: 'user-2',
      email: 'test@example.com',
      kycStatus: 'NOT_REQUIRED',
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    };

    const projection = toPublicCreator(user);
    expect(projection?.tier).toBe('STARTER');
    expect(projection?.identityVerified).toBe(false);
    expect(projection?.displayName).toBeNull();
    expect(projection?.links).toEqual([]);
  });
});
