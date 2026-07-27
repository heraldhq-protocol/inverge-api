import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// End-to-end coverage of the discovery feed against real Postgres + Redis:
// retrieval filters (only DISCOVERABLE/FEATURED, LINK_ONLY + DRAFT excluded), stateless
// excludeIds, category filter, optional auth (anonymous vs personalised), the onboarding
// interests capture, and the explainability chip. Users carry a run-unique prefix and are
// deleted in afterAll (cascade), leaving the dev DB clean.
describe('Discovery feed (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const PREFIX = `feed-e2e-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  async function session(sub: string): Promise<string> {
    const res = await http()
      .post('/auth/session')
      .send({ accessToken: `stub:${PREFIX}-${sub}:${PREFIX}-${sub}@e2e.test` })
      .expect(201);
    return res.body.sessionToken as string;
  }
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  // A fully-structured pitch scores 1.0 → DISCOVERABLE on publish.
  const richPitch = (over: Record<string, unknown>) => ({
    title: 'Feed Idea',
    problem:
      'Smallholder farmers lack credit history so lenders reject them outright every season.',
    solution:
      'Drone and satellite yield estimates become an alternative credit score banks actually trust.',
    targetUser: 'smallholder maize farmers in Kaduna',
    currentAlternative:
      'lenders rely on slow manual farm visits that rarely happen at all.',
    askBreakdown: { drones: 8000, staff: 12000 },
    roadmapSteps: [
      { date: '2026-Q1', description: 'pilot 200 farms' },
      { date: '2026-Q2', description: 'lender API live' },
    ],
    category: 'agriculture',
    askAmount: 25000,
    creatorPrePledgeTarget: 800,
    ...over,
  });
  // All fields present but too thin to clear the quality floor → LINK_ONLY (feed-excluded).
  const thinPitch = {
    title: 'Lo',
    problem: 'p',
    solution: 's',
    targetUser: 'x',
    currentAlternative: 'y',
    askBreakdown: { a: 1 },
    roadmapSteps: [
      { date: '1', description: 'a' },
      { date: '2', description: 'b' },
    ],
    category: 'other',
    askAmount: 1000,
  };

  let creator: string;
  let creator2: string;
  let backer: string;
  let agriId = '';
  let softwareId = '';
  let linkOnlyId = '';
  let draftId = '';

  async function createPublished(
    token: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const c = await http()
      .post('/ideas')
      .set(auth(token))
      .send(body)
      .expect(201);
    await http()
      .post(`/ideas/${c.body.id}/publish`)
      .set(auth(token))
      .expect(201);
    return c.body.id as string;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    [creator, creator2, backer] = await Promise.all([
      session('creator'),
      session('creator2'),
      session('backer'),
    ]);

    // Two DISCOVERABLE ideas from distinct creators (per-creator cap is 2 active; keep each
    // creator under the maxActivePerCreator concurrency cap of 3).
    agriId = await createPublished(
      creator,
      richPitch({
        title: 'AgriCredit Feed',
        category: 'agriculture',
        region: 'Lagos',
      }),
    );
    softwareId = await createPublished(
      creator2,
      richPitch({
        title: 'DevTool Feed',
        category: 'software',
        region: 'Nairobi',
      }),
    );

    // Low-quality → LINK_ONLY, must never appear in the feed.
    const lo = await http()
      .post('/ideas')
      .set(auth(creator))
      .send(thinPitch)
      .expect(201);
    await http()
      .post(`/ideas/${lo.body.id}/publish`)
      .set(auth(creator))
      .expect(201);
    linkOnlyId = lo.body.id;

    // A DRAFT (never published) — also excluded.
    const draft = await http()
      .post('/ideas')
      .set(auth(creator2))
      .send(richPitch({ title: 'Draft Feed' }))
      .expect(201);
    draftId = draft.body.id;
  });

  afterAll(async () => {
    if (prisma)
      await prisma.user.deleteMany({
        where: { privyDid: { startsWith: PREFIX } },
      });
    if (app) await app.close();
  });

  const ids = (body: { items: { id: string }[] }) =>
    body.items.map((i) => i.id);

  describe('retrieval + anonymous access', () => {
    it('serves the feed to an anonymous caller and flags it anonymous', async () => {
      const res = await http().get('/feed').expect(200);
      expect(res.body.anonymous).toBe(true);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(ids(res.body)).toEqual(
        expect.arrayContaining([agriId, softwareId]),
      );
    });

    it('excludes LINK_ONLY and DRAFT ideas', async () => {
      const res = await http().get('/feed?take=50').expect(200);
      expect(ids(res.body)).not.toContain(linkOnlyId);
      expect(ids(res.body)).not.toContain(draftId);
    });

    it('attaches an explainability chip + objectType to every item, none promoted', async () => {
      const res = await http().get('/feed').expect(200);
      for (const item of res.body.items) {
        expect(item.objectType).toBe('idea');
        expect(item.reason).toMatchObject({
          code: expect.any(String),
          label: expect.any(String),
        });
        expect(item.promoted).toBe(false);
        // Public "Estimated interest" is exposed; the raw internal pre-pledge sum is not.
        expect(item).toHaveProperty('weightedPrePledgeTotal');
        expect(item).not.toHaveProperty('prePledgeTotal');
      }
    });

    it('honours the stateless excludeIds "already seen" filter', async () => {
      const res = await http()
        .get(`/feed?take=50&excludeIds=${agriId}`)
        .expect(200);
      expect(ids(res.body)).not.toContain(agriId);
      expect(ids(res.body)).toContain(softwareId);
    });

    it('applies the category hard filter (Stage 1)', async () => {
      const res = await http()
        .get('/feed?category=software&take=50')
        .expect(200);
      expect(ids(res.body)).toContain(softwareId);
      expect(ids(res.body)).not.toContain(agriId);
    });
  });

  describe('personalization + interests', () => {
    it('rejects an interests update without auth', () =>
      http()
        .put('/me/interests')
        .send({ preferredCategories: ['software'] })
        .expect(401));

    it('saves onboarding interests', async () => {
      const res = await http()
        .put('/me/interests')
        .set(auth(backer))
        .send({
          preferredCategories: ['agriculture'],
          preferredRegions: ['Lagos'],
        })
        .expect(200);
      expect(res.body.preferredCategories).toEqual(['agriculture']);
      expect(res.body.preferredRegions).toEqual(['Lagos']);
    });

    it('rejects an out-of-enum category interest (whitelist)', () =>
      http()
        .put('/me/interests')
        .set(auth(backer))
        .send({ preferredCategories: ['weapons'] })
        .expect(400));

    it('labels a region match with a "From <region>" chip for the signed-in user', async () => {
      // Give agri high exposure so it is NOT chosen for an exploration slot (which favours
      // under-exposed items and whose EXPLORE chip would otherwise take precedence),
      // isolating the region-match chip in this tiny pool.
      await prisma.idea.update({
        where: { id: agriId },
        data: { feedImpressions: 100_000 },
      });
      const res = await http()
        .get('/feed?take=50')
        .set(auth(backer))
        .expect(200);
      expect(res.body.anonymous).toBe(false);
      const agri = res.body.items.find((i: { id: string }) => i.id === agriId);
      expect(agri).toBeDefined();
      // backer's preferredRegions=['Lagos'] and the agri idea is region 'Lagos'.
      expect(agri.reason.code).toBe('REGION');
      expect(agri.reason.label).toBe('From Lagos');
    });
  });
});
