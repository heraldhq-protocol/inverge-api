import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './create-test-app';
import { PrismaService } from '../src/prisma/prisma.service';

// FR-311/FR-406: draft -> application-fee charge -> signed webhook -> submit.
// Runs against Postgres and the stub flat-fee adapter.
describe('Application fee (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let creatorToken: string;
  let creatorId: string;
  let otherToken: string;
  let otherId: string;
  let unverifiedToken: string;
  let unverifiedId: string;

  const RUN = Date.now().toString(36);
  const campaignIds: string[] = [];

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function session(accessToken: string) {
    const res = await http()
      .post('/api/v1/auth/session')
      .send({ accessToken })
      .expect(201);
    return {
      id: res.body.user.id as string,
      token: res.body.sessionToken as string,
    };
  }

  async function createCampaign(ownerId: string, status: 'DRAFT' | 'ACTIVE' = 'DRAFT') {
    const campaign = await prisma.campaign.create({
      data: {
        creatorId: ownerId,
        deadline: new Date(Date.now() + 86_400_000),
        status,
        targetAmount: 1000,
        tokenType: 'USDC',
      },
    });
    campaignIds.push(campaign.id);
    return campaign.id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);

    await prisma.platformParam.upsert({
      where: { key: 'campaign.applicationFeeNGN' },
      update: { value: 10000 },
      create: { key: 'campaign.applicationFeeNGN', value: 10000 },
    });

    ({ id: creatorId, token: creatorToken } = await session(
      `stub:fee-c-${RUN}:fee-c-${RUN}@e2e.test#verified`,
    ));
    await prisma.user.update({
      where: { id: creatorId },
      data: { amlStatus: 'CLEAR', kycStatus: 'VERIFIED' },
    });

    ({ id: otherId, token: otherToken } = await session(
      `stub:fee-o-${RUN}:fee-o-${RUN}@e2e.test#verified`,
    ));
    await prisma.user.update({
      where: { id: otherId },
      data: { amlStatus: 'CLEAR', kycStatus: 'VERIFIED' },
    });

    // "Unverified" here means KYC, not email: the email gate must let the
    // request through so the KYC blocker is the one under test.
    ({ id: unverifiedId, token: unverifiedToken } = await session(
      `stub:fee-u-${RUN}:fee-u-${RUN}@e2e.test#verified`,
    ));
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
      await prisma.user.deleteMany({
        where: { id: { in: [creatorId, otherId, unverifiedId] } },
      });
    }
    if (app) await app.close();
  });

  it('creates one campaign-bound charge, resumes it, and settles it by webhook', async () => {
    const campaignId = await createCampaign(creatorId);

    const first = await http()
      .post(`/api/v1/campaigns/${campaignId}/application-fee`)
      .set(bearer(creatorToken))
      .expect(200);

    expect(first.body).toMatchObject({
      alreadyPaid: false,
      amount: 10000,
      currency: 'NGN',
      status: 'PENDING',
    });
    expect(first.body.chargeId).toBeTruthy();
    expect(first.body.redirectUrl).toContain('flat-fee/complete');
    expect(first.body).not.toHaveProperty('processorRef');

    const charge = await prisma.flatFeeCharge.findUniqueOrThrow({
      where: { id: first.body.chargeId },
    });
    expect(charge).toMatchObject({
      purpose: 'APPLICATION_FEE',
      status: 'PENDING',
      userId: creatorId,
    });
    expect(charge.metadata).toEqual({ campaignId });
    expect(charge.redirectUrl).toBe(first.body.redirectUrl);

    const resumed = await http()
      .post(`/api/v1/campaigns/${campaignId}/application-fee`)
      .set(bearer(creatorToken))
      .expect(200);
    expect(resumed.body.chargeId).toBe(first.body.chargeId);
    expect(resumed.body.redirectUrl).toBe(first.body.redirectUrl);
    expect(
      await prisma.flatFeeCharge.count({
        where: { userId: creatorId, purpose: 'APPLICATION_FEE' },
      }),
    ).toBe(1);

    await http()
      .post('/api/v1/flat-fee/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ processorRef: charge.processorRef, status: 'SUCCEEDED' }))
      .expect(200);

    const draft = await http()
      .get(`/api/v1/campaigns/${campaignId}/draft`)
      .set(bearer(creatorToken))
      .expect(200);
    expect(draft.body.applicationFee).toMatchObject({
      chargeId: first.body.chargeId,
      status: 'SUCCEEDED',
    });

    const submitted = await http()
      .post(`/api/v1/campaigns/${campaignId}/submit`)
      .set(bearer(creatorToken))
      .send({})
      .expect(201);
    expect(submitted.body).toMatchObject({
      applicationFeeChargeId: first.body.chargeId,
      reviewStatus: 'IN_REVIEW',
      status: 'IN_REVIEW',
    });

    const paidAgain = await http()
      .post(`/api/v1/campaigns/${campaignId}/application-fee`)
      .set(bearer(creatorToken))
      .expect(200);
    expect(paidAgain.body).toMatchObject({
      alreadyPaid: true,
      chargeId: first.body.chargeId,
      status: 'SUCCEEDED',
    });
  });

  it('refuses a charge for an unverified creator before calling the processor', async () => {
    const campaignId = await createCampaign(unverifiedId);

    const res = await http()
      .post(`/api/v1/campaigns/${campaignId}/application-fee`)
      .set(bearer(unverifiedToken))
      .expect(400);

    expect(res.body.error.code).toBe('VERIFICATION_REQUIRED');
    expect(res.body.error.details.blockers.join(' ')).toMatch(/Identity/);
    expect(
      await prisma.flatFeeCharge.count({
        where: { userId: unverifiedId, purpose: 'APPLICATION_FEE' },
      }),
    ).toBe(0);
  });

  it('refuses another account and a campaign that is no longer a draft', async () => {
    const campaignId = await createCampaign(creatorId);

    await http()
      .post(`/api/v1/campaigns/${campaignId}/application-fee`)
      .set(bearer(otherToken))
      .expect(403);

    const activeId = await createCampaign(creatorId, 'ACTIVE');
    await http()
      .post(`/api/v1/campaigns/${activeId}/application-fee`)
      .set(bearer(creatorToken))
      .expect(409);
  });
});
