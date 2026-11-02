import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp } from './create-test-app';
import { PrismaService } from '../src/prisma/prisma.service';

// AI assistant end-to-end: entitlement request/approval, ownership, the stub
// provider, quota-independent validation, and the guarantee that a proposal is
// never persisted to the idea. Runs against real Postgres.
// The shared 30s hook budget is tight for the first ts-jest bootstrap on Windows.
jest.setTimeout(120_000);

describe('AI assistant routes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const PREFIX = `e2e-ai-${Date.now()}`;
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  let ownerToken: string;
  let otherToken: string;
  let adminToken: string;
  let ownerId: string;
  let otherId: string;
  let adminId: string;
  let ideaId: string;

  async function session(name: string): Promise<{ token: string; id: string }> {
    const res = await http()
      .post('/api/v1/auth/session')
      .send({
        accessToken: `stub:${PREFIX}-${name}:${PREFIX}-${name}@e2e.test#verified`,
      })
      .expect(201);
    return { token: res.body.sessionToken as string, id: res.body.user.id as string };
  }

  const feedbackOnlyIdea = {
    title: `E2E AI idea ${PREFIX}`,
    problem: 'Small shops cannot compare supplier prices without a phone book.',
    solution: 'A shared price board updated by the shops themselves.',
    targetUser: 'market traders in Onitsha',
    currentAlternative: 'They call three suppliers and guess at the rest.',
    category: 'technology',
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);

    ({ token: ownerToken, id: ownerId } = await session('owner'));
    ({ token: otherToken, id: otherId } = await session('other'));
    ({ token: adminToken, id: adminId } = await session('admin'));
    await prisma.user.update({ where: { id: adminId }, data: { role: 'ADMIN' } });

    const created = await http()
      .post('/api/v1/ideas')
      .set(bearer(ownerToken))
      .send(feedbackOnlyIdea)
      .expect(201);
    ideaId = created.body.id as string;
  });

  afterAll(async () => {
    if (prisma) {
      const ids = [ownerId, otherId, adminId].filter(Boolean);
      if (ids.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
    }
    if (app) await app.close();
  });

  it('creates a feedback-only idea without an ask or roadmap', () => {
    // #given the creation above
    // #then the stored draft carries zero funding intent
    return http()
      .get(`/api/v1/ideas/${ideaId}`)
      .set(bearer(ownerToken))
      .expect(200)
      .expect((res) => {
        expect(Number(res.body.askAmount)).toBe(0);
        expect(res.body.roadmapSteps).toEqual([]);
      });
  });

  it('locks the assistant until an admin approves access', async () => {
    // #given no grant
    const locked = await http()
      .post(`/api/v1/ideas/${ideaId}/assistant`)
      .set(bearer(ownerToken))
      .send({
        action: 'improve',
        target: 'problem',
        text: feedbackOnlyIdea.problem,
        baseRevision: 'rev-1',
        clientRequestId: randomUUID(),
      })
      .expect(403);
    expect(locked.body.error.code).toBe('AI_ENTITLEMENT_REQUIRED');

    // #when the creator requests access
    const requested = await http()
      .post('/api/v1/ai/access-requests')
      .set(bearer(ownerToken))
      .expect(201);
    expect(requested.body).toMatchObject({
      configured: true,
      premium: false,
      requestStatus: 'PENDING',
      canRequest: false,
    });

    // #then the admin approves it
    const list = await http()
      .get('/api/v1/admin/ai/access-requests?status=PENDING')
      .set(bearer(adminToken))
      .expect(200);
    const row = (list.body.data as Array<{ id: string; userId: string }>).find(
      (entry) => entry.userId === ownerId,
    );
    expect(row).toBeDefined();

    await http()
      .patch(`/api/v1/admin/ai/access-requests/${row!.id}`)
      .set(bearer(adminToken))
      .send({ status: 'APPROVED' })
      .expect(200);

    const access = await http()
      .get('/api/v1/ai/access')
      .set(bearer(ownerToken))
      .expect(200);
    expect(access.body.premium).toBe(true);
    expect(access.body.requestStatus).toBe('APPROVED');
  });

  it('returns a proposal and never writes it to the idea', async () => {
    // #given an approved owner
    const before = await http()
      .get(`/api/v1/ideas/${ideaId}`)
      .set(bearer(ownerToken))
      .expect(200);

    // #when the assistant is asked for a rewrite
    const result = await http()
      .post(`/api/v1/ideas/${ideaId}/assistant`)
      .set(bearer(ownerToken))
      .send({
        action: 'improve',
        target: 'problem',
        text: feedbackOnlyIdea.problem,
        context: { solution: feedbackOnlyIdea.solution },
        baseRevision: 'rev-1',
        clientRequestId: randomUUID(),
      })
      .expect(201);

    // #then the response is a proposal with usage metadata
    expect(typeof result.body.proposal).toBe('string');
    expect(Array.isArray(result.body.notes)).toBe(true);
    expect(result.body).toMatchObject({
      action: 'improve',
      target: 'problem',
      baseRevision: 'rev-1',
      meta: { model: 'stub', promptVersion: 'idea-assistant.v1' },
    });

    // #and the stored idea is unchanged
    const after = await http()
      .get(`/api/v1/ideas/${ideaId}`)
      .set(bearer(ownerToken))
      .expect(200);
    expect(after.body.problem).toBe(before.body.problem);
  });

  it('refuses a non-owner and an oversized request', async () => {
    // #given another signed-in user
    const forbidden = await http()
      .post(`/api/v1/ideas/${ideaId}/assistant`)
      .set(bearer(otherToken))
      .send({
        action: 'improve',
        target: 'problem',
        text: 'anything',
        baseRevision: 'rev-1',
        clientRequestId: randomUUID(),
      })
      .expect(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');

    // #when the owner sends more text than the DTO permits
    await http()
      .post(`/api/v1/ideas/${ideaId}/assistant`)
      .set(bearer(ownerToken))
      .send({
        action: 'improve',
        target: 'problem',
        text: 'x'.repeat(4_001),
        baseRevision: 'rev-1',
        clientRequestId: randomUUID(),
      })
      .expect(400);
  });

  it('blocks publishing a funding idea without a complete roadmap', async () => {
    // #given a positive ask with no roadmap steps
    await http()
      .patch(`/api/v1/ideas/${ideaId}`)
      .set(bearer(ownerToken))
      .send({ askAmount: 25_000 })
      .expect(200);

    // #then publish is refused with a stable code
    const refused = await http()
      .post(`/api/v1/ideas/${ideaId}/publish`)
      .set(bearer(ownerToken))
      .expect(400);
    expect(refused.body.error.code).toBe('FUNDING_REQUIRES_ROADMAP');

    // #when the ask is removed again, the feedback-only idea publishes
    await http()
      .patch(`/api/v1/ideas/${ideaId}`)
      .set(bearer(ownerToken))
      .send({ askAmount: 0 })
      .expect(200);
    const published = await http()
      .post(`/api/v1/ideas/${ideaId}/publish`)
      .set(bearer(ownerToken))
      .expect(201);
    expect(published.body.status).toBe('VALIDATING');
  });
});
