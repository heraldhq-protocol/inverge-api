import { Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  EMBEDDED_WALLET_PORT,
  EmbeddedWalletPort,
} from '../../ports/wallet/embedded-wallet.port';
import { SessionService } from './session.service';
import { ModerationService } from '../moderation/moderation.service';
import { UpdateCreatorProfileDto } from './dto/update-creator-profile.dto';
import { toPublicCreator } from '../../common/projections/creator-profile.projection';

@Injectable()
export class AuthService {
  constructor(
    @Inject(EMBEDDED_WALLET_PORT) private readonly wallet: EmbeddedWalletPort,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    @Inject(forwardRef(() => ModerationService))
    private readonly moderation: ModerationService,
  ) {}

  // FR-101: verify provider token, upsert user, provision the embedded wallet,
  // return a short-lived session token.
  async authenticate(accessToken: string) {
    const identity = await this.wallet.verifyAccessToken(accessToken);

    const user = await this.prisma.user.upsert({
      where: { privyDid: identity.providerUserId },
      update: identity.email ? { email: identity.email } : {},
      create: { privyDid: identity.providerUserId, email: identity.email ?? null },
    });

    const embedded =
      identity.wallet ??
      (await this.wallet.getEmbeddedWallet(identity.providerUserId));
    if (embedded) {
      await this.prisma.walletAccount.upsert({
        where: { userId_address: { userId: user.id, address: embedded.address } },
        update: {},
        create: {
          userId: user.id,
          address: embedded.address,
          provider: embedded.provider,
          isEmbedded: true,
          role: 'FUNDING',
        },
      });
    }

    const userWithProfile = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: { wallets: true, creatorProfile: true },
    });

    const requiresOnboarding = !userWithProfile?.creatorProfile?.displayName;
    const sessionToken = await this.sessions.sign(user.id);
    return {
      user: userWithProfile ? { ...userWithProfile, creator: toPublicCreator(userWithProfile) } : user,
      sessionToken,
      requiresOnboarding,
    };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { wallets: true, creatorProfile: true },
    });
    if (!user) return null;
    const requiresOnboarding = !user.creatorProfile?.displayName;
    return {
      ...user,
      creator: toPublicCreator(user),
      requiresOnboarding,
    };
  }

  async updateProfile(userId: string, dto: UpdateCreatorProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

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
        ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
        ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl } : {}),
        ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
        ...(dto.links !== undefined ? { links: dto.links as object } : {}),
      },
      create: {
        userId,
        displayName: dto.displayName ?? null,
        avatarUrl: dto.avatarUrl ?? null,
        bio: dto.bio ?? null,
        links: (dto.links ?? []) as object,
      },
    });

    const updatedUser = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { wallets: true, creatorProfile: true },
    });

    return {
      ...updatedUser,
      creator: toPublicCreator(updatedUser),
    };
  }
}

