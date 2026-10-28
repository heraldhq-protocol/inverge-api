import { AuthService } from './auth.service';

const GOOGLE_AVATAR =
  'https://lh3.googleusercontent.com/a/ACg8oc-example=s96-c';

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    providerUserId: 'google|user-1',
    email: 'amara@example.test',
    role: 'USER',
    bannedAt: null,
    kycStatus: 'NOT_STARTED',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    creatorProfile: null,
    ...overrides,
  };
}

function setup(options: {
  existingUser?: Record<string, unknown> | null;
  avatarUrl?: string;
} = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(options.existingUser ?? null),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({
        ...user(),
        creatorProfile: data.creatorProfile?.create ?? null,
      })),
    },
    creatorProfile: {
      upsert: jest.fn().mockImplementation(async ({ create }: any) => create),
    },
    walletAccount: {
      upsert: jest.fn().mockResolvedValue(undefined),
    },
  } as any;
  const moderation = {} as any;
  const sessions = { sign: jest.fn().mockResolvedValue('session-token') } as any;
  const config = { get: jest.fn() } as any;
  const wallets = {
    verifyAccessToken: jest.fn().mockResolvedValue({
      providerUserId: 'google|user-1',
      email: 'amara@example.test',
      ...(options.avatarUrl ? { avatarUrl: options.avatarUrl } : {}),
    }),
  } as any;

  const svc = new AuthService(prisma, moderation, sessions, config, wallets);

  return { prisma, sessions, svc, wallets };
}

describe('AuthService.authenticate provider avatar', () => {
  it('creates the profile with a verified Google avatar on first sign-in', async () => {
    const { prisma, svc } = setup({ avatarUrl: GOOGLE_AVATAR });

    await svc.authenticate('provider-token');

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          creatorProfile: { create: { avatarUrl: GOOGLE_AVATAR } },
        }),
      }),
    );
  });

  it('fills a missing avatar on an existing account', async () => {
    const { prisma, svc } = setup({
      avatarUrl: GOOGLE_AVATAR,
      existingUser: user({
        creatorProfile: { avatarUrl: null, displayName: null, username: null },
      }),
    });

    await svc.authenticate('provider-token');

    expect(prisma.creatorProfile.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      update: { avatarUrl: GOOGLE_AVATAR },
      create: { userId: 'user-1', avatarUrl: GOOGLE_AVATAR },
    });
  });

  it('never overwrites an avatar the creator already has', async () => {
    const { prisma, svc } = setup({
      avatarUrl: GOOGLE_AVATAR,
      existingUser: user({
        creatorProfile: {
          avatarUrl: 'https://lh3.googleusercontent.com/a/chosen=s96-c',
          displayName: 'Amara',
          username: 'amara',
        },
      }),
    });

    await svc.authenticate('provider-token');

    expect(prisma.creatorProfile.upsert).not.toHaveBeenCalled();
  });

  it('does not create a profile when the token has no image claim', async () => {
    const { prisma, svc } = setup();

    await svc.authenticate('provider-token');

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ creatorProfile: expect.anything() }),
      }),
    );
  });
});
