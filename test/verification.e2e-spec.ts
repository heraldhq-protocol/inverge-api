// Force the offline, deterministic provider before AppModule is imported. The
// developer's .env points at Didit; an e2e suite must not depend on that.
process.env.KYC_PROVIDER = 'stub';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './create-test-app';
import { PrismaService } from '../src/prisma/prisma.service';

// End-to-end coverage of the verification domain against real Postgres and the stub
// provider. Covers auth, the individual and business lifecycles, the campaign gate's
// representative rule, webhook replay/staleness, the compliance review queue and the
// FR-104 contribution reservation under concurrency.
describe('Verification domain (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const PREFIX = `e2e-verification-${Date.now()}`;
  const campaignIds: string[] = [];

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  type U = { token: string; id: string };

  async function newUser(sub: string): Promise<U> {
    const res = await http()
      .post('/api/v1/auth/session')
      .send({ accessToken: `stub:${PREFIX}-${sub}:${PREFIX}-${sub}@e2e.test` })
      .expect(201);
    return { token: res.body.sessionToken, id: res.body.user.id };
  }

  function webhook(body: Record<string, unknown>) {
    return http().post('/api/v1/verification/webhook').send(body);
  }

  /** Completes a session through the stub provider's dev webhook path. */
  function complete(
    providerRef: string,
    userId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return webhook({
      aml: undefined,
      event_id: `evt-${providerRef}`,
      providerRef,
      status: 'VERIFIED',
      timestamp: Math.floor(Date.now() / 1000),
      vendor_data: userId,
      ...overrides,
    });
  }

  async function startSession(user: U, body: Record<string, unknown> = {}) {
    const res = await http()
      .post('/api/v1/verification/session')
      .set(auth(user.token))
      .send(body)
      .expect(201);
    return res.body as { caseId: string; providerRef: string; subject: string };
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      if (campaignIds.length > 0) {
        await prisma.contributionAuthorization.deleteMany({
          where: { campaignId: { in: campaignIds } },
        });
        await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
      }
      await prisma.user.deleteMany({
        where: { providerUserId: { startsWith: `did:privy:stub:${PREFIX}` } },
      });
    }
    if (app) await app.close();
  });

  // ─────────────── access control ───────────────
  describe('access control', () => {
    it('401 without a session on creator and admin routes', async () => {
      await http().get('/api/v1/verification/state').expect(401);
      await http().post('/api/v1/verification/session').send({}).expect(401);
      await http().get('/api/v1/verification/admin/cases').expect(401);
      await http().get('/api/v1/verification/admin/queues').expect(401);
    });

    it('403 for a normal user on every compliance route', async () => {
      const user = await newUser('not-reviewer');
      await http()
        .get('/api/v1/verification/admin/cases')
        .set(auth(user.token))
        .expect(403);
      await http()
        .get('/api/v1/verification/admin/queues')
        .set(auth(user.token))
        .expect(403);
      await http()
        .get('/api/v1/verification/admin/cases/anything')
        .set(auth(user.token))
        .expect(403);
      await http()
        .post('/api/v1/verification/admin/cases/anything/resolve')
        .set(auth(user.token))
        .send({
          decision: 'CLEAR',
          reason: 'Not a real case',
          reasonCode: 'TEST',
        })
        .expect(403);
    });
  });

  // ─────────────── individual lifecycle ───────────────
  describe('individual lifecycle', () => {
    it('starts unverified, then a webhook-completed session makes the creator eligible', async () => {
      const user = await newUser('individual');

      const untouched = await http()
        .get('/api/v1/verification/state')
        .set(auth(user.token))
        .expect(200);
      expect(untouched.body).toMatchObject({
        accountType: 'INDIVIDUAL',
        identityVerified: false,
        fundsCleared: false,
      });
      expect(untouched.body.individual).toBeNull();

      const gateBefore = await http()
        .get('/api/v1/verification/eligibility?purpose=CAMPAIGN_CREATOR')
        .set(auth(user.token))
        .expect(200);
      expect(gateBefore.body.eligible).toBe(false);
      expect(gateBefore.body.code).toBe('VERIFICATION_REQUIRED');

      const session = await startSession(user, { purpose: 'CAMPAIGN_CREATOR' });
      expect(session.subject).toBe('INDIVIDUAL');

      const pending = await http()
        .get('/api/v1/verification/state')
        .set(auth(user.token))
        .expect(200);
      expect(pending.body.overall).toBe('SESSION_CREATED');
      expect(pending.body.identityVerified).toBe(false);

      const applied = await complete(session.providerRef, user.id).expect(200);
      expect(applied.body.status).toBe('APPROVED');
      expect(applied.body.risk).toBe('CLEAR');

      const state = await http()
        .get('/api/v1/verification/state')
        .set(auth(user.token))
        .expect(200);
      expect(state.body).toMatchObject({
        identityVerified: true,
        fundsCleared: true,
        overall: 'APPROVED',
      });

      const gate = await http()
        .get('/api/v1/verification/eligibility?purpose=CAMPAIGN_CREATOR')
        .set(auth(user.token))
        .expect(200);
      expect(gate.body.eligible).toBe(true);
      expect(gate.body.code).toBeNull();

      // The legacy projection follows the case, so an already-verified account is not asked again.
      const legacy = await http()
        .get('/api/v1/kyc/status')
        .set(auth(user.token))
        .expect(200);
      expect(legacy.body).toMatchObject({
        amlStatus: 'CLEAR',
        kycStatus: 'VERIFIED',
      });
    });

    it('acknowledges a duplicate delivery without applying it twice', async () => {
      const user = await newUser('replay');
      const session = await startSession(user, { purpose: 'CAMPAIGN_CREATOR' });
      const eventId = `evt-replay-${session.providerRef}`;

      const first = await webhook({
        event_id: eventId,
        providerRef: session.providerRef,
        status: 'VERIFIED',
        timestamp: Math.floor(Date.now() / 1000),
        vendor_data: user.id,
      }).expect(200);
      expect(first.body.applied).toBe(true);

      const second = await webhook({
        event_id: eventId,
        providerRef: session.providerRef,
        status: 'VERIFIED',
        timestamp: Math.floor(Date.now() / 1000),
        vendor_data: user.id,
      }).expect(200);
      expect(second.body.replayed).toBe(true);

      const events = await prisma.verificationEvent.count({
        where: { providerEventReference: eventId },
      });
      expect(events).toBe(1);
    });

    it('refuses a stale event that would overwrite a newer approval', async () => {
      const user = await newUser('stale');
      const session = await startSession(user, { purpose: 'CAMPAIGN_CREATOR' });

      await webhook({
        event_id: `evt-fresh-${session.providerRef}`,
        providerRef: session.providerRef,
        status: 'VERIFIED',
        timestamp: Math.floor(Date.now() / 1000),
        vendor_data: user.id,
      }).expect(200);

      const stale = await webhook({
        event_id: `evt-stale-${session.providerRef}`,
        providerRef: session.providerRef,
        status: 'REJECTED',
        timestamp: Math.floor(Date.now() / 1000) - 3_600,
        vendor_data: user.id,
      }).expect(200);
      expect(stale.body).toMatchObject({ applied: false, stale: true });

      const state = await http()
        .get('/api/v1/verification/state')
        .set(auth(user.token))
        .expect(200);
      expect(state.body.overall).toBe('APPROVED');
      expect(state.body.identityVerified).toBe(true);
    });
  });

  // ─────────────── business lifecycle ───────────────
  describe('business lifecycle', () => {
    it('refuses business verification for an individual account', async () => {
      const user = await newUser('business-mismatch');
      const res = await http()
        .post('/api/v1/verification/session')
        .set(auth(user.token))
        .send({ subject: 'BUSINESS' })
        .expect(409);
      expect(res.body.error.code).toBe('VERIFICATION_ACCOUNT_TYPE_MISMATCH');
    });

    it('requires a registered business profile before KYB', async () => {
      const user = await newUser('business-no-profile');
      await http()
        .post('/api/v1/verification/account-type')
        .set(auth(user.token))
        .send({ accountType: 'BUSINESS' })
        .expect(201);

      const res = await http()
        .post('/api/v1/verification/session')
        .set(auth(user.token))
        .send({ subject: 'BUSINESS' })
        .expect(400);
      expect(res.body.error.code).toBe(
        'VERIFICATION_BUSINESS_PROFILE_REQUIRED',
      );
    });

    it('does not let a business approval stand in for the representative', async () => {
      const user = await newUser('business-representative');
      await http()
        .post('/api/v1/verification/account-type')
        .set(auth(user.token))
        .send({ accountType: 'BUSINESS' })
        .expect(201);

      const business = await http()
        .post('/api/v1/verification/business/session')
        .set(auth(user.token))
        .send({
          country: 'NG',
          legalName: `Kaduna AgriTech ${PREFIX} Ltd`,
          registrationNumber: 'RC-E2E-1',
        })
        .expect(201);
      expect(business.body.subject).toBe('BUSINESS');

      await complete(business.body.providerRef, user.id).expect(200);

      const state = await http()
        .get('/api/v1/verification/state')
        .set(auth(user.token))
        .expect(200);
      expect(state.body.accountType).toBe('BUSINESS');
      expect(state.body.business).toMatchObject({ status: 'APPROVED' });
      expect(state.body.individual).toBeNull();

      // The business is approved but the person behind it has not been verified.
      const blocked = await http()
        .get('/api/v1/verification/eligibility?purpose=CAMPAIGN_CREATOR')
        .set(auth(user.token))
        .expect(200);
      expect(blocked.body.eligible).toBe(false);
      expect(blocked.body.code).toBe('VERIFICATION_REQUIRED');
      expect(blocked.body.blockers).toContain(
        'Authorised representative identity',
      );

      const representative = await startSession(user, {});
      expect(representative.subject).toBe('INDIVIDUAL');
      await complete(representative.providerRef, user.id).expect(200);

      const cleared = await http()
        .get('/api/v1/verification/eligibility?purpose=CAMPAIGN_CREATOR')
        .set(auth(user.token))
        .expect(200);
      expect(cleared.body.eligible).toBe(true);
    });
  });

  // ─────────────── campaign gate ───────────────
  describe('campaign submission gate', () => {
    it('refuses submission with a stable code and never from a browser claim', async () => {
      const user = await newUser('campaign-gate');
      const campaign = await prisma.campaign.create({
        data: {
          creatorId: user.id,
          deadline: new Date(Date.now() + 86_400_000),
          targetAmount: 1000,
          tokenType: 'USDC',
        },
      });
      campaignIds.push(campaign.id);

      const res = await http()
        .post(`/api/v1/campaigns/${campaign.id}/submit`)
        .set(auth(user.token))
        .send({})
        .expect(400);
      expect(res.body.error.code).toBe('VERIFICATION_REQUIRED');
      expect(res.body.error.details.blockers.join(' ')).toMatch(
        /Identity document/,
      );

      const unchanged = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaign.id },
      });
      expect(unchanged.status).toBe('DRAFT');
    });
  });

  // ─────────────── compliance review ───────────────
  describe('compliance review', () => {
    it('queues an AML flag for a reviewer and resolves it with an audited reason', async () => {
      const user = await newUser('flagged');
      const reviewer = await newUser('reviewer');
      await prisma.user.update({
        where: { id: reviewer.id },
        data: { role: 'COMPLIANCE_REVIEWER' },
      });

      const session = await startSession(user, { purpose: 'CAMPAIGN_CREATOR' });
      await complete(session.providerRef, user.id, { aml: 'FLAGGED' }).expect(
        200,
      );

      const held = await http()
        .get('/api/v1/verification/state')
        .set(auth(user.token))
        .expect(200);
      expect(held.body.complianceHold).toBe(true);
      expect(held.body.fundsCleared).toBe(false);

      const gate = await http()
        .get('/api/v1/verification/eligibility?purpose=CAMPAIGN_CREATOR')
        .set(auth(user.token))
        .expect(200);
      expect(gate.body.code).toBe('VERIFICATION_COMPLIANCE_HOLD');

      const queues = await http()
        .get('/api/v1/verification/admin/queues')
        .set(auth(reviewer.token))
        .expect(200);
      expect(queues.body.policyVersion).toBeTruthy();
      expect(
        queues.body.escalated.some(
          (item: { id: string }) => item.id === session.caseId,
        ),
      ).toBe(true);

      const list = await http()
        .get('/api/v1/verification/admin/cases?risk=FLAGGED&requiresReview=true')
        .set(auth(reviewer.token))
        .expect(200);
      expect(
        list.body.items.some(
          (item: { id: string }) => item.id === session.caseId,
        ),
      ).toBe(true);

      const detail = await http()
        .get(`/api/v1/verification/admin/cases/${session.caseId}`)
        .set(auth(reviewer.token))
        .expect(200);
      expect(detail.body.case).toMatchObject({
        requiresHumanReview: true,
        riskOutcome: 'FLAGGED',
      });
      expect(detail.body.events.length).toBeGreaterThan(0);
      expect(JSON.stringify(detail.body)).not.toMatch(/documentNumber|selfie/i);

      const badReason = await http()
        .post(`/api/v1/verification/admin/cases/${session.caseId}/resolve`)
        .set(auth(reviewer.token))
        .send({ decision: 'CLEAR', reason: 'no', reasonCode: 'X' })
        .expect(400);
      expect(badReason.status).toBe(400);

      const resolved = await http()
        .post(`/api/v1/verification/admin/cases/${session.caseId}/resolve`)
        .set(auth(reviewer.token))
        .send({
          decision: 'CLEAR',
          reason: 'Matched a namesake; date of birth and nationality differ.',
          reasonCode: 'FALSE_POSITIVE',
        })
        .expect(201);
      expect(resolved.body).toMatchObject({
        caseId: session.caseId,
        risk: 'CLEAR',
      });

      const after = await http()
        .get('/api/v1/verification/state')
        .set(auth(user.token))
        .expect(200);
      expect(after.body.complianceHold).toBe(false);
      expect(after.body.fundsCleared).toBe(true);

      const audit = await prisma.verificationEvent.findFirst({
        where: {
          actorId: reviewer.id,
          caseId: session.caseId,
          eventType: 'risk.resolved',
        },
      });
      expect(audit?.reasonCode).toBe('FALSE_POSITIVE');

      // Nothing left to resolve: a second decision is a conflict, not another event.
      await http()
        .post(`/api/v1/verification/admin/cases/${session.caseId}/resolve`)
        .set(auth(reviewer.token))
        .send({
          decision: 'CLEAR',
          reason: 'Trying to resolve the same case twice.',
          reasonCode: 'FALSE_POSITIVE',
        })
        .expect(409);
    });
  });

  // ─────────────── FR-104 threshold ───────────────
  describe('contribution threshold', () => {
    it('serialises concurrent authorisations so only one fits under the limit', async () => {
      const user = await newUser('backer');
      const campaign = await prisma.campaign.create({
        data: {
          creatorId: user.id,
          deadline: new Date(Date.now() + 86_400_000),
          status: 'ACTIVE',
          targetAmount: 1000,
          tokenType: 'USDC',
        },
      });
      campaignIds.push(campaign.id);

      const authorize = (amountUsd: number) =>
        http()
          .post('/api/v1/verification/contributions/authorize')
          .set(auth(user.token))
          .send({ amountUsd, campaignId: campaign.id });

      const [a, b] = await Promise.all([authorize(150), authorize(150)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 403]);

      const blocked = a.status === 403 ? a : b;
      expect(blocked.body.error.code).toBe('CONTRIBUTION_THRESHOLD_EXCEEDED');

      const rows = await prisma.contributionAuthorization.findMany({
        where: { campaignId: campaign.id },
        select: { status: true },
      });
      expect(rows.filter((row) => row.status === 'ALLOWED')).toHaveLength(1);
      expect(rows.filter((row) => row.status === 'BLOCKED')).toHaveLength(1);
    });

    it('validates the amount and the campaign before reserving', async () => {
      const user = await newUser('backer-validation');

      await http()
        .post('/api/v1/verification/contributions/authorize')
        .set(auth(user.token))
        .send({ amountUsd: 0, campaignId: 'x' })
        .expect(400);

      await http()
        .post('/api/v1/verification/contributions/authorize')
        .set(auth(user.token))
        .send({ amountUsd: 10, campaignId: 'no-such-campaign' })
        .expect(404);
    });
  });
});
