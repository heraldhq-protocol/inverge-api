import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './create-test-app';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(120_000);

/**
 * Discussion routes (FR-273 idea thread, FR-701 campaign discussion).
 *
 * The suite runs against the real database so ownership, campaign visibility and
 * persistence are proven at the HTTP boundary rather than in a mock. Users carry
 * a run-unique prefix and are deleted in afterAll (cascade), which also removes
 * their ideas, campaigns and comments.
 */
describe('Discussion routes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const PREFIX = `e2e-discussion-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  async function session(sub: string): Promise<string> {
    const res = await http()
      .post('/api/v1/auth/session')
      .send({ accessToken: `stub:${PREFIX}-${sub}:${PREFIX}-${sub}@e2e.test` })
      .expect(201);
    return res.body.sessionToken as string;
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const validCreate = {
    askAmount: 25000,
    askBreakdown: { drones: 8000, staff: 12000 },
    category: 'agritech',
    creatorPrePledgeTarget: 800,
    currentAlternative:
      'lenders rely on slow manual farm visits that rarely happen at all.',
    problem:
      'Smallholder farmers lack credit history so lenders reject them outright.',
    roadmapSteps: [
      { date: '2026-Q1', description: 'pilot 200 farms' },
      { date: '2026-Q2', description: 'lender API live' },
    ],
    solution:
      'Drone and satellite yield estimates become an alternative credit score banks trust.',
    targetUser: 'smallholder maize farmers in Kaduna',
    title: 'E2E Discussion Idea',
  };

  let creator: string;
  let backer: string;
  let stranger: string;
  let ideaId: string;
  let draftIdeaId: string;
  let campaignId: string;
  let draftCampaignId: string;
  let creatorUserId: string;
  let backerUserId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);

    creator = await session('creator');
    backer = await session('backer');
    stranger = await session('stranger');

    const me = await http().get('/api/v1/auth/me').set(auth(creator)).expect(200);
    creatorUserId = me.body.id;
    const backerMe = await http()
      .get('/api/v1/auth/me')
      .set(auth(backer))
      .expect(200);
    backerUserId = backerMe.body.id;

    const draft = await http()
      .post('/api/v1/ideas')
      .set(auth(creator))
      .send(validCreate)
      .expect(201);

    const published = await http()
      .post(`/api/v1/ideas/${draft.body.id}/publish`)
      .set(auth(creator))
      .expect(201);
    ideaId = published.body.id;
    expect(published.body.status).toBe('VALIDATING');

    // A second idea stays unpublished, so its thread must never be readable.
    const unpublished = await http()
      .post('/api/v1/ideas')
      .set(auth(creator))
      .send({ ...validCreate, title: 'E2E Unpublished Idea' })
      .expect(201);
    draftIdeaId = unpublished.body.id;
    expect(unpublished.body.status).toBe('DRAFT');

    const shared = {
      creatorId: creatorUserId,
      deadline: new Date('2027-12-31T00:00:00.000Z'),
      summary: 'A public campaign for the discussion suite.',
      targetAmount: 25000,
      title: 'E2E Public Campaign',
      tokenType: 'USDC' as const,
    };
    const campaign = await prisma.campaign.create({
      data: { ...shared, status: 'ACTIVE' },
    });
    campaignId = campaign.id;

    const draftCampaign = await prisma.campaign.create({
      data: {
        ...shared,
        status: 'DRAFT',
        title: 'E2E Draft Campaign',
      },
    });
    draftCampaignId = draftCampaign.id;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({
        where: {
          providerUserId: { startsWith: `did:privy:stub:${PREFIX}` },
        },
      });
    }
    if (app) await app.close();
  });

  describe('idea discussion', () => {
    let commentId: string;

    it('reads an empty public thread', async () => {
      const res = await http()
        .get(`/api/v1/ideas/${ideaId}/comments`)
        .expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.page.hasMore).toBe(false);
    });

    it('does not expose a draft idea thread', async () => {
      await http().get(`/api/v1/ideas/${draftIdeaId}/comments`).expect(404);
    });

    it('rejects an unauthenticated comment', async () => {
      await http()
        .post(`/api/v1/ideas/${ideaId}/comments`)
        .send({ body: 'Anonymous' })
        .expect(401);
    });

    it('rejects an empty body', async () => {
      await http()
        .post(`/api/v1/ideas/${ideaId}/comments`)
        .set(auth(backer))
        .send({ body: '   ' })
        .expect(400);
    });

    it('posts as the session user and survives a re-read', async () => {
      const created = await http()
        .post(`/api/v1/ideas/${ideaId}/comments`)
        .set(auth(backer))
        .send({ body: 'How does verification work for a new farmer?' })
        .expect(201);
      commentId = created.body.id;
      expect(created.body.author.displayName).toBeNull();
      expect(created.body.author.id).toBe(backerUserId);

      const list = await http()
        .get(`/api/v1/ideas/${ideaId}/comments`)
        .expect(200);
      expect(list.body.data.map((row: { id: string }) => row.id)).toContain(
        commentId,
      );
    });

    it('does not let an unrelated account delete the comment', async () => {
      await http()
        .delete(`/api/v1/ideas/${ideaId}/comments/${commentId}`)
        .set(auth(stranger))
        .expect(403);
    });

    it('lets the author delete it', async () => {
      await http()
        .delete(`/api/v1/ideas/${ideaId}/comments/${commentId}`)
        .set(auth(backer))
        .expect(200);
      const list = await http()
        .get(`/api/v1/ideas/${ideaId}/comments`)
        .expect(200);
      expect(list.body.data).toHaveLength(0);
    });
  });

  describe('campaign discussion', () => {
    let campaignCommentId: string;

    it('reads an empty public discussion', async () => {
      const res = await http()
        .get(`/api/v1/campaigns/${campaignId}/comments`)
        .expect(200);
      expect(res.body.data).toEqual([]);
    });

    it('returns 404 for a draft campaign, even by guessed id', async () => {
      await http()
        .get(`/api/v1/campaigns/${draftCampaignId}/comments`)
        .expect(404);
    });

    it('rejects an unauthenticated comment', async () => {
      await http()
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .send({ body: 'Anonymous' })
        .expect(401);
    });

    it('rejects an empty body', async () => {
      await http()
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(auth(backer))
        .send({ body: '  ' })
        .expect(400);
    });

    it('posts, lists, paginates and persists', async () => {
      const created = await http()
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(auth(backer))
        .send({ body: 'When does the first milestone release?' })
        .expect(201);
      campaignCommentId = created.body.id;
      expect(created.body.campaignId).toBe(campaignId);
      expect(created.body.author.isCreator).toBe(false);

      const second = await http()
        .post(`/api/v1/campaigns/${campaignId}/comments`)
        .set(auth(creator))
        .send({ body: 'After the evidence is verified.' })
        .expect(201);
      expect(second.body.author.isCreator).toBe(true);

      const page = await http()
        .get(`/api/v1/campaigns/${campaignId}/comments?limit=1`)
        .expect(200);
      expect(page.body.data).toHaveLength(1);
      expect(page.body.page.hasMore).toBe(true);

      const next = await http()
        .get(
          `/api/v1/campaigns/${campaignId}/comments?limit=1&cursor=${encodeURIComponent(page.body.page.nextCursor)}`,
        )
        .expect(200);
      expect(next.body.data).toHaveLength(1);
      expect(next.body.page.hasMore).toBe(false);
    });

    it('rejects a modification from an unrelated account', async () => {
      await http()
        .delete(`/api/v1/campaigns/${campaignId}/comments/${campaignCommentId}`)
        .set(auth(stranger))
        .expect(403);
    });

    it('lets the author delete, leaving the other comment', async () => {
      await http()
        .delete(`/api/v1/campaigns/${campaignId}/comments/${campaignCommentId}`)
        .set(auth(backer))
        .expect(200);
      const page = await http()
        .get(`/api/v1/campaigns/${campaignId}/comments`)
        .expect(200);
      expect(page.body.data).toHaveLength(1);
      expect(page.body.data[0].author.isCreator).toBe(true);
    });
  });
});
