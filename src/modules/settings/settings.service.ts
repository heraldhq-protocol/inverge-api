import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailVerificationService } from '../auth/email/email-verification.service';
import {
  CreateAccountRequestDto,
  SettingsFeedRegion,
  UpdateFeedSettingsDto,
  UpdateNotificationSettingsDto,
} from './dto/settings.dto';

const PREVIEW_LINK_LIMIT = 10;
const ACCOUNT_REQUEST_LIMIT = 5;

export interface SettingsFeedView {
  region: SettingsFeedRegion;
  showPromoted: boolean;
  topics: string[];
}

export interface SettingsNotificationView {
  emailUpdates: boolean;
  milestoneReviews: boolean;
  creatorUpdates: boolean;
  discoveryDigest: boolean;
}

function asLinks(value: unknown): { label: string; url: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (link): link is { label: string; url: string } =>
        Boolean(link) &&
        typeof link === 'object' &&
        typeof (link as { label?: unknown }).label === 'string' &&
        typeof (link as { url?: unknown }).url === 'string',
    )
    .slice(0, PREVIEW_LINK_LIMIT)
    .map((link) => ({ label: link.label, url: link.url }));
}

function isSettingsRegion(value: string): value is SettingsFeedRegion {
  return value === 'global' || value === 'africa' || value === 'west-africa';
}

/**
 * Read/write surface for the settings screen.
 *
 * Private facts (provider subject, KYC references, wallet keys) never leave this
 * service. The aggregate only exposes what the account owner needs to understand
 * and change their own preferences.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailVerificationService,
  ) {}

  async get(userId: string) {
    const [user, emailStatus] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
          emailVerified: true,
          emailVerifiedAt: true,
          accountType: true,
          role: true,
          createdAt: true,
          preferredCategories: true,
          preferredRegions: true,
          feedRegion: true,
          feedShowPromoted: true,
          notifyEmailUpdates: true,
          notifyMilestoneReviews: true,
          notifyCreatorUpdates: true,
          notifyDiscoveryDigest: true,
          kycStatus: true,
          amlStatus: true,
          creatorProfile: {
            select: {
              username: true,
              displayName: true,
              bio: true,
              location: true,
              avatarUrl: true,
              links: true,
            },
          },
          wallets: {
            orderBy: [{ isEmbedded: 'desc' }, { createdAt: 'asc' }],
            select: { provider: true, isEmbedded: true },
          },
          verificationCases: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true, createdAt: true },
          },
          accountRequests: {
            orderBy: { createdAt: 'desc' },
            take: ACCOUNT_REQUEST_LIMIT,
            select: { id: true, type: true, status: true, createdAt: true },
          },
        },
      }),
      this.email.status(userId),
    ]);
    if (!user) throw new NotFoundException('User not found');

    const wallet = user.wallets[0] ?? null;
    const verification = user.verificationCases[0] ?? null;
    const region = isSettingsRegion(user.feedRegion)
      ? user.feedRegion
      : 'global';

    return {
      account: {
        email: user.email,
        emailVerified: user.emailVerified || user.emailVerifiedAt !== null,
        emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
        accountType: user.accountType,
        role: user.role,
        memberSince: user.createdAt.toISOString(),
      },
      profile: {
        username: user.creatorProfile?.username ?? null,
        displayName: user.creatorProfile?.displayName ?? null,
        bio: user.creatorProfile?.bio ?? null,
        location: user.creatorProfile?.location ?? null,
        avatarUrl: user.creatorProfile?.avatarUrl ?? null,
        links: asLinks(user.creatorProfile?.links),
      },
      feed: {
        region,
        showPromoted: user.feedShowPromoted,
        topics: user.preferredCategories,
      } satisfies SettingsFeedView,
      notifications: {
        emailUpdates: user.notifyEmailUpdates,
        milestoneReviews: user.notifyMilestoneReviews,
        creatorUpdates: user.notifyCreatorUpdates,
        discoveryDigest: user.notifyDiscoveryDigest,
      } satisfies SettingsNotificationView,
      verification: {
        kycStatus: user.kycStatus,
        amlStatus: user.amlStatus,
        latestCaseStatus: verification?.status ?? null,
        latestCaseAt: verification?.createdAt.toISOString() ?? null,
      },
      wallet: wallet
        ? {
            connected: true,
            provider: wallet.provider,
            embedded: wallet.isEmbedded,
          }
        : { connected: false, provider: null, embedded: false },
      requests: user.accountRequests.map((request) => ({
        id: request.id,
        type: request.type,
        status: request.status,
        createdAt: request.createdAt.toISOString(),
      })),
      emailChallenge: emailStatus.challenge,
      pendingEmail: emailStatus.pendingEmail,
    };
  }

  async updateFeed(
    userId: string,
    dto: UpdateFeedSettingsDto,
  ): Promise<SettingsFeedView> {
    const regions = dto.region === 'global' ? [] : [dto.region];
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        preferredCategories: dto.topics,
        preferredRegions: regions,
        feedRegion: dto.region,
        feedShowPromoted: dto.showPromoted,
      },
      select: {
        preferredCategories: true,
        feedRegion: true,
        feedShowPromoted: true,
      },
    });
    return {
      region: isSettingsRegion(user.feedRegion) ? user.feedRegion : 'global',
      showPromoted: user.feedShowPromoted,
      topics: user.preferredCategories,
    };
  }

  async updateNotifications(
    userId: string,
    dto: UpdateNotificationSettingsDto,
  ): Promise<SettingsNotificationView> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        notifyEmailUpdates: dto.emailUpdates,
        notifyMilestoneReviews: dto.milestoneReviews,
        notifyCreatorUpdates: dto.creatorUpdates,
        notifyDiscoveryDigest: dto.discoveryDigest,
      },
      select: {
        notifyEmailUpdates: true,
        notifyMilestoneReviews: true,
        notifyCreatorUpdates: true,
        notifyDiscoveryDigest: true,
      },
    });
    return {
      emailUpdates: user.notifyEmailUpdates,
      milestoneReviews: user.notifyMilestoneReviews,
      creatorUpdates: user.notifyCreatorUpdates,
      discoveryDigest: user.notifyDiscoveryDigest,
    };
  }

  /**
   * Creates one support request. A duplicate pending request of the same type is
   * returned instead of queued twice, which makes a double-click or retry safe.
   * Account deletion is never executed here; it is reviewed against retention and
   * campaign obligations first.
   */
  async createRequest(userId: string, dto: CreateAccountRequestDto) {
    const pending = await this.prisma.accountRequest.findFirst({
      where: {
        userId,
        type: dto.type,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, type: true, status: true, createdAt: true },
    });
    if (pending) {
      return {
        alreadyPending: true,
        request: {
          id: pending.id,
          type: pending.type,
          status: pending.status,
          createdAt: pending.createdAt.toISOString(),
        },
      };
    }

    const request = await this.prisma.accountRequest.create({
      data: {
        userId,
        type: dto.type,
        note: dto.note?.trim() || null,
      },
      select: { id: true, type: true, status: true, createdAt: true },
    });
    return {
      alreadyPending: false,
      request: {
        id: request.id,
        type: request.type,
        status: request.status,
        createdAt: request.createdAt.toISOString(),
      },
    };
  }
}
