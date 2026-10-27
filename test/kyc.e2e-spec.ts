// Force the offline, deterministic KYC provider for e2e (dotenv won't override an existing
// process.env var, so this wins over KYC_PROVIDER in .env). Must run before AppModule loads.
process.env.KYC_PROVIDER = 'stub';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './create-test-app';
import { PrismaService } from '../src/prisma/prisma.service';

// End-to-end coverage of the KYC/AML routes against real Postgres, using the stub provider so
// the hosted flow is simulated deterministically via GET /kyc/dev-complete. Covers auth guards,
// purpose-driven sessions, the webhook/decision transition, eligibility gates (FR-103/104),
// admin standalone AML screening + retained history, and the AML→moderation-harness L1 gate.
// Users carry a run-unique prefix and are deleted in afterAll (cascade).
describe('KYC/AML routes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const PREFIX = `e2e-kyc-${Date.now()}`;
  const http = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  type U = { token: string; id: string };
  async function newUser(sub: string): Promise<U> {
    const res = await http()
      .post('/api/v1/auth/session')
      .send({ accessToken: `stub:${PREFIX}-${sub}:${PREFIX}-${sub}@e2e.test` })
      .expect(201);
    return { token: res.body.sessionToken, id: res.body.user.id };
  }

  // Simulate the user finishing the hosted flow (stub provider only).
  const complete = (ref: string, userId: string, q: Record<string, string> = {}) =>
    http().get('/api/v1/kyc/dev-complete').query({ ref, user: userId, ...q });

  const validIdea = {
    title: 'AML E2E Idea',
    problem: 'Smallholder farmers lack credit history so lenders reject them outright.',
    solution: 'Drone and satellite yield estimates become an alternative credit score banks trust.',
    targetUser: 'smallholder maize farmers in Kaduna',
    currentAlternative: 'lenders rely on slow manual farm visits that rarely happen at all.',
    askBreakdown: { drones: 8000, staff: 12000 },
    roadmapSteps: [
      { date: '2026-Q1', description: 'pilot 200 farms' },
      { date: '2026-Q2', description: 'lender API live' },
    ],
    category: 'agritech',
    askAmount: 25000,
    creatorPrePledgeTarget: 800,
  };

  let admin: U;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await newUser('admin');
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
  });

  afterAll(async () => {
    if (prisma) await prisma.user.deleteMany({ where: { providerUserId: { startsWith: `did:privy:stub:${PREFIX}` } } });
    if (app) await app.close();
  });

  // ─────────────── Security: auth guards ───────────────
  describe('auth guards', () => {
    it('401 without a token on protected reads/writes', async () => {
      await http().get('/api/v1/kyc/status').expect(401);
      await http().post('/api/v1/kyc/session').send({}).expect(401);
      await http().get('/api/v1/kyc/eligibility').expect(401);
      await http().post('/api/v1/kyc/admin/aml-screen').send({ userId: 'x', fullName: 'y z' }).expect(401);
    });

    it('403 for a non-admin on admin routes', async () => {
      const u = await newUser('nonadmin');
      await http()
        .post('/api/v1/kyc/admin/aml-screen')
        .set(auth(u.token))
        .send({ userId: u.id, fullName: 'Jane Doe' })
        .expect(403);
      await http().get(`/api/v1/kyc/admin/aml/${u.id}`).set(auth(u.token)).expect(403);
    });
  });

  // ─────────────── Sessions + validation ───────────────
  describe('start session', () => {
    it('defaults to IDEA_VALIDATION and moves status to PENDING', async () => {
      const u = await newUser('idea-start');
      const res = await http().post('/api/v1/kyc/session').set(auth(u.token)).send({}).expect(201);
      expect(res.body.purpose).toBe('IDEA_VALIDATION');
      expect(res.body.providerRef).toBeTruthy();
      expect(res.body.verificationUrl).toContain('ref=');
      const status = await http().get('/api/v1/kyc/status').set(auth(u.token)).expect(200);
      expect(status.body.kycStatus).toBe('PENDING');
    });

    it('accepts an explicit CAMPAIGN_CREATOR purpose', async () => {
      const u = await newUser('creator-start');
      const res = await http()
        .post('/api/v1/kyc/session')
        .set(auth(u.token))
        .send({ purpose: 'CAMPAIGN_CREATOR' })
        .expect(201);
      expect(res.body.purpose).toBe('CAMPAIGN_CREATOR');
    });

    it('rejects an unknown purpose (400) and extra fields (400, whitelist)', async () => {
      const u = await newUser('bad-purpose');
      await http().post('/api/v1/kyc/session').set(auth(u.token)).send({ purpose: 'NOPE' }).expect(400);
      await http()
        .post('/api/v1/kyc/session')
        .set(auth(u.token))
        .send({ purpose: 'IDEA_VALIDATION', sneaky: 'x' })
        .expect(400);
    });
  });

  // ─────────────── Idea-validation completion ───────────────
  describe('idea-validation flow', () => {
    it('completing identity KYC → VERIFIED, no AML, and IDEA_VALIDATION becomes eligible', async () => {
      const u = await newUser('idea-complete');
      const { body } = await http().post('/api/v1/kyc/session').set(auth(u.token)).send({}).expect(201);
      await complete(body.providerRef, u.id).expect(200);

      const status = await http().get('/api/v1/kyc/status').set(auth(u.token)).expect(200);
      expect(status.body.kycStatus).toBe('VERIFIED');
      expect(status.body.amlStatus).toBe('NOT_SCREENED'); // identity workflow ran no AML

      const idea = await http()
        .get('/api/v1/kyc/eligibility?purpose=IDEA_VALIDATION')
        .set(auth(u.token))
        .expect(200);
      expect(idea.body.eligible).toBe(true);

      // ...but the funds bar (creator) still needs AML.
      const creator = await http()
        .get('/api/v1/kyc/eligibility?purpose=CAMPAIGN_CREATOR')
        .set(auth(u.token))
        .expect(200);
      expect(creator.body.eligible).toBe(false);
      expect(creator.body.code).toBe('VERIFICATION_REQUIRED');
      expect(creator.body.blockers).toContain(
        'Sanctions, PEP and adverse-media screening',
      );
      // Legacy alias for the same list while old clients migrate.
      expect(creator.body.reasons).toEqual(creator.body.blockers);

      // FR-105 audit trail: a status event was recorded.
      const events = await prisma.kycStatusEvent.count({ where: { userId: u.id } });
      expect(events).toBeGreaterThan(0);
    });
  });

  // ─────────────── Creator completion (KYC + AML) ───────────────
  describe('creator flow (KYC + AML)', () => {
    it('completing KYC+AML → VERIFIED + AML CLEAR, records a KYC_SESSION screening, eligible', async () => {
      const u = await newUser('creator-complete');
      const { body } = await http()
        .post('/api/v1/kyc/session')
        .set(auth(u.token))
        .send({ purpose: 'CAMPAIGN_CREATOR' })
        .expect(201);
      await complete(body.providerRef, u.id).expect(200);

      const status = await http().get('/api/v1/kyc/status').set(auth(u.token)).expect(200);
      expect(status.body.kycStatus).toBe('VERIFIED');
      expect(status.body.amlStatus).toBe('CLEAR');

      const elig = await http()
        .get('/api/v1/kyc/eligibility?purpose=CAMPAIGN_CREATOR')
        .set(auth(u.token))
        .expect(200);
      expect(elig.body.eligible).toBe(true);

      const screenings = await prisma.amlScreening.findMany({ where: { userId: u.id } });
      expect(screenings).toHaveLength(1);
      expect(screenings[0].source).toBe('KYC_SESSION');
      expect(screenings[0].status).toBe('CLEAR');
    });
  });

  // ─────────────── Rejected identity ───────────────
  describe('rejected identity', () => {
    it('a declined result sets REJECTED and blocks eligibility', async () => {
      const u = await newUser('rejected');
      const { body } = await http().post('/api/v1/kyc/session').set(auth(u.token)).send({}).expect(201);
      await complete(body.providerRef, u.id, { status: 'REJECTED' }).expect(200);

      const status = await http().get('/api/v1/kyc/status').set(auth(u.token)).expect(200);
      expect(status.body.kycStatus).toBe('REJECTED');
      const elig = await http()
        .get('/api/v1/kyc/eligibility?purpose=IDEA_VALIDATION')
        .set(auth(u.token))
        .expect(200);
      expect(elig.body.eligible).toBe(false);
      expect(elig.body.code).toBe('VERIFICATION_DECLINED');
      expect(elig.body.blockers).toContain(
        'Identity document, selfie and liveness',
      );
    });
  });

  // ─────────────── Admin standalone AML ───────────────
  describe('admin standalone AML screening', () => {
    it('flags a sanctioned name, sets amlStatus, and retains the record; history reads back', async () => {
      const u = await newUser('screened');
      await http()
        .post('/api/v1/kyc/admin/aml-screen')
        .set(auth(admin.token))
        .send({ userId: u.id, fullName: 'OFAC Sanction Test', nationality: 'NG' })
        .expect(201)
        .then((r) => expect(r.body.status).toBe('FLAGGED'));

      const status = await http().get('/api/v1/kyc/status').set(auth(u.token)).expect(200);
      expect(status.body.amlStatus).toBe('FLAGGED');

      const history = await http()
        .get(`/api/v1/kyc/admin/aml/${u.id}`)
        .set(auth(admin.token))
        .expect(200);
      expect(history.body).toHaveLength(1);
      expect(history.body[0]).toMatchObject({ source: 'STANDALONE', status: 'FLAGGED' });
    });

    it('clears a benign name', async () => {
      const u = await newUser('screened-clean');
      await http()
        .post('/api/v1/kyc/admin/aml-screen')
        .set(auth(admin.token))
        .send({ userId: u.id, fullName: 'Jane Adaeze Okoro' })
        .expect(201)
        .then((r) => expect(r.body.status).toBe('CLEAR'));
    });
  });

  // ─────────────── Webhook robustness ───────────────
  describe('webhook', () => {
    it('ignores a callback for an unknown session (200 ignored)', async () => {
      // A fresh ref per run: the inbox remembers an ignored event, and a replay
      // correctly returns 200 without re-applying. Reusing a literal ref would
      // make this suite pass only on a database that has never seen it.
      await http()
        .post('/api/v1/kyc/webhook')
        .send({
          providerRef: `no-such-session-${Date.now()}`,
          vendor_data: 'nobody',
          status: 'VERIFIED',
        })
        .expect(200)
        .then((r) => expect(r.body.ignored).toBe(true));
    });
  });

  // ─────────────── AML → moderation harness L1 gate ───────────────
  describe('AML feeds the moderation harness', () => {
    it('an AML-flagged creator publishing an idea is HELD with a tipping-off-safe reason', async () => {
      const u = await newUser('flagged-creator');
      // Flag them via a standalone screen.
      await http()
        .post('/api/v1/kyc/admin/aml-screen')
        .set(auth(admin.token))
        .send({ userId: u.id, fullName: 'Known OFAC Sanction Name' })
        .expect(201);

      // Create + publish an idea (publish awaits the moderation screen).
      const created = await http().post('/api/v1/ideas').set(auth(u.token)).send(validIdea).expect(201);
      const ideaId = created.body.id;
      await http().post(`/api/v1/ideas/${ideaId}/publish`).set(auth(u.token)).expect(201);

      const kase = await prisma.moderationCase.findFirst({
        where: { ideaId, submittedById: u.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(kase).toBeTruthy();
      expect(kase!.decision).toBe('HELD_FOR_REVIEW');
      expect(kase!.reasonCodes).toContain('L1-SUBMITTER-SANCTIONED');
      // FR-1007: the creator-facing reason discloses nothing about the sanctions review.
      expect(kase!.externalReason).not.toMatch(/sanction/i);
    });
  });

  // ─────────────── Business (KYB) ───────────────
  describe('business (KYB) flow', () => {
    it('401/403/400 guards on the /kyb surface', async () => {
      await http().post('/api/v1/kyb/session').send({ legalName: 'X Ltd' }).expect(401);
      await http().get('/api/v1/kyb/status').expect(401);
      const u = await newUser('kyb-guard');
      await http().post('/api/v1/kyb/session').set(auth(u.token)).send({}).expect(400); // legalName required
      await http()
        .post('/api/v1/kyb/session')
        .set(auth(u.token))
        .send({ legalName: 'Acme', sneaky: 'x' })
        .expect(400); // whitelist
      await http()
        .post('/api/v1/kyb/admin/aml-screen')
        .set(auth(u.token))
        .send({ userId: u.id, fullName: 'Acme Ltd' })
        .expect(403); // non-admin
    });

    it('registers a business, verifies via KYB, and becomes funds-eligible', async () => {
      const u = await newUser('kyb-complete');
      const start = await http()
        .post('/api/v1/kyb/session')
        .set(auth(u.token))
        .send({ legalName: 'Kaduna AgriTech Ltd', registrationNumber: 'RC-12345', country: 'NG' })
        .expect(201);
      expect(start.body.purpose).toBe('BUSINESS_VERIFICATION');
      expect(start.body.businessId).toBeTruthy();

      const pending = await http().get('/api/v1/kyb/status').set(auth(u.token)).expect(200);
      expect(pending.body).toMatchObject({ registered: true, kybStatus: 'PENDING' });

      // Simulate completion — KYB includes AML, so the ref triggers a CLEAR AML result.
      await complete(start.body.providerRef, u.id).expect(200);

      const status = await http().get('/api/v1/kyb/status').set(auth(u.token)).expect(200);
      expect(status.body).toMatchObject({ kybStatus: 'VERIFIED', amlStatus: 'CLEAR' });

      const elig = await http().get('/api/v1/kyb/eligibility').set(auth(u.token)).expect(200);
      // FR-103: KYB alone is not a funds clearance. The person acting for the business
      // must also pass personal identity verification before the account is eligible.
      expect(elig.body).toMatchObject({ registered: true, eligible: false });
      expect(elig.body.reasons).toContain('Authorised representative identity');

      const representative = await http()
        .post('/api/v1/kyc/session')
        .set(auth(u.token))
        .send({ purpose: 'CAMPAIGN_CREATOR' })
        .expect(201);
      await complete(representative.body.providerRef, u.id).expect(200);

      const cleared = await http().get('/api/v1/kyb/eligibility').set(auth(u.token)).expect(200);
      expect(cleared.body).toMatchObject({ registered: true, eligible: true });

      // The AML result was recorded against the business (KYC_SESSION source).
      const screenings = await prisma.amlScreening.findMany({ where: { businessId: start.body.businessId } });
      expect(screenings.length).toBeGreaterThan(0);
      expect(screenings[0].source).toBe('KYC_SESSION');
    });

    it('reports unregistered for a user with no business', async () => {
      const u = await newUser('kyb-none');
      const elig = await http().get('/api/v1/kyb/eligibility').set(auth(u.token)).expect(200);
      expect(elig.body).toMatchObject({ registered: false, eligible: false });
    });

    it('admin can AML-screen the business entity (company) and read history', async () => {
      const u = await newUser('kyb-screened');
      await http()
        .post('/api/v1/kyb/session')
        .set(auth(u.token))
        .send({ legalName: 'OFAC Sanction Holdings' })
        .expect(201);
      await http()
        .post('/api/v1/kyb/admin/aml-screen')
        .set(auth(admin.token))
        .send({ userId: u.id, fullName: 'OFAC Sanction Holdings' })
        .expect(201)
        .then((r) => expect(r.body.status).toBe('FLAGGED'));

      const status = await http().get('/api/v1/kyb/status').set(auth(u.token)).expect(200);
      expect(status.body.amlStatus).toBe('FLAGGED');
      const history = await http().get(`/api/v1/kyb/admin/aml/${u.id}`).set(auth(admin.token)).expect(200);
      expect(history.body[0]).toMatchObject({ source: 'STANDALONE', status: 'FLAGGED' });
    });
  });
});
