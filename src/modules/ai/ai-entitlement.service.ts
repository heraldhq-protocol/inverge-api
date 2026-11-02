import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import type { AiAccessGrant } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { AI_ASSISTANT_FEATURE } from './ai.constants';
import { AiUsageService } from './ai-usage.service';
import {
  AiAccessDto,
  DecideAiAccessDto,
  ListAiAccessQueryDto,
} from './dto/ai.dto';

export type AiAccessRequestStatus =
  | 'NONE'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'NOT_REQUIRED';

export type AiEntitlement = {
  premium: boolean;
  requestStatus: AiAccessRequestStatus;
  canRequest: boolean;
};

export type AdminAiAccessRequestDto = {
  id: string;
  userId: string;
  email: string | null;
  status: string;
  source: string;
  requestedAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
};

function isActive(grant: AiAccessGrant | null, now: Date): boolean {
  if (!grant || grant.status !== 'APPROVED') return false;
  return grant.expiresAt === null || grant.expiresAt.getTime() > now.getTime();
}

export function aiEntitlement(
  role: AuthenticatedUser['role'],
  grant: AiAccessGrant | null,
  now: Date = new Date(),
): AiEntitlement {
  if (role === 'ADMIN') {
    return { premium: true, requestStatus: 'NOT_REQUIRED', canRequest: false };
  }

  const premium = isActive(grant, now);
  const requestStatus: AiAccessRequestStatus = !grant
    ? 'NONE'
    : grant.status === 'APPROVED' && !premium
      ? 'EXPIRED'
      : grant.status;

  return {
    premium,
    requestStatus,
    canRequest:
      !premium &&
      (requestStatus === 'NONE' ||
        requestStatus === 'REJECTED' ||
        requestStatus === 'EXPIRED'),
  };
}

/**
 * Explicit grant workflow for the premium assistant. A request is idempotent
 * and an admin decision writes the same APPROVED row a future paid checkout
 * would write, so adding billing changes the source, not the gate.
 */
@Injectable()
export class AiEntitlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: AiUsageService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  isConfigured(): boolean {
    return this.config.get('AI_PROVIDER', { infer: true }) !== 'disabled';
  }

  private findGrant(userId: string): Promise<AiAccessGrant | null> {
    return this.prisma.aiAccessGrant.findUnique({ where: { userId } });
  }

  async entitlement(user: AuthenticatedUser): Promise<AiEntitlement> {
    if (user.role === 'ADMIN') return aiEntitlement(user.role, null);
    return aiEntitlement(user.role, await this.findGrant(user.id));
  }

  async getAccess(user: AuthenticatedUser): Promise<AiAccessDto> {
    const [grant, usage] = await Promise.all([
      user.role === 'ADMIN' ? Promise.resolve(null) : this.findGrant(user.id),
      this.usage.snapshot(user.id),
    ]);
    const entitlement = aiEntitlement(user.role, grant);

    return {
      feature: AI_ASSISTANT_FEATURE,
      configured: this.isConfigured(),
      premium: entitlement.premium,
      requestStatus: entitlement.requestStatus,
      canRequest: entitlement.canRequest,
      source: grant?.source ?? null,
      expiresAt: grant?.expiresAt?.toISOString() ?? null,
      requestsToday: usage.requestsToday,
      tokensToday: usage.tokensToday,
      requestsPerDay: usage.requestsPerDay,
      tokensPerDay: usage.tokensPerDay,
    };
  }

  async requestAccess(user: AuthenticatedUser): Promise<AiAccessDto> {
    if (user.role === 'ADMIN') return this.getAccess(user);

    const existing = await this.findGrant(user.id);
    const now = new Date();
    if (existing && (existing.status === 'PENDING' || isActive(existing, now))) {
      return this.getAccess(user);
    }

    try {
      if (existing) {
        await this.prisma.aiAccessGrant.update({
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
        await this.prisma.aiAccessGrant.create({
          data: {
            userId: user.id,
            status: 'PENDING',
            source: 'REQUEST',
            requestedAt: now,
          },
        });
      }
    } catch (error) {
      // Two tabs may submit at once; the unique key picks one winner.
      if (!this.isUniqueViolation(error)) throw error;
    }

    return this.getAccess(user);
  }

  async listRequests(
    query: ListAiAccessQueryDto,
  ): Promise<{ data: AdminAiAccessRequestDto[] }> {
    const rows = await this.prisma.aiAccessGrant.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: { requestedAt: 'asc' },
      take: query.limit ?? 50,
      include: { user: { select: { email: true } } },
    });

    return {
      data: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        email: row.user.email,
        status: row.status,
        source: row.source,
        requestedAt: row.requestedAt.toISOString(),
        decidedAt: row.decidedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      })),
    };
  }

  async decide(
    adminId: string,
    id: string,
    dto: DecideAiAccessDto,
  ): Promise<AdminAiAccessRequestDto> {
    const existing = await this.prisma.aiAccessGrant.findUnique({
      where: { id },
      include: { user: { select: { email: true } } },
    });
    if (!existing) throw new NotFoundException('AI access request not found');
    if (existing.status !== 'PENDING') {
      throw new ConflictException('This request has already been decided');
    }

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    const row = await this.prisma.aiAccessGrant.update({
      where: { id },
      data: {
        status: dto.status,
        source: 'ADMIN',
        decidedAt: new Date(),
        decidedBy: adminId,
        expiresAt: dto.status === 'APPROVED' ? expiresAt : null,
      },
      include: { user: { select: { email: true } } },
    });

    return {
      id: row.id,
      userId: row.userId,
      email: row.user.email,
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
      (error as { code?: unknown }).code === 'P2002'
    );
  }
}
