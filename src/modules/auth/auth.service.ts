import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  EMBEDDED_WALLET_PORT,
  EmbeddedWalletInfo,
  EmbeddedWalletPort,
} from '../../ports/wallet/embedded-wallet.port';
import { ModerationService } from '../moderation/moderation.service';
import { UpdateCreatorProfileDto } from './dto/update-creator-profile.dto';
import { toPublicCreator } from '../../common/projections/creator-profile.projection';
import { SessionService } from './session.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
    private readonly sessions: SessionService,
    @Inject(EMBEDDED_WALLET_PORT)
    private readonly wallets: EmbeddedWalletPort,
  ) {}

  async authenticate(providerToken: string, walletAddress?: string) {
    if (!providerToken) throw new UnauthorizedException('No token provided');

    // The provider token proves identity only at this exchange; every later call
    // carries the short-lived Inverge session instead (gap item 25).
    const identity = await this.wallets.verifyAccessToken(providerToken, {
      walletAddress,
    });

    let user = await this.prisma.user.findUnique({
      where: { providerUserId: identity.providerUserId },
      include: { creatorProfile: true },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          providerUserId: identity.providerUserId,
          email: identity.email ?? null,
          role: 'USER',
        },
        include: { creatorProfile: true },
      });
    }

    if (!user) throw new UnauthorizedException('Authentication failed');

    if (identity.wallet) await this.linkWallet(user.id, identity.wallet);

    const requiresOnboarding = !user.creatorProfile?.displayName || !user.creatorProfile?.username;

    return {
      user,
      creator: toPublicCreator(user),
      // Gap item 25: callers authenticate with an Inverge session JWT, never with the
      // provider token. The provider token proves identity only at this exchange.
      sessionToken: await this.sessions.sign(user.id),
      requiresOnboarding,
    };
  }

  /**
   * Records the wallet the provider attested at sign-in. Stub addresses are
   * synthetic, so persisting one would present a fake wallet as real.
   */
  private async linkWallet(userId: string, wallet: EmbeddedWalletInfo) {
    if (wallet.provider === 'stub') return;
    await this.prisma.walletAccount.upsert({
      where: { userId_address: { userId, address: wallet.address } },
      update: { provider: wallet.provider, isEmbedded: true },
      create: {
        userId,
        address: wallet.address,
        provider: wallet.provider,
        isEmbedded: true,
      },
    });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { creatorProfile: true },
    });
    if (!user) return null;
    const requiresOnboarding = !user.creatorProfile?.displayName || !user.creatorProfile?.username;
    return {
      ...user,
      creator: toPublicCreator(user),
      requiresOnboarding,
    };
  }

  async checkUsernameAvailability(username: string, currentUserId?: string) {
    if (!username || username.trim().length < 3) {
      return { available: false, reason: 'Username must be at least 3 characters long' };
    }
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    if (!/^[a-zA-Z0-9_-]+$/.test(clean)) {
      return { available: false, reason: 'Username can only contain letters, numbers, underscores, and dashes' };
    }

    const existing = await this.prisma.creatorProfile.findFirst({
      where: {
        username: { equals: clean, mode: 'insensitive' },
        ...(currentUserId ? { userId: { not: currentUserId } } : {}),
      },
    });

    if (existing) {
      return { available: false, reason: 'This username is already taken' };
    }

    return { available: true };
  }

  async updateProfile(userId: string, dto: UpdateCreatorProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (dto.username) {
      const cleanUsername = dto.username.trim().toLowerCase().replace(/^@/, '');
      const check = await this.checkUsernameAvailability(cleanUsername, userId);
      if (!check.available) {
        throw new BadRequestException(check.reason);
      }
    }

    if (dto.displayName || dto.bio) {
      await this.moderation.screenSafe(
        {
          kind: 'idea',
          title: dto.displayName ?? 'Creator Profile',
          text: [dto.displayName, dto.bio].filter(Boolean).join('\n'),
        },
        { submittedById: userId },
      );
    }

    await this.prisma.creatorProfile.upsert({
      where: { userId },
      update: {
        ...(dto.username !== undefined ? { username: dto.username.trim().toLowerCase().replace(/^@/, '') } : {}),
        ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
        ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl } : {}),
        ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
        ...(dto.links !== undefined ? { links: dto.links as object } : {}),
      },
      create: {
        userId,
        username: dto.username ? dto.username.trim().toLowerCase().replace(/^@/, '') : null,
        displayName: dto.displayName ?? null,
        avatarUrl: dto.avatarUrl ?? null,
        bio: dto.bio ?? null,
        links: (dto.links ?? []) as object,
      },
    });

    const updatedUser = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { creatorProfile: true },
    });

    return {
      ...updatedUser,
      creator: toPublicCreator(updatedUser),
    };
  }

  async getPublicProfile(idOrUsername: string) {
    // Decode URL encoding (%40 -> @) then strip leading @, normalise to lowercase
    let decoded: string;
    try {
      decoded = decodeURIComponent(idOrUsername);
    } catch {
      decoded = idOrUsername;
    }
    const cleanParam = decoded.replace(/^@/, '').toLowerCase().trim();

    const users = await this.prisma.user.findMany({
      include: {
        creatorProfile: true,
        _count: { select: { ideas: true } },
      },
    });

    const matchedUser = users.find((u) => {
      const pub = toPublicCreator(u);
      const storedUsername = u.creatorProfile?.username?.toLowerCase().trim();
      const pubUsername = pub?.username?.toLowerCase();
      return (
        u.id === cleanParam ||
        storedUsername === cleanParam ||
        pubUsername === cleanParam
      );
    });

    if (!matchedUser) throw new NotFoundException('Creator not found');

    const creator = toPublicCreator(matchedUser)!;

    const publishedIdeas = await this.prisma.idea.findMany({
      where: { creatorId: matchedUser.id, status: { in: ['VALIDATING', 'THRESHOLD_MET', 'CONVERTED'] } },
      include: {
        creator: { include: { creatorProfile: true, _count: { select: { ideas: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const signals = await this.prisma.ideaSignal.findMany({
      where: { userId: matchedUser.id },
      select: { ideaId: true },
    });
    const supportedIdeaIds = Array.from(new Set(signals.map((s) => s.ideaId)));

    const supportedIdeas =
      supportedIdeaIds.length > 0
        ? await this.prisma.idea.findMany({
            where: { id: { in: supportedIdeaIds } },
            include: {
              creator: { include: { creatorProfile: true, _count: { select: { ideas: true } } } },
            },
            orderBy: { createdAt: 'desc' },
          })
        : [];

    return {
      creator,
      ideasPublished: publishedIdeas.map(({ ...i }) => ({
        ...i,
        creator: toPublicCreator(i.creator),
      })),
      ideasSupported: supportedIdeas.map(({ ...i }) => ({
        ...i,
        creator: toPublicCreator(i.creator),
      })),
    };
  }
}
