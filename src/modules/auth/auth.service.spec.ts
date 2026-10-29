import { AuthService } from './auth.service';

const GOOGLE_AVATAR =
  'https://lh3.googleusercontent.com/a/ACg8oc-example=s96-c';

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    providerUserId: 'google|user-1',
    email: 'amara@example.test',
    emailVerified: false,
    emailVerifiedAt: null,
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
  identityEmail?: string;
  identityEmailVerified?: boolean;
} = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(options.existingUser ?? null),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({
        ...user(),
        email: data.email ?? null,
        emailVerified: data.emailVerified ?? false,
        emailVerifiedAt: data.emailVerifiedAt ?? null,
        creatorProfile: data.creatorProfile?.create ?? null,
      })),
      update: jest.fn().mockImplementation(async ({ data }: any) => ({
        ...user(),
        ...data,
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
      email: options.identityEmail ?? 'amara@example.test',
      emailVerified: options.identityEmailVerified === true,
      ...(options.avatarUrl ? { avatarUrl: options.avatarUrl } : {}),
    }),
  } as any;

  const svc = new AuthService(prisma, moderation, sessions, config, wallets);

  return { prisma, sessions, svc, wallets };
}

describe('AuthService.authenticate provider email', () => {
  it('stores an unproven provider address as the expected, unverified address', async () => {
    // #given a token with an email but no signed email_verified claim
    const { prisma, svc } = setup({
      identityEmail: 'Amara@Example.TEST',
      identityEmailVerified: false,
    });

    // #when the account is created
    const result = await svc.authenticate('provider-token');

    // #then the OAuth address is the address to confirm, but it is not owned
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'amara@example.test',
          emailVerified: false,
          emailVerifiedAt: null,
        }),
      }),
    );
    expect(result.user.email).toBe('amara@example.test');
    expect(result.user.emailVerified).toBe(false);
    expect(result.suggestedEmail).toBeNull();
    expect(result.requiresEmailVerification).toBe(true);
  });

  it('stores a signed verified address and stamps ownership', async () => {
    // #given a provider that signed email_verified: true
    const { prisma, svc } = setup({
      identityEmail: 'Amara@Example.TEST',
      identityEmailVerified: true,
    });

    // #when the account is created
    const result = await svc.authenticate('provider-token');

    // #then the normalized address is stored with a verification timestamp
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'amara@example.test',
          emailVerified: true,
          emailVerifiedAt: expect.any(Date),
        }),
      }),
    );
    expect(result.user.emailVerified).toBe(true);
    expect(result.suggestedEmail).toBeNull();
    expect(result.requiresEmailVerification).toBe(false);
  });

  it('never overwrites a different address already on the account', async () => {
    // #given an account with an existing unverified address
    const { prisma, svc } = setup({
      existingUser: user({ email: 'old@example.test' }),
      identityEmail: 'new@example.test',
      identityEmailVerified: true,
    });

    // #when the provider now asserts a different verified address
    await svc.authenticate('provider-token');

    // #then the account keeps its row; a change must go through OTP
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('promotes an existing unverified address when the provider proves it', async () => {
    // #given the same address, previously stored without proof
    const { prisma, svc } = setup({
      existingUser: user({
        email: 'amara@example.test',
        emailVerifiedAt: null,
      }),
      identityEmail: 'amara@example.test',
      identityEmailVerified: true,
    });

    // #when the provider signs the same address
    await svc.authenticate('provider-token');

    // #then only the ownership evidence is added
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { emailVerified: true, emailVerifiedAt: expect.any(Date) },
      }),
    );
  });
});

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
