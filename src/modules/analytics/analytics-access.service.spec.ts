import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsAccessService } from './analytics-access.service';

const USER = {
  id: 'user-1',
  role: 'USER' as const,
  bannedAt: null,
  kycStatus: 'NOT_REQUIRED',
  amlStatus: 'NOT_SCREENED',
  displayName: 'Ada',
  username: 'ada',
} as unknown as AuthenticatedUser;
const ADMIN = {
  ...USER,
  id: 'admin-1',
  role: 'ADMIN' as const,
} as AuthenticatedUser;

interface GrantRow {
  id: string;
  userId: string;
  feature: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  source: 'REQUEST' | 'ADMIN' | 'PAID';
  requestedAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  expiresAt: Date | null;
  externalReference: string | null;
}

function setup(initial: GrantRow | null = null) {
  let grant = initial;
  const findGrant = jest.fn(async () => grant);
  const create = jest.fn(async ({ data }: { data: Partial<GrantRow> }) => {
    grant = {
      id: 'grant-1',
      userId: data.userId!,
      feature: data.feature!,
      status: data.status ?? 'PENDING',
      source: data.source ?? 'REQUEST',
      requestedAt: data.requestedAt ?? new Date(),
      decidedAt: null,
      decidedBy: null,
      expiresAt: null,
      externalReference: null,
    };
    return grant;
  });
  const update = jest.fn(
    async ({ data }: { where: { id: string }; data: Partial<GrantRow> }) => {
      grant = { ...grant!, ...data };
      return {
        ...grant,
        user: {
          email: 'ada@example.test',
          creatorProfile: {
            displayName: 'Ada',
            username: 'ada',
            tier: 'STARTER' as const,
          },
        },
      };
    },
  );
  const findProfile = jest.fn(async () => ({ tier: 'STARTER' as const }));
  const findMany = jest.fn(async () => []);
  const upsert = jest.fn(async ({ create: createData }: { create: GrantRow }) => {
    grant = createData;
    return grant;
  });
  const findById = jest.fn(async () => grant);

  const prisma = {
    creatorProfile: { findUnique: findProfile },
    analyticsAccessGrant: {
      findUnique: jest.fn(async ({ where }: { where: { id?: string } }) =>
        where.id ? findById() : findGrant(),
      ),
      create,
      update,
      findMany,
      upsert,
    },
  } as unknown as PrismaService;

  return { svc: new AnalyticsAccessService(prisma), create, update, findMany, upsert };
}

describe('AnalyticsAccessService', () => {
  it('creates a pending request for an account with no grant', async () => {
    // #given a creator with no access row
    const { svc, create } = setup();

    // #when they request premium analytics
    const access = await svc.requestAccess(USER);

    // #then a pending request exists and the CTA is hidden
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER.id,
        feature: 'analytics.premium',
        status: 'PENDING',
        source: 'REQUEST',
      }),
    });
    expect(access).toMatchObject({
      premium: false,
      requestStatus: 'PENDING',
      canRequest: false,
    });
  });

  it('returns a pending request without creating a duplicate', async () => {
    // #given an existing pending request
    const pending: GrantRow = {
      id: 'grant-1',
      userId: USER.id,
      feature: 'analytics.premium',
      status: 'PENDING',
      source: 'REQUEST',
      requestedAt: new Date(),
      decidedAt: null,
      decidedBy: null,
      expiresAt: null,
      externalReference: null,
    };
    const { svc, create, update } = setup(pending);

    // #when the creator requests again
    const access = await svc.requestAccess(USER);

    // #then the row is unchanged
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(access.requestStatus).toBe('PENDING');
  });

  it('lets a rejected account request again', async () => {
    // #given a rejected request
    const rejected: GrantRow = {
      id: 'grant-1',
      userId: USER.id,
      feature: 'analytics.premium',
      status: 'REJECTED',
      source: 'REQUEST',
      requestedAt: new Date('2026-10-01T00:00:00.000Z'),
      decidedAt: new Date('2026-10-02T00:00:00.000Z'),
      decidedBy: 'admin-1',
      expiresAt: null,
      externalReference: null,
    };
    const { svc, update } = setup(rejected);

    // #when the creator asks again
    const access = await svc.requestAccess(USER);

    // #then the row returns to pending and the decision is cleared
    expect(update).toHaveBeenCalledWith({
      where: { id: rejected.id },
      data: expect.objectContaining({
        status: 'PENDING',
        decidedAt: null,
        decidedBy: null,
      }),
    });
    expect(access.requestStatus).toBe('PENDING');
  });

  it('does not reset an active approval', async () => {
    // #given an approved grant with no expiry
    const approved: GrantRow = {
      id: 'grant-1',
      userId: USER.id,
      feature: 'analytics.premium',
      status: 'APPROVED',
      source: 'REQUEST',
      requestedAt: new Date('2026-10-01T00:00:00.000Z'),
      decidedAt: new Date('2026-10-02T00:00:00.000Z'),
      decidedBy: 'admin-1',
      expiresAt: null,
      externalReference: null,
    };
    const { svc, create, update } = setup(approved);

    // #when the creator requests again
    const access = await svc.requestAccess(USER);

    // #then premium stays open and nothing is written
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(access).toMatchObject({
      premium: true,
      requestStatus: 'APPROVED',
      canRequest: false,
    });
  });

  it('reopens an expired paid grant as a pending request', async () => {
    // #given a paid grant that expired yesterday
    const expired: GrantRow = {
      id: 'grant-1',
      userId: USER.id,
      feature: 'analytics.premium',
      status: 'APPROVED',
      source: 'PAID',
      requestedAt: new Date('2026-09-01T00:00:00.000Z'),
      decidedAt: new Date('2026-09-01T00:00:00.000Z'),
      decidedBy: null,
      expiresAt: new Date('2026-10-24T00:00:00.000Z'),
      externalReference: 'pay-1',
    };
    const { svc, update } = setup(expired);

    // #when the creator asks again
    const access = await svc.requestAccess(USER);

    // #then the expired grant becomes a new pending request
    expect(update).toHaveBeenCalledWith({
      where: { id: expired.id },
      data: expect.objectContaining({
        status: 'PENDING',
        source: 'REQUEST',
        expiresAt: null,
        externalReference: null,
      }),
    });
    expect(access.requestStatus).toBe('PENDING');
  });

  it('approves a pending request and records the deciding admin', async () => {
    // #given a pending request
    const pending: GrantRow = {
      id: 'grant-1',
      userId: USER.id,
      feature: 'analytics.premium',
      status: 'PENDING',
      source: 'REQUEST',
      requestedAt: new Date('2026-10-01T00:00:00.000Z'),
      decidedAt: null,
      decidedBy: null,
      expiresAt: null,
      externalReference: null,
    };
    const { svc, update } = setup(pending);

    // #when an admin approves it
    const decided = await svc.decide(ADMIN.id, pending.id, {
      status: 'APPROVED',
    });

    // #then the grant is approved and the decision is attributed
    expect(update).toHaveBeenCalledWith({
      where: { id: pending.id },
      data: expect.objectContaining({
        status: 'APPROVED',
        decidedBy: ADMIN.id,
      }),
      select: expect.any(Object),
    });
    expect(decided).toMatchObject({
      id: pending.id,
      status: 'APPROVED',
      source: 'REQUEST',
    });
  });

  it('rejects an expiry in the past', async () => {
    // #given a pending request
    const pending: GrantRow = {
      id: 'grant-1',
      userId: USER.id,
      feature: 'analytics.premium',
      status: 'PENDING',
      source: 'REQUEST',
      requestedAt: new Date(),
      decidedAt: null,
      decidedBy: null,
      expiresAt: null,
      externalReference: null,
    };
    const { svc } = setup(pending);

    // #when an admin approves with an expiry that has already passed
    const decision = svc.decide(ADMIN.id, pending.id, {
      status: 'APPROVED',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });

    // #then the request fails without writing
    await expect(decision).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s an unknown request id', async () => {
    // #given no grant with that id
    const { svc } = setup(null);

    // #when an admin decides it
    const decision = svc.decide(ADMIN.id, 'missing', { status: 'APPROVED' });

    // #then it is indistinguishable from any other missing row
    await expect(decision).rejects.toBeInstanceOf(NotFoundException);
  });

  it('issues a paid grant through the future paid-wall entry point', async () => {
    // #given a checkout callback with a paid-through instant
    const { svc, upsert } = setup(null);
    const paidThrough = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // #when access is granted
    await svc.grantPaidAccess(USER.id, paidThrough, 'pay-123');

    // #then the row is approved, paid-sourced and expiring
    expect(upsert).toHaveBeenCalledWith({
      where: {
        userId_feature: {
          userId: USER.id,
          feature: 'analytics.premium',
        },
      },
      create: expect.objectContaining({
        status: 'APPROVED',
        source: 'PAID',
        expiresAt: paidThrough,
        externalReference: 'pay-123',
      }),
      update: expect.objectContaining({
        status: 'APPROVED',
        source: 'PAID',
        expiresAt: paidThrough,
      }),
    });
  });
});
