import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import {
  asCursorDate,
  buildPage,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  filterFingerprint,
  keysetCondition,
} from '../../common/http/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ANALYTICS_PREMIUM_FEATURE,
  analyticsEntitlement,
  AnalyticsAccessFacts,
  CreatorTier,
} from './analytics-entitlements';
import {
  AdminAnalyticsAccessRequestDto,
  AdminAnalyticsAccessRequestListDto,
  AnalyticsAccessDto,
  DecideAnalyticsAccessRequestDto,
  ListAnalyticsAccessRequestsQueryDto,
} from './dto/analytics-access.dto';

type GrantFacts = AnalyticsAccessFacts & {
  id: string;
  requestedAt: Date;
  decidedAt: Date | null;
  expiresAt: Date | null;
};

/**
 * Request/approval workflow for premium analytics.
 *
 * A request is idempotent: a pending or active approval is returned unchanged.
 * A rejected or expired grant may be requested again. Admin approval writes the
 * same `APPROVED` row a future paid checkout will write, so switching to a paid
 * wall is an entitlement-source change, not a report rewrite.
 */
@Injectable()
export class AnalyticsAccessService {
  private readonly logger = new Logger(AnalyticsAccessService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getAccess(user: AuthenticatedUser): Promise<AnalyticsAccessDto> {
    const [profile, grant] = await Promise.all([
      this.prisma.creatorProfile.findUnique({
        where: { userId: user.id },
        select: { tier: true },
      }),
      this.findGrant(user.id),
    ]);

    const entitlement = analyticsEntitlement({
      role: user.role === 'ADMIN' ? 'ADMIN' : 'USER',
      creatorTier: profile?.tier ?? null,
      access: grant,
      now: new Date(),
    });

    return {
      feature: ANALYTICS_PREMIUM_FEATURE,
      premium: entitlement.premium,
      requestStatus: entitlement.requestStatus,
      canRequest: entitlement.canRequest,
      source: grant?.source ?? null,
      requestedAt: grant?.requestedAt.toISOString() ?? null,
      decidedAt: grant?.decidedAt?.toISOString() ?? null,
      expiresAt: grant?.expiresAt?.toISOString() ?? null,
      creatorTier: entitlement.creatorTier ?? 'STARTER',
    };
  }

  async requestAccess(user: AuthenticatedUser): Promise<AnalyticsAccessDto> {
    if (user.role === 'ADMIN') return this.getAccess(user);

    const existing = await this.findGrant(user.id);
    const now = new Date();
    if (existing && this.isOpen(existing, now)) {
      return this.getAccess(user);
    }

    try {
      if (existing) {
        await this.prisma.analyticsAccessGrant.update({
          where: { id: existing.id },
          data: {
            status: 'PENDING',
            source: 'REQUEST',
            requestedAt: now,
            decidedAt: null,
            decidedBy: null,
            expiresAt: null,
            externalReference: null,
          },
        });
      } else {
        await this.prisma.analyticsAccessGrant.create({
          data: {
            userId: user.id,
            feature: ANALYTICS_PREMIUM_FEATURE,
            status: 'PENDING',
            source: 'REQUEST',
            requestedAt: now,
          },
        });
      }
    } catch (error) {
      // Two tabs can submit at once. The unique key makes one the winner; the
      // loser returns the winner's state instead of creating a second request.
      if (!this.isUniqueViolation(error)) throw error;
    }

    return this.getAccess(user);
  }

  async listRequests(
    query: ListAnalyticsAccessRequestsQueryDto,
  ): Promise<AdminAnalyticsAccessRequestListDto> {
    const limit = clampPageSize(query.limit);
    const fingerprint = filterFingerprint({
      feature: ANALYTICS_PREMIUM_FEATURE,
      status: query.status ?? 'ALL',
    });
    const cursor = query.cursor
      ? decodeCursor(query.cursor, fingerprint)
      : undefined;

    const rows = await this.prisma.analyticsAccessGrant.findMany({
      where: {
        feature: ANALYTICS_PREMIUM_FEATURE,
        ...(query.status ? { status: query.status } : {}),
        ...(cursor
          ? keysetCondition('requestedAt', 'desc', cursor, asCursorDate)
          : {}),
      },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        userId: true,
        status: true,
        source: true,
        requestedAt: true,
        decidedAt: true,
        expiresAt: true,
        user: {
          select: {
            email: true,
            creatorProfile: {
              select: { displayName: true, username: true, tier: true },
            },
          },
        },
      },
    });

    const page = buildPage(rows, limit, (row) =>
      encodeCursor(row.requestedAt.toISOString(), row.id, fingerprint),
    );

    return {
      data: page.data.map((row) => this.toAdminDto(row)),
      page: page.page,
    };
  }

  async decide(
    adminId: string,
    id: string,
    dto: DecideAnalyticsAccessRequestDto,
  ): Promise<AdminAnalyticsAccessRequestDto> {
    const grant = await this.prisma.analyticsAccessGrant.findUnique({
      where: { id },
      select: { id: true, feature: true },
    });
    if (!grant || grant.feature !== ANALYTICS_PREMIUM_FEATURE) {
      throw new NotFoundException('Analytics access request not found');
    }

    const now = new Date();
    const expiresAt =
      dto.status === 'APPROVED' && dto.expiresAt
        ? new Date(dto.expiresAt)
        : null;
    if (expiresAt && expiresAt.getTime() <= now.getTime()) {
      throw new BadRequestException({
        code: 'INVALID_ACCESS_EXPIRY',
        message: 'expiresAt must be in the future',
      });
    }

    const updated = await this.prisma.analyticsAccessGrant.update({
      where: { id },
      data: {
        status: dto.status,
        decidedAt: now,
        decidedBy: adminId,
        expiresAt,
        // An approval keeps the request as its origin; a future paid checkout
        // writes source PAID and an external reference instead.
        ...(dto.status === 'APPROVED' ? {} : { externalReference: null }),
      },
      select: {
        id: true,
        userId: true,
        status: true,
        source: true,
        requestedAt: true,
        decidedAt: true,
        expiresAt: true,
        user: {
          select: {
            email: true,
            creatorProfile: {
              select: { displayName: true, username: true, tier: true },
            },
          },
        },
      },
    });

    this.logger.log(
      `Analytics access ${dto.status.toLowerCase()} for grant ${id}`,
    );
    return this.toAdminDto(updated);
  }

  /**
   * Future paid wall entry point. A checkout callback calls this with the
   * provider reference and the paid-through instant; report code is unchanged.
   */
  async grantPaidAccess(
    userId: string,
    paidThrough: Date,
    externalReference: string,
  ): Promise<void> {
    if (paidThrough.getTime() <= Date.now()) {
      throw new ConflictException({
        code: 'INVALID_ACCESS_EXPIRY',
        message: 'paidThrough must be in the future',
      });
    }

    await this.prisma.analyticsAccessGrant.upsert({
      where: {
        userId_feature: {
          userId,
          feature: ANALYTICS_PREMIUM_FEATURE,
        },
      },
      create: {
        userId,
        feature: ANALYTICS_PREMIUM_FEATURE,
        status: 'APPROVED',
        source: 'PAID',
        requestedAt: new Date(),
        decidedAt: new Date(),
        expiresAt: paidThrough,
        externalReference,
      },
      update: {
        status: 'APPROVED',
        source: 'PAID',
        decidedAt: new Date(),
        expiresAt: paidThrough,
        externalReference,
      },
    });
  }

  private async findGrant(userId: string): Promise<GrantFacts | null> {
    return this.prisma.analyticsAccessGrant.findUnique({
      where: {
        userId_feature: {
          userId,
          feature: ANALYTICS_PREMIUM_FEATURE,
        },
      },
      select: {
        id: true,
        status: true,
        source: true,
        requestedAt: true,
        decidedAt: true,
        expiresAt: true,
      },
    });
  }

  private isOpen(grant: GrantFacts, now: Date): boolean {
    if (grant.status === 'PENDING') return true;
    return (
      grant.status === 'APPROVED' &&
      (grant.expiresAt === null || grant.expiresAt.getTime() > now.getTime())
    );
  }

  private toAdminDto(row: {
    id: string;
    userId: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    source: 'REQUEST' | 'ADMIN' | 'PAID';
    requestedAt: Date;
    decidedAt: Date | null;
    expiresAt: Date | null;
    user: {
      email: string | null;
      creatorProfile: {
        displayName: string | null;
        username: string | null;
        tier: CreatorTier;
      } | null;
    };
  }): AdminAnalyticsAccessRequestDto {
    return {
      id: row.id,
      userId: row.userId,
      email: row.user.email,
      displayName: row.user.creatorProfile?.displayName ?? null,
      username: row.user.creatorProfile?.username ?? null,
      creatorTier: row.user.creatorProfile?.tier ?? 'STARTER',
      status: row.status,
      source: row.source,
      requestedAt: row.requestedAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    );
  }
}
