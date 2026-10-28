import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import {
  EMBEDDED_WALLET_PORT,
  EmbeddedWalletInfo,
  EmbeddedWalletPort,
} from '../../ports/wallet/embedded-wallet.port';
import {
  ANALYTICS_PREMIUM_FEATURE,
  analyticsEntitlement,
} from '../analytics/analytics-entitlements';
import { ModerationService } from '../moderation/moderation.service';
import { UpdateCreatorProfileDto } from './dto/update-creator-profile.dto';
import { toPublicCreator } from '../../common/projections/creator-profile.projection';
import { SessionService } from './session.service';
import {
  AccountCapabilities,
  buildAccountCapabilities,
} from './capabilities';

/** Public-profile lists are summaries; a full list needs a paginated route. */
const PROFILE_IDEA_LIMIT = 24;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService<Env, true>,
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

    // FR-216 / F-11: never mint a session for a banned account. This is the
    // exchange-time check; PrivyAuthGuard enforces the same rule on every later
    // request so an already-issued token stops working when a ban lands.
    if (user.bannedAt) throw new ForbiddenException('Account is not permitted');

    if (identity.wallet) await this.linkWallet(user.id, identity.wallet);

    const requiresOnboarding = !user.creatorProfile?.displayName || !user.creatorProfile?.username;

    return {
      user: { id: user.id, email: user.email, role: user.role },
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
    // The session's own projection. Provider subject ids, KYC facts and internal
    // timestamps stay server-side; a caller that needs them has a dedicated route.
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      creator: toPublicCreator(user),
      requiresOnboarding,
    };
  }

  /**
   * Account-level capabilities for UI gating. Deliberately selects only the facts the
   * projection needs; KYC provider references, wallets and the provider subject never
   * leave the server through this route.
   */
  async capabilities(userId: string): Promise<AccountCapabilities> {
    const [user, access] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          role: true,
          bannedAt: true,
          kycStatus: true,
          amlStatus: true,
          creatorProfile: {
            select: { displayName: true, username: true, tier: true },
          },
        },
      }),
      this.prisma.analyticsAccessGrant.findUnique({
        where: {
          userId_feature: {
            userId,
            feature: ANALYTICS_PREMIUM_FEATURE,
          },
        },
        select: { status: true, source: true, expiresAt: true },
      }),
    ]);
    if (!user) throw new NotFoundException('User not found');

    const now = new Date();
    return buildAccountCapabilities(
      {
        role: user.role,
        bannedAt: user.bannedAt,
        kycStatus: user.kycStatus,
        amlStatus: user.amlStatus,
        displayName: user.creatorProfile?.displayName ?? null,
        username: user.creatorProfile?.username ?? null,
        analytics: analyticsEntitlement({
          role: user.role === 'ADMIN' ? 'ADMIN' : 'USER',
          creatorTier: user.creatorProfile?.tier ?? null,
          access,
          available: this.config.get('ANALYTICS_READ_ENABLED', { infer: true }),
          now,
        }),
      },
      now,
    );
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

    // Resolve by id or by the stored handle. A display-name-derived slug is not
    // routable: it changes whenever the display name changes, and resolving it
    // required loading every user into memory. The projection may still show the
    // derived handle as a label.
    const matchedUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          { id: cleanParam },
          {
            creatorProfile: {
              is: { username: { equals: cleanParam, mode: 'insensitive' } },
            },
          },
        ],
      },
      include: {
        creatorProfile: true,
        _count: { select: { ideas: true } },
      },
    });

    if (!matchedUser) throw new NotFoundException('Creator not found');

    const creator = toPublicCreator(matchedUser)!;

    // A public profile is a summary, not an archive. Both lists are capped and
    // newest-first; a full list belongs in a paginated route of its own.
    const [publishedIdeas, supportedIdeas] = await Promise.all([
      this.prisma.idea.findMany({
        where: {
          creatorId: matchedUser.id,
          status: { in: ['VALIDATING', 'THRESHOLD_MET', 'CONVERTED'] },
        },
        orderBy: { createdAt: 'desc' },
        take: PROFILE_IDEA_LIMIT,
      }),
      this.prisma.idea.findMany({
        where: {
          status: { in: ['VALIDATING', 'THRESHOLD_MET', 'CONVERTED'] },
          signals: { some: { userId: matchedUser.id } },
        },
        include: {
          creator: {
            include: { creatorProfile: true, _count: { select: { ideas: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: PROFILE_IDEA_LIMIT,
      }),
    ]);

    return {
      creator,
      ideasPublished: publishedIdeas.map((idea) => ({ ...idea, creator })),
      ideasSupported: supportedIdeas.map(({ creator: owner, ...idea }) => ({
        ...idea,
        creator: toPublicCreator(owner),
      })),
    };
  }
}
