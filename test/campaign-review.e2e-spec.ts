import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './create-test-app';
import { PrismaService } from '../src/prisma/prisma.service';

// FR-304 review state + FR-103/FR-311 submission gates against real Postgres.
describe('Campaign review (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let adminId: string;
  let creatorToken: string;
  let creatorId: string;

  const RUN = Date.now().toString(36);
  const campaignIds: string[] = [];
  let queuedCampaignId = '';

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const reason =
    'Please tighten the milestone evidence definitions before publication.';

  async function session(accessToken: string) {
    const res = await http()
      .post('/api/v1/auth/session')
      .send({ accessToken })
      .expect(201);
    return {
      token: res.body.sessionToken as string,
      id: res.body.user.id as string,
    };
  }

  async function createCampaign(): Promise<string> {
    const campaign = await prisma.campaign.create({
      data: {
        creatorId,
        tokenType: 'USDC',
        targetAmount: 1000,
        deadline: new Date(Date.now() + 86_400_000),
      },
    });
    campaignIds.push(campaign.id);
    return campaign.id;
  }

  async function createFee(
    label: string,
    overrides: {
      purpose?: 'APPLICATION_FEE' | 'BOOST';
      status?: 'PENDING' | 'SUCCEEDED' | 'FAILED';
      metadata?: object;
    } = {},
  ): Promise<string> {
    const fee = await prisma.flatFeeCharge.create({
      data: {
        userId: creatorId,
        purpose: overrides.purpose ?? 'APPLICATION_FEE',
        amount: 10000,
        currency: 'NGN',
        processorRef: `fee-${RUN}-${label}`,
        status: overrides.status ?? 'SUCCEEDED',
        metadata: overrides.metadata,
      },
    });
    return fee.id;
  }

  function submit(campaignId: string, applicationFeeChargeId?: string) {
    return http()
      .post(`/api/v1/campaigns/${campaignId}/submit`)
      .set(bearer(creatorToken))
      .send(applicationFeeChargeId ? { applicationFeeChargeId } : {});
  }

  function decide(
    campaignId: string,
    body: { action?: string; reason?: string },
  ) {
    return http()
      .post(`/api/v1/admin/campaigns/${campaignId}/review`)
      .set(bearer(adminToken))
      .send(body);
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);

    ({ token: adminToken, id: adminId } = await session(`a${RUN}`));
    await prisma.user.update({
      where: { id: adminId },
      data: { role: 'ADMIN' },
    });
    ({ token: creatorToken, id: creatorId } = await session(`c${RUN}`));
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
      await prisma.flatFeeCharge.deleteMany({
        where: { processorRef: { startsWith: `fee-${RUN}-` } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [adminId, creatorId] } },
      });
    }
    if (app) await app.close();
  });

  it('denies the review surface to unauthenticated and non-admin callers', async () => {
    await http().get('/api/v1/admin/campaigns').expect(401);
    await http().get('/api/v1/admin/campaigns').set(bearer(creatorToken)).expect(403);
    await http()
      .get('/api/v1/admin/campaigns/anything')
      .set(bearer(creatorToken))
      .expect(403);
    await http()
      .post('/api/v1/admin/campaigns/anything/review')
      .set(bearer(creatorToken))
      .send({ action: 'APPROVE' })
      .expect(403);
  });

  it('refuses submission before KYC and before the application fee', async () => {
    const campaignId = await createCampaign();

    const noKyc = await submit(campaignId).expect(400);
    expect(noKyc.body.error.code).toBe('VERIFICATION_REQUIRED');
    expect(noKyc.body.error.details.blockers.join(' ')).toMatch(
      /Identity document/,
    );
    expect(noKyc.body.error.details.blockers.join(' ')).toMatch(/Application fee/);

    let campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
    });
    expect(campaign.status).toBe('DRAFT');
    expect(campaign.reviewStatus).toBe('NOT_SUBMITTED');

    await prisma.user.update({
      where: { id: creatorId },
      data: { kycStatus: 'VERIFIED', amlStatus: 'CLEAR' },
    });

    const noFee = await submit(campaignId).expect(400);
    expect(noFee.body.error.details.blockers).toContain(
      'Application fee (FR-311) has not been paid',
    );
    expect(noFee.body.error.details.blockers.join(' ')).not.toMatch(
      /Identity document/,
    );

    campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
    });
    expect(campaign.status).toBe('DRAFT');
    expect(campaign.reviewStatus).toBe('NOT_SUBMITTED');
  });

  it('links a successful application fee and enters the review queue', async () => {
    const campaignId = await createCampaign();
    const feeId = await createFee('main');

    const res = await submit(campaignId, feeId).expect(201);
    expect(res.body).toMatchObject({
      id: campaignId,
      status: 'IN_REVIEW',
      reviewStatus: 'IN_REVIEW',
      applicationFeeChargeId: feeId,
    });
    expect(res.body.submittedAt).toBeTruthy();
    queuedCampaignId = campaignId;

    const secondCampaign = await createCampaign();
    const reuse = await submit(secondCampaign, feeId);
    expect(reuse.status).toBeGreaterThanOrEqual(400);
    expect(reuse.body.error.message).toMatch(/application fee/i);
  });

  it('shows the queue and read-only FR-103/FR-311 facts to an admin', async () => {
    const queue = await http()
      .get('/api/v1/admin/campaigns')
      .set(bearer(adminToken))
      .expect(200);
    expect(queue.body.items.length).toBeGreaterThan(0);
    expect(queue.body.items[0]).toHaveProperty('reviewStatus');

    const queued = queue.body.items.find(
      (item: { id: string }) => item.id === queuedCampaignId,
    );
    expect(queued).toMatchObject({ reviewStatus: 'IN_REVIEW' });

    const detail = await http()
      .get(`/api/v1/admin/campaigns/${queuedCampaignId}`)
      .set(bearer(adminToken))
      .expect(200);

    expect(detail.body.campaign.reviewStatus).toBe('IN_REVIEW');
    expect(detail.body.applicationFee).toMatchObject({
      purpose: 'APPLICATION_FEE',
      status: 'SUCCEEDED',
    });
    expect(detail.body.preconditions.eligible).toBe(true);
    expect(detail.body.preconditions.checks).toHaveLength(2);
    expect(detail.body.reviewEvents).toEqual([]);

    const serialised = JSON.stringify(detail.body);
    expect(serialised).not.toContain('kycProviderRef');
    expect(serialised).not.toContain('kybProviderRef');
    expect(serialised).not.toContain('processorRef');
  });

  it('refuses short or missing reasons without writing a decision', async () => {
    const campaignId = queuedCampaignId;

    await decide(campaignId, {
      action: 'REQUEST_CHANGES',
      reason: 'too short',
    }).expect(400);
    await decide(campaignId, {}).expect(400);
    await decide(campaignId, {
      action: 'APPROVE',
      reason: 'x'.repeat(2001),
    }).expect(400);

    const campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
    });
    expect(campaign.reviewStatus).toBe('IN_REVIEW');
    expect(
      await prisma.campaignReviewEvent.count({ where: { campaignId } }),
    ).toBe(0);
  });

  it('requests changes, then accepts a resubmission without a second fee', async () => {
    const campaignId = queuedCampaignId;
    const before = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
    });

    const res = await decide(campaignId, {
      action: 'REQUEST_CHANGES',
      reason: `  ${reason}  `,
    }).expect(201);

    expect(res.body.reviewStatus).toBe('CHANGES_REQUESTED');
    expect(res.body.reviewReason).toBe(reason);
    expect(res.body.event).toMatchObject({
      action: 'REQUEST_CHANGES',
      fromStatus: 'IN_REVIEW',
      toStatus: 'CHANGES_REQUESTED',
      reason,
      actor: { id: adminId },
    });

    const changed = await http()
      .get('/api/v1/admin/campaigns')
      .query({ reviewStatus: 'CHANGES_REQUESTED' })
      .set(bearer(adminToken))
      .expect(200);
    expect(
      changed.body.items.some((item: { id: string }) => item.id === campaignId),
    ).toBe(true);

    const resubmitted = await submit(campaignId).expect(201);
    expect(resubmitted.body.reviewStatus).toBe('IN_REVIEW');
    expect(resubmitted.body.reviewReason).toBeNull();
    expect(resubmitted.body.applicationFeeChargeId).toBe(
      before.applicationFeeChargeId,
    );
  });

  it('approves without publishing and refuses a second decision', async () => {
    const campaignId = queuedCampaignId;

    const res = await decide(campaignId, { action: 'APPROVE' }).expect(201);
    expect(res.body.reviewStatus).toBe('APPROVED');
    expect(res.body.reviewReason).toBeNull();

    const campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
    });
    // Approval clears curation only; publication stays a separate step.
    expect(campaign.status).toBe('IN_REVIEW');
    expect(campaign.launchedAt).toBeNull();

    await decide(campaignId, { action: 'APPROVE' }).expect(409);

    const events = await prisma.campaignReviewEvent.findMany({
      where: { campaignId },
      orderBy: { createdAt: 'desc' },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      action: 'APPROVE',
      fromStatus: 'IN_REVIEW',
      toStatus: 'APPROVED',
      actorId: adminId,
    });
  });

  it('blocks approval when KYC is revoked after submission', async () => {
    const campaignId = await createCampaign();
    const feeId = await createFee('revoked');
    await submit(campaignId, feeId).expect(201);

    await prisma.user.update({
      where: { id: creatorId },
      data: { kycStatus: 'REJECTED' },
    });

    const res = await decide(campaignId, { action: 'APPROVE' }).expect(422);
    expect(res.body.error.code).toBe('VERIFICATION_DECLINED');
    expect(res.body.error.details.blockers.join(' ')).toMatch(
      /Identity document/,
    );

    const campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
    });
    expect(campaign.reviewStatus).toBe('IN_REVIEW');
    expect(
      await prisma.campaignReviewEvent.count({ where: { campaignId } }),
    ).toBe(0);

    await prisma.user.update({
      where: { id: creatorId },
      data: { kycStatus: 'VERIFIED' },
    });
  });

  it('rejects terminally with a reason and refuses resubmission', async () => {
    const campaignId = await createCampaign();
    const feeId = await createFee('rejected');
    await submit(campaignId, feeId).expect(201);

    const res = await decide(campaignId, {
      action: 'REJECT',
      reason,
    }).expect(201);
    expect(res.body.reviewStatus).toBe('REJECTED');

    await submit(campaignId).expect(409);

    const event = await prisma.campaignReviewEvent.findFirstOrThrow({
      where: { campaignId },
    });
    expect(event).toMatchObject({
      action: 'REJECT',
      toStatus: 'REJECTED',
      reason,
      actorId: adminId,
    });
  });

  it('404s for an unknown campaign', async () => {
    await http()
      .get('/api/v1/admin/campaigns/does-not-exist')
      .set(bearer(adminToken))
      .expect(404);
    await decide('does-not-exist', { action: 'APPROVE' }).expect(404);
  });
});
