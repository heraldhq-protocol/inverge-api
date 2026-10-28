import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './create-test-app';
import { PrismaService } from '../src/prisma/prisma.service';

// The taxonomy seam: seeded reference data, assignment on an idea, the public
// projection, the browse filter and pair validation. Runs against real Postgres;
// `pnpm db:seed` is part of the CI e2e job, and this suite asserts the seed.
describe('Taxonomy routes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const PREFIX = `taxonomy-e2e-${Date.now()}`;
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
    title: `${PREFIX} Food idea`,
    problem:
      'Smallholder farmers cannot prove harvest quality to buyers, so they sell at the farm gate.',
    solution:
      'A shared cold-chain and grading point gives every harvest a verifiable quality record.',
    targetUser: 'smallholder maize farmers in Kaduna',
    currentAlternative:
      'buyers grade by eye at the farm gate and discount the whole harvest.',
    askBreakdown: { coldRoom: 8000, staff: 12000 },
    roadmapSteps: [
      { date: '2026-Q1', description: 'pilot 200 farms' },
      { date: '2026-Q2', description: 'buyer API live' },
    ],
    category: 'agritech',
    taxonomy: { category: 'food', subcategory: 'farms' },
    askAmount: 25000,
    creatorPrePledgeTarget: 800,
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
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

  it('returns the seeded 15-category, 154-subcategory tree', async () => {
    // #when
    const res = await http().get('/api/v1/taxonomy').expect(200);

    // #then
    expect(res.body.data).toHaveLength(15);
    const subcategories = res.body.data.reduce(
      (total: number, category: { subcategories: unknown[] }) =>
        total + category.subcategories.length,
      0,
    );
    expect(subcategories).toBe(154);
    expect(res.body.data[0]).toMatchObject({
      slug: 'art',
      label: 'Art',
      publicIdeaCount: expect.any(Number),
    });
  });

  it('assigns a taxonomy pair and projects it on list and detail', async () => {
    // #given
    const token = await session('creator');

    // #when
    const created = await http()
      .post('/api/v1/ideas')
      .set(auth(token))
      .send(validCreate)
      .expect(201);

    // #then
    expect(created.body.taxonomy).toEqual({
      category: 'food',
      subcategory: 'farms',
    });

    // The idea is still a DRAFT here; only its owner may read it (FR-272 and the
    // anonymous-draft 404 asserted in ideas.e2e-spec.ts).
    const detail = await http()
      .get(`/api/v1/ideas/${created.body.id}`)
      .set(auth(token))
      .expect(200);
    expect(detail.body.taxonomy).toEqual({
      category: 'food',
      subcategory: 'farms',
    });
    expect(detail.body).not.toHaveProperty('taxonomyCategorySlug');

    // #when the idea is published and discoverable
    await http()
      .post(`/api/v1/ideas/${created.body.id}/publish`)
      .set(auth(token))
      .expect(201);

    // #then the browse filter finds it
    const list = await http()
      .get('/api/v1/ideas')
      .query({ taxonomyCategory: 'food', taxonomySubcategory: 'farms', limit: 50 })
      .expect(200);
    expect(
      list.body.data.some(
        (idea: { id: string }) => idea.id === created.body.id,
      ),
    ).toBe(true);
    expect(
      list.body.data.every(
        (idea: { taxonomy?: { category: string; subcategory: string | null } }) =>
          idea.taxonomy?.category === 'food' &&
          idea.taxonomy?.subcategory === 'farms',
      ),
    ).toBe(true);
  });

  it('rejects a subcategory under the wrong parent', async () => {
    // #given
    const token = await session('creator');

    // #when
    const res = await http()
      .post('/api/v1/ideas')
      .set(auth(token))
      .send({ ...validCreate, taxonomy: { category: 'art', subcategory: 'farms' } })
      .expect(400);

    // #then
    expect(res.body.error).toBeDefined();
    expect(JSON.stringify(res.body.error)).toContain('farms');
  });

  it('rejects a subcategory without a parent', async () => {
    // #given
    const token = await session('creator');

    // #when
    const res = await http()
      .post('/api/v1/ideas')
      .set(auth(token))
      .send({ ...validCreate, taxonomy: { category: '', subcategory: 'farms' } })
      .expect(400);

    // #then
    expect(res.body.error).toBeDefined();
  });

  it('rejects an unknown category before it reaches the database', async () => {
    // #given
    const token = await session('creator');

    // #when
    const res = await http()
      .post('/api/v1/ideas')
      .set(auth(token))
      .send({
        ...validCreate,
        taxonomy: { category: 'not-a-category', subcategory: null },
      })
      .expect(400);

    // #then
    expect(res.body.error).toBeDefined();
  });
});
