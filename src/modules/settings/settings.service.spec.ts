import { SettingsService } from './settings.service';
import { EmailVerificationService } from '../auth/email/email-verification.service';
import { PrismaService } from '../../prisma/prisma.service';

function fakePrisma() {
  return {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    accountRequest: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
  };
}

function fakeEmail(): EmailVerificationService {
  return {
    status: jest.fn().mockResolvedValue({
      email: 'amara@example.test',
      verified: true,
      pendingEmail: null,
      challenge: null,
    }),
  } as unknown as EmailVerificationService;
}

function service(prisma: ReturnType<typeof fakePrisma>) {
  return new SettingsService(prisma as unknown as PrismaService, fakeEmail());
}

const createdAt = new Date('2026-08-02T09:00:00.000Z');

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    email: 'amara@example.test',
    emailVerified: true,
    emailVerifiedAt: new Date('2026-09-14T10:30:00.000Z'),
    accountType: 'INDIVIDUAL',
    role: 'USER',
    createdAt,
    preferredCategories: ['technology'],
    preferredRegions: ['west-africa'],
    feedRegion: 'west-africa',
    feedShowPromoted: false,
    notifyEmailUpdates: true,
    notifyMilestoneReviews: true,
    notifyCreatorUpdates: true,
    notifyDiscoveryDigest: false,
    kycStatus: 'VERIFIED',
    amlStatus: 'CLEAR',
    creatorProfile: {
      username: 'amara',
      displayName: 'Amara Okonkwo',
      bio: null,
      location: 'Lagos, Nigeria',
      avatarUrl: null,
      links: [],
    },
    wallets: [
      { provider: 'web3auth', isEmbedded: true },
    ],
    verificationCases: [
      { status: 'APPROVED', createdAt: new Date('2026-09-15T12:00:00.000Z') },
    ],
    accountRequests: [
      {
        id: 'req-1',
        type: 'DATA_EXPORT',
        status: 'PENDING',
        createdAt,
      },
    ],
    ...overrides,
  };
}

describe('SettingsService', () => {
  it('projects the account settings aggregate without provider internals', async () => {
    const prisma = fakePrisma();
    prisma.user.findUnique.mockResolvedValue(userRow());

    const result = await service(prisma).get('u1');

    expect(result.account).toMatchObject({
      email: 'amara@example.test',
      emailVerified: true,
      accountType: 'INDIVIDUAL',
    });
    expect(result.feed).toEqual({
      region: 'west-africa',
      showPromoted: false,
      topics: ['technology'],
    });
    expect(result.wallet).toEqual({
      connected: true,
      provider: 'web3auth',
      embedded: true,
    });
    expect(result.verification.latestCaseStatus).toBe('APPROVED');
    expect(JSON.stringify(result)).not.toContain('providerSubject');
    expect(JSON.stringify(result)).not.toContain('wallet-address');
  });

  it('expands a broad region into the stored preference and clears it for global', async () => {
    const prisma = fakePrisma();
    prisma.user.update.mockResolvedValue({
      preferredCategories: ['technology'],
      feedRegion: 'global',
      feedShowPromoted: true,
    });

    await service(prisma).updateFeed('u1', {
      region: 'global',
      showPromoted: true,
      topics: ['technology'],
    });

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({
          feedRegion: 'global',
          preferredRegions: [],
          preferredCategories: ['technology'],
        }),
      }),
    );
  });

  it('returns the existing pending request instead of queueing a duplicate', async () => {
    const prisma = fakePrisma();
    prisma.accountRequest.findFirst.mockResolvedValue({
      id: 'req-1',
      type: 'ACCOUNT_DELETION',
      status: 'PENDING',
      createdAt,
    });

    const result = await service(prisma).createRequest('u1', {
      type: 'ACCOUNT_DELETION',
    });

    expect(result.alreadyPending).toBe(true);
    expect(result.request.id).toBe('req-1');
    expect(prisma.accountRequest.create).not.toHaveBeenCalled();
  });

  it('creates one auditable request when none is pending', async () => {
    const prisma = fakePrisma();
    prisma.accountRequest.findFirst.mockResolvedValue(null);
    prisma.accountRequest.create.mockResolvedValue({
      id: 'req-2',
      type: 'DATA_EXPORT',
      status: 'PENDING',
      createdAt,
    });

    const result = await service(prisma).createRequest('u1', {
      type: 'DATA_EXPORT',
      note: '  please export  ',
    });

    expect(result.alreadyPending).toBe(false);
    expect(prisma.accountRequest.create).toHaveBeenCalledWith({
      data: { userId: 'u1', type: 'DATA_EXPORT', note: 'please export' },
      select: { id: true, type: true, status: true, createdAt: true },
    });
  });
});
