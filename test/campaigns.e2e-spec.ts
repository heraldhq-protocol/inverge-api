import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './create-test-app';
import { PrismaService } from '../src/prisma/prisma.service';

// Nest boots the full module graph; on a cold Windows checkout that can take
// minutes. Give this suite the same headroom as a CI runner instead of failing
// in `beforeAll` before a single request is made.
jest.setTimeout(300_000);

/**
 * Public campaign detail against real Postgres.
 *
 * The marketing campaign page is addressed by the source idea's slug. These
 * tests pin the two properties the page depends on: the slug resolves to the
 * same campaign as its id, and a non-public campaign is indistinguishable from
 * an unknown one unless the caller owns it.
 */
describe('Campaign detail (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let creatorToken: string;
  let creatorId: string;
  let otherToken: string;
  let otherId: string;

  const RUN = Date.now().toString(36);
  const campaignIds: string[] = [];
  let activeCampaignId = '';
  let activeIdeaSlug = '';
  let draftCampaignId = '';
  let draftIdeaSlug = '';

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function session(sub: string) {
    const res = await http()
      .post('/api/v1/auth/session')
      .send({
        accessToken: `stub:${RUN}-${sub}:${RUN}-${sub}@e2e.test`,
      })
      .expect(201);
    return {
      id: res.body.user.id as string,
      token: res.body.sessionToken as string,
    };
  }

  async function createIdea(creator: string, slug: string, title: string) {
    return prisma.idea.create({
      data: {
        askAmount: 10_000,
        creatorId: creator,
        discoverabilityTier: 'DISCOVERABLE',
        problem: `${title} problem statement for the public detail read.`,
        roadmap: 'Ship it.',
        slug,
        solution: `${title} solution statement for the public detail read.`,
        status: 'VALIDATING',
        title,
      },
    });
  }

  async function createCampaign(
    creator: string,
    ideaId: string,
    status: 'ACTIVE' | 'DRAFT',
  ) {
    const campaign = await prisma.campaign.create({
      data: {
        creatorId: creator,
        deadline: new Date(Date.now() + 86_400_000),
        ideaId,
        status,
        targetAmount: 10_000,
        tokenType: 'USDC',
        totalRaised: status === 'ACTIVE' ? 2_500 : 0,
      },
    });
    campaignIds.push(campaign.id);
    return campaign.id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);

    ({ id: creatorId, token: creatorToken } = await session('creator'));
    ({ id: otherId, token: otherToken } = await session('other'));

    const activeIdea = await createIdea(
      creatorId,
      `campaign-detail-active-${RUN}`,
      'Active campaign',
    );
    activeIdeaSlug = activeIdea.slug;
    activeCampaignId = await createCampaign(creatorId, activeIdea.id, 'ACTIVE');

    const draftIdea = await createIdea(
      creatorId,
      `campaign-detail-draft-${RUN}`,
      'Draft campaign',
    );
    draftIdeaSlug = draftIdea.slug;
    draftCampaignId = await createCampaign(creatorId, draftIdea.id, 'DRAFT');
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
      const userIds = [creatorId, otherId].filter(
        (id): id is string => typeof id === 'string',
      );
      if (userIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
    }
    if (app) await app.close();
  });

  it('reads a public campaign by id', async () => {
    const res = await http()
      .get(`/api/v1/campaigns/${activeCampaignId}`)
      .expect(200);

    expect(res.body).toMatchObject({
      id: activeCampaignId,
      status: 'ACTIVE',
    });
    expect(Number(res.body.totalRaised)).toBe(2500);
    expect(res.body.idea.slug).toBe(activeIdeaSlug);
    expect(res.body.creator.id).toBe(creatorId);
  });

  it('resolves the same campaign by its source idea slug', async () => {
    const bySlug = await http()
      .get(`/api/v1/campaigns/${activeIdeaSlug}`)
      .expect(200);

    expect(bySlug.body.id).toBe(activeCampaignId);
  });

  it('hides a draft from anonymous callers and from another user', async () => {
    await http().get(`/api/v1/campaigns/${draftCampaignId}`).expect(404);
    await http()
      .get(`/api/v1/campaigns/${draftIdeaSlug}`)
      .expect(404);
    await http()
      .get(`/api/v1/campaigns/${draftCampaignId}`)
      .set(bearer(otherToken))
      .expect(404);
  });

  it('lets the creator read their own draft by id and by slug', async () => {
    const byId = await http()
      .get(`/api/v1/campaigns/${draftCampaignId}`)
      .set(bearer(creatorToken))
      .expect(200);
    expect(byId.body.status).toBe('DRAFT');

    const bySlug = await http()
      .get(`/api/v1/campaigns/${draftIdeaSlug}`)
      .set(bearer(creatorToken))
      .expect(200);
    expect(bySlug.body.id).toBe(draftCampaignId);
  });

  it('returns 404 for an unknown campaign', async () => {
    await http().get('/api/v1/campaigns/does-not-exist').expect(404);
  });
});
