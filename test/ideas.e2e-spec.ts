import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './create-test-app';
import { PrismaService } from '../src/prisma/prisma.service';

// Exhaustive end-to-end coverage of the ideas routes against real Postgres + Redis:
// every use case plus security measures (auth on all mutating routes, malformed tokens,
// mass-assignment/whitelist, ownership, lifecycle-state guards, "no funds move", and the
// FR-206a boost isolation at the HTTP boundary). Users carry a run-unique prefix and are
// deleted in afterAll (cascade), leaving the dev DB clean.
describe('Ideas routes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const PREFIX = `e2e-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  async function session(sub: string): Promise<string> {
    const res = await http()
      .post('/api/v1/auth/session')
      .send({ accessToken: `stub:${PREFIX}-${sub}:${PREFIX}-${sub}@e2e.test` })
      .expect(201);
    return res.body.sessionToken as string;
  }
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  let creator: string;
  let backerA: string;
  let backerB: string;
  let ideaId: string;
  // A fully-structured pitch scores 1.0 → DISCOVERABLE on publish.
  const validCreate = {
    title: 'E2E Idea',
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
    askAmount: 25000, creatorPrePledgeTarget: 800,
  };
  // All fields present (passes the DTO) but too thin to clear the quality floor → LINK_ONLY.
  const lowQualityCreate = {
    title: 'Lo', problem: 'p', solution: 's', targetUser: 'x', currentAlternative: 'y',
    askBreakdown: { a: 1 },
    roadmapSteps: [{ date: '1', description: 'a' }, { date: '2', description: 'b' }],
    category: 'other', askAmount: 1000,
  };
  const convertBody = {
    type: 'ALL_OR_NOTHING', tokenType: 'USDC', targetAmount: 25000,
    deadline: '2026-12-31T00:00:00.000Z',
    milestones: [
      { title: 'm1', deliverable: 'd1', tranchePct: 50, evidenceDefinition: { p: 'x' } },
      { title: 'm2', deliverable: 'd2', tranchePct: 50, evidenceDefinition: { p: 'x' } },
    ],
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    [creator, backerA, backerB] = await Promise.all([session('creator'), session('a'), session('b')]);
  });

  afterAll(async () => {
    if (prisma) await prisma.user.deleteMany({ where: { providerUserId: { startsWith: `did:privy:stub:${PREFIX}` } } });
    if (app) await app.close();
  });

  // ─────────────── Security: auth guard on every mutating route ───────────────
  describe('auth guards', () => {
    const mutating: [string, 'post' | 'put' | 'patch' | 'delete', object][] = [
      ['/api/v1/ideas', 'post', validCreate],
      ['/api/v1/ideas/x/publish', 'post', {}],
      ['/api/v1/ideas/x', 'patch', { title: 't' }],
      ['/api/v1/ideas/x/support', 'post', {}],
      ['/api/v1/ideas/x/support', 'delete', {}],
      ['/api/v1/ideas/x/pre-pledge', 'post', { amount: 1 }],
      ['/api/v1/ideas/x/pre-pledge', 'delete', {}],
      ['/api/v1/ideas/x/survey', 'put', { questions: [] }],
      ['/api/v1/ideas/x/survey/responses', 'post', { answers: [{ questionId: 'q', value: 1 }] }],
      ['/api/v1/ideas/x/survey/responses', 'delete', {}],
      ['/api/v1/ideas/x/comments', 'post', { body: 'hi' }],
      ['/api/v1/ideas/x/convert', 'post', convertBody],
      ['/api/v1/ideas/x/boosts', 'post', { tier: 'BASIC' }],
    ];
    it.each(mutating)('401 without a token: %s %s', async (path, method, body) => {
      await http()[method](path).send(body).expect(401);
    });

    it('401 on a malformed bearer token', async () => {
      await http().post('/api/v1/ideas').set({ Authorization: 'Bearer not-a-jwt' }).send(validCreate).expect(401);
    });
  });

  // ─────────────── Security: input validation + mass-assignment ───────────────
  describe('create validation & whitelist', () => {
    it('400 on a negative ask amount', async () => {
      await http().post('/api/v1/ideas').set(auth(creator)).send({ ...validCreate, askAmount: -5 }).expect(400);
    });
    it('400 on missing required fields', async () => {
      await http().post('/api/v1/ideas').set(auth(creator)).send({ title: 'only' }).expect(400);
    });
    it('400 rejects unknown/server-controlled fields (no mass-assignment)', async () => {
      // A client must not be able to seed metrics or status.
      await http().post('/api/v1/ideas').set(auth(creator))
        .send({ ...validCreate, supporterCount: 999, status: 'CONVERTED' }).expect(400);
    });
  });

  // ─────────────── Lifecycle: create → guards → publish ───────────────
  describe('idea lifecycle', () => {
    it('creates a DRAFT with the creator pre-pledge target', async () => {
      const res = await http().post('/api/v1/ideas').set(auth(creator)).send(validCreate).expect(201);
      expect(res.body.status).toBe('DRAFT');
      expect(Number(res.body.creatorPrePledgeTarget)).toBe(800);
      expect(res.body.supporterCount).toBe(0);
      ideaId = res.body.id;
    });

    it('security: signals + survey responses are rejected on an unpublished DRAFT (400)', async () => {
      await http().post(`/api/v1/ideas/${ideaId}/support`).set(auth(backerA)).expect(400);
      await http().post(`/api/v1/ideas/${ideaId}/pre-pledge`).set(auth(backerA)).send({ amount: 100 }).expect(400);
      await http().post(`/api/v1/ideas/${ideaId}/survey/responses`).set(auth(backerA)).send({ answers: [{ questionId: 'x', value: 1 }] }).expect(400);
    });

    it('owner can edit a DRAFT', async () => {
      const res = await http().patch(`/api/v1/ideas/${ideaId}`).set(auth(creator)).send({ title: 'E2E Idea v2' }).expect(200);
      expect(res.body.title).toBe('E2E Idea v2');
    });
    it('non-owner cannot edit (403)', async () => {
      await http().patch(`/api/v1/ideas/${ideaId}`).set(auth(backerA)).send({ title: 'hijack' }).expect(403);
    });
    it('non-owner cannot publish (403)', async () => {
      await http().post(`/api/v1/ideas/${ideaId}/publish`).set(auth(backerA)).expect(403);
    });
    it('owner publishes DRAFT → VALIDATING, auto-promoted to DISCOVERABLE (FR-272)', async () => {
      const res = await http().post(`/api/v1/ideas/${ideaId}/publish`).set(auth(creator)).expect(201);
      expect(res.body.status).toBe('VALIDATING');
      expect(res.body.validatingSince).toBeTruthy();
      expect(res.body.discoverabilityTier).toBe('DISCOVERABLE'); // full pitch cleared the floor
      expect(Number(res.body.qualityScore)).toBe(1);
    });
    it('cannot edit a published idea (400)', async () => {
      await http().patch(`/api/v1/ideas/${ideaId}`).set(auth(creator)).send({ title: 'late' }).expect(400);
    });
    it('cannot re-publish (400)', async () => {
      await http().post(`/api/v1/ideas/${ideaId}/publish`).set(auth(creator)).expect(400);
    });
  });

  // ─────────────── Browse ───────────────
  describe('public browse', () => {
    it('lists the published idea', async () => {
      const res = await http().get('/api/v1/ideas').expect(200);
      expect(res.body.data.some((i: any) => i.id === ideaId)).toBe(true);
    });
    it('404 for an unknown idea', async () => {
      await http().get('/api/v1/ideas/does-not-exist').expect(404);
    });
  });

  // ─────────────── Support (idempotency + unsupport) ───────────────
  describe('support', () => {
    it('is idempotent per user', async () => {
      await http().post(`/api/v1/ideas/${ideaId}/support`).set(auth(backerA)).expect(201);
      const res = await http().post(`/api/v1/ideas/${ideaId}/support`).set(auth(backerA)).expect(201);
      expect(res.body.supporterCount).toBe(1);
    });
    it('counts distinct supporters and decrements on unsupport', async () => {
      let res = await http().post(`/api/v1/ideas/${ideaId}/support`).set(auth(backerB)).expect(201);
      expect(res.body.supporterCount).toBe(2);
      res = await http().delete(`/api/v1/ideas/${ideaId}/support`).set(auth(backerB)).expect(200);
      expect(res.body.supporterCount).toBe(1);
    });
  });

  // ─────────────── Pre-pledge (weighted, currency, revise, no funds move) ───────────────
  describe('pre-pledge', () => {
    it('400 on unknown currency / missing / non-positive amount / extra fields', async () => {
      await http().post(`/api/v1/ideas/${ideaId}/pre-pledge`).set(auth(backerA)).send({ amount: 10, currency: 'BTC' }).expect(400);
      await http().post(`/api/v1/ideas/${ideaId}/pre-pledge`).set(auth(backerA)).send({ currency: 'USD' }).expect(400);
      await http().post(`/api/v1/ideas/${ideaId}/pre-pledge`).set(auth(backerA)).send({ amount: -1 }).expect(400);
      await http().post(`/api/v1/ideas/${ideaId}/pre-pledge`).set(auth(backerA)).send({ amount: 10, amountUsd: 999 }).expect(400);
    });
    it('weights USD + normalized NGN, email-tier capped, no funds move', async () => {
      // backerA $200 USD -> min(200,100)*0.25 = 25
      await http().post(`/api/v1/ideas/${ideaId}/pre-pledge`).set(auth(backerA)).send({ amount: 200, currency: 'USD' }).expect(201);
      // backerB 160000 NGN -> $100 -> min(100,100)*0.25 = 25 ; total 50
      const res = await http().post(`/api/v1/ideas/${ideaId}/pre-pledge`).set(auth(backerB)).send({ amount: 160000, currency: 'NGN' }).expect(201);
      expect(Number(res.body.weightedPrePledgeTotal)).toBe(50);
      expect(Number(res.body.prePledgeTotal)).toBe(300); // raw USD 200 + 100
      expect(await prisma.contribution.count()).toBe(0);
      expect(await prisma.onChainEvent.count()).toBe(0);
    });
    it('revising a pledge is an upsert, never additive', async () => {
      // backerA 200 -> 50 ; min(50,100)*0.25 = 12.5 ; total 12.5 + 25 = 37.5 (not 62.5)
      const res = await http().post(`/api/v1/ideas/${ideaId}/pre-pledge`).set(auth(backerA)).send({ amount: 50 }).expect(201);
      expect(Number(res.body.weightedPrePledgeTotal)).toBe(37.5);
    });
    it('withdraw drops the pledge live (FR-211)', async () => {
      const res = await http().delete(`/api/v1/ideas/${ideaId}/pre-pledge`).set(auth(backerA)).expect(200);
      expect(Number(res.body.weightedPrePledgeTotal)).toBe(25); // only backerB remains
    });
  });

  // ─────────────── Survey (creator form + backer responses) ───────────────
  describe('survey', () => {
    let ratingQid: string;
    const answer = (v: number) => ({ answers: [{ questionId: ratingQid, value: v }] });

    it('exposes the default survey (RATING + open-text) seeded on create', async () => {
      const res = await http().get(`/api/v1/ideas/${ideaId}/survey`).expect(200);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
      const rating = res.body.find((q: any) => q.type === 'RATING');
      expect(rating).toBeDefined();
      ratingQid = rating.id;
    });

    it('400 on out-of-range / unknown-question answers', async () => {
      await http().post(`/api/v1/ideas/${ideaId}/survey/responses`).set(auth(backerA)).send(answer(6)).expect(400);
      await http().post(`/api/v1/ideas/${ideaId}/survey/responses`).set(auth(backerA)).send(answer(0)).expect(400);
    });

    it('aggregates RATING answers into feedbackScore/count, one response per user', async () => {
      await http().post(`/api/v1/ideas/${ideaId}/survey/responses`).set(auth(backerA)).send(answer(4)).expect(201);
      let res = await http().post(`/api/v1/ideas/${ideaId}/survey/responses`).set(auth(backerB)).send(answer(2)).expect(201);
      expect(res.body.feedbackCount).toBe(2);
      expect(Number(res.body.feedbackScore)).toBe(3); // (4+2)/2
      res = await http().post(`/api/v1/ideas/${ideaId}/survey/responses`).set(auth(backerA)).send(answer(5)).expect(201);
      expect(res.body.feedbackCount).toBe(2); // still one per user (upsert)
      expect(Number(res.body.feedbackScore)).toBe(3.5); // (5+2)/2
    });

    it('rejects editing the survey after publish (draft-only)', async () => {
      await http().put(`/api/v1/ideas/${ideaId}/survey`).set(auth(creator))
        .send({ questions: [{ index: 0, prompt: 'Rate', type: 'RATING' }] }).expect(400);
    });
  });

  // ─────────────── Comments (thread + replies + likes + count metric) ───────────────
  describe('comments', () => {
    let commentId: string;
    let replyId: string;
    const commentCount = async () => Number((await http().get(`/api/v1/ideas/${ideaId}`).expect(200)).body.commentCount);

    it('a backer posts a comment and a reply; both appear in the thread', async () => {
      const c = await http().post(`/api/v1/ideas/${ideaId}/comments`).set(auth(backerA)).send({ body: 'Love this — how do you handle drone regs?' }).expect(201);
      commentId = c.body.id;
      const r = await http().post(`/api/v1/ideas/${ideaId}/comments`).set(auth(backerB)).send({ body: 'Per-state licensing, phased.', parentId: commentId }).expect(201);
      replyId = r.body.id;
      expect(r.body.parentId).toBe(commentId);
      const list = await http().get(`/api/v1/ideas/${ideaId}/comments`).expect(200);
      expect(list.body.map((x: any) => x.id)).toEqual(expect.arrayContaining([commentId, replyId]));
    });

    it('404s a reply to a comment on another idea / missing parent', async () => {
      await http().post(`/api/v1/ideas/${ideaId}/comments`).set(auth(backerA)).send({ body: 'x', parentId: 'nope' }).expect(404);
    });

    it('likes are one-per-user and reflected in likeCount', async () => {
      let res = await http().post(`/api/v1/ideas/${ideaId}/comments/${commentId}/like`).set(auth(backerB)).expect(201);
      expect(res.body.likeCount).toBe(1);
      res = await http().post(`/api/v1/ideas/${ideaId}/comments/${commentId}/like`).set(auth(backerB)).expect(201); // idempotent
      expect(res.body.likeCount).toBe(1);
      res = await http().delete(`/api/v1/ideas/${ideaId}/comments/${commentId}/like`).set(auth(backerB)).expect(200);
      expect(res.body.likeCount).toBe(0);
    });

    it('feeds the idea commentCount metric (comment + reply = 2)', async () => {
      expect(await commentCount()).toBe(2);
    });

    it('only the idea creator can highlight a comment', async () => {
      await http().patch(`/api/v1/ideas/${ideaId}/comments/${commentId}/highlight`).set(auth(backerB)).send({ highlighted: true }).expect(403);
      const res = await http().patch(`/api/v1/ideas/${ideaId}/comments/${commentId}/highlight`).set(auth(creator)).send({ highlighted: true }).expect(200);
      expect(res.body.highlighted).toBe(true);
    });

    it('deleting a comment cascades its replies and updates commentCount', async () => {
      await http().delete(`/api/v1/ideas/${ideaId}/comments/${commentId}`).set(auth(backerB)).expect(403); // not author/creator
      await http().delete(`/api/v1/ideas/${ideaId}/comments/${commentId}`).set(auth(backerA)).expect(200); // author
      expect(await commentCount()).toBe(0); // reply cascaded
    });
  });

  // ─────────────── Convert gate (ownership + threshold security) ───────────────
  describe('convert gate', () => {
    it('non-owner cannot convert (403)', async () => {
      await http().post(`/api/v1/ideas/${ideaId}/convert`).set(auth(backerA)).send(convertBody).expect(403);
    });
    it('owner is blocked below the validation threshold (403)', async () => {
      // weighted 25 is far below any floor and below the creator target (800).
      await http().post(`/api/v1/ideas/${ideaId}/convert`).set(auth(creator)).send(convertBody).expect(403);
    });
  });

  // ─────────────── Quality & discoverability (FR-270/271/272/274) ───────────────
  describe('quality gate', () => {
    it('exposes creator-facing coaching for the idea', async () => {
      const res = await http().get(`/api/v1/ideas/${ideaId}/quality`).expect(200);
      expect(Number(res.body.score)).toBe(1);
      expect(Array.isArray(res.body.checks)).toBe(true);
    });

    it('a thin idea publishes at LINK_ONLY, stays out of browse, and cannot be boosted (FR-271a/272/274)', async () => {
      const created = await http().post('/api/v1/ideas').set(auth(creator)).send(lowQualityCreate).expect(201);
      const lowId = created.body.id;
      expect(created.body.discoverabilityTier).toBe('LINK_ONLY'); // below floor from the start
      expect(Number(created.body.qualityScore)).toBeLessThan(0.7);

      const pub = await http().post(`/api/v1/ideas/${lowId}/publish`).set(auth(creator)).expect(201);
      expect(pub.body.discoverabilityTier).toBe('LINK_ONLY'); // still below floor after publish

      // reachable by direct URL...
      await http().get(`/api/v1/ideas/${lowId}`).expect(200);
      // ...but absent from browse (FR-272)
      const list = await http().get('/api/v1/ideas').expect(200);
      expect(list.body.data.some((i: any) => i.id === lowId)).toBe(false);
      // ...and boost is blocked (FR-274)
      await http().post(`/api/v1/ideas/${lowId}/boosts`).set(auth(creator)).send({ tier: 'BASIC' }).expect(400);
    });
  });

  // ─────────────── Concurrency cap (FR-275) ───────────────
  describe('per-creator concurrency cap', () => {
    it('blocks a creator once they hold the maximum active ideas (default 3)', async () => {
      const token = await session('capper');
      // The capper starts fresh: 3 creations succeed, the 4th is rejected.
      for (let i = 0; i < 3; i++) {
        await http().post('/api/v1/ideas').set(auth(token)).send({ ...validCreate, title: `cap-${i}` }).expect(201);
      }
      await http().post('/api/v1/ideas').set(auth(token)).send({ ...validCreate, title: 'cap-over' }).expect(400);
    });
  });

  // ─────────────── Boosts: FR-206a isolation at the HTTP boundary ───────────────
  describe('boosts never move validation metrics (FR-206a)', () => {
    async function weighted(): Promise<number> {
      const res = await http().get(`/api/v1/ideas/${ideaId}`).expect(200);
      return Number(res.body.weightedPrePledgeTotal);
    }
    // Activation is eventually-consistent (flat-fee webhook emits an event that BoostsService
    // handles asynchronously), so poll — as a real client would.
    async function pollActiveBoost(timeoutMs = 4000): Promise<any> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const r = await http().get(`/api/v1/ideas/${ideaId}/boosts`);
        if (r.body && r.body.tier) return r.body;
        await new Promise((res) => setTimeout(res, 150));
      }
      return null;
    }
    it('purchase → activate leaves the metrics untouched, moves only discovery', async () => {
      const before = await weighted();
      const buy = await http().post(`/api/v1/ideas/${ideaId}/boosts`).set(auth(creator)).send({ tier: 'BASIC' }).expect(201);
      expect(buy.body.processorRef).toBeTruthy();
      expect(await weighted()).toBe(before); // unchanged after purchase

      await http().post('/api/v1/flat-fee/webhook').send({ processorRef: buy.body.processorRef, status: 'SUCCEEDED' }).expect(200);
      expect(await weighted()).toBe(before); // still unchanged after activation

      const active = await pollActiveBoost();
      expect(active?.tier).toBe('BASIC');
      expect(await weighted()).toBe(before); // metrics never moved through the whole boost flow

      const list = await http().get('/api/v1/ideas').expect(200);
      expect(list.body.data.find((i: any) => i.id === ideaId).promoted).toBe(true);
    });
  });
});
