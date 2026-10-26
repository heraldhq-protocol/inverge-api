import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './create-test-app';
import { countPrismaQueries, type QueryCounter } from './prisma-query-counter';
import { PrismaService } from '../src/prisma/prisma.service';
import { AnalyticsAggregationService } from '../src/modules/analytics/analytics-aggregation.service';
import { utcDayKey } from '../src/modules/analytics/analytics-time';

const INGEST_SECRET =
  process.env.ANALYTICS_INGEST_SECRET ??
  'e2e-analytics-ingest-secret-0000000000000000';

// Phase 1 analytics: signed service-to-service ingestion, daily roll-ups, the
// request-gated read surface, and the admin approval flow, against real Postgres.
describe('Analytics phase 1 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let aggregation: AnalyticsAggregationService;
  let creatorToken: string;
  let creatorId: string;
  let adminToken: string;
  let adminId: string;
  let otherToken: string;
  let ideaId: string;
  let campaignId: string;
  let day: string;
  let counter: QueryCounter;

  const RUN = Date.now().toString(36);
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function session(prefix: string) {
    const res = await http()
      .post('/api/v1/auth/session')
      .send({ accessToken: `${prefix}${RUN}` })
      .expect(201);
    return {
      token: res.body.sessionToken as string,
      id: res.body.user.id as string,
    };
  }

  function signed(events: unknown[]) {
    const body = JSON.stringify({ events });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', INGEST_SECRET)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    return { body, timestamp, signature };
  }

  function ingest(events: unknown[]) {
    const { body, timestamp, signature } = signed(events);
    return http()
      .post('/api/v1/internal/analytics/events')
      .set('Content-Type', 'application/json')
      .set('x-inverge-timestamp', timestamp)
      .set('x-inverge-signature', signature)
      .send(body);
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    aggregation = app.get(AnalyticsAggregationService);
    counter = countPrismaQueries(prisma);

    const [creator, admin, other] = await Promise.all([
      session('c'),
      session('a'),
      session('o'),
    ]);
    creatorToken = creator.token;
    creatorId = creator.id;
    adminToken = admin.token;
    adminId = admin.id;
    otherToken = other.token;
    await prisma.user.update({
      where: { id: adminId },
      data: { role: 'ADMIN' },
    });

    const created = await http()
      .post('/api/v1/ideas')
      .set(auth(creatorToken))
      .send({
        title: 'Analytics E2E idea',
        problem:
          'Smallholder farmers lack credit history so lenders reject them outright.',
        solution:
          'Drone and satellite yield estimates become an alternative credit score banks trust.',
        targetUser: 'smallholder maize farmers in Kaduna',
        currentAlternative:
          'lenders rely on slow manual farm visits that rarely happen at all.',
        askBreakdown: { drones: 8000, staff: 12000 },
        roadmapSteps: [
          { date: '2026-Q1', description: 'pilot 200 farms' },
          { date: '2026-Q2', description: 'lender API live' },
        ],
        category: 'agritech',
        askAmount: 25000,
        creatorPrePledgeTarget: 800,
      })
      .expect(201);
    ideaId = created.body.id;
    await http()
      .post(`/api/v1/ideas/${ideaId}/publish`)
      .set(auth(creatorToken))
      .expect(201);

    const campaign = await prisma.campaign.create({
      data: {
        creatorId,
        deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        ideaId,
        status: 'ACTIVE',
        targetAmount: 25_000,
        tokenType: 'USDC',
      },
    });
    campaignId = campaign.id;

    day = utcDayKey(new Date());
    await ingest([
      {
        campaignId,
        eventKey: `campaign-${RUN}`,
        name: 'campaign_viewed',
        occurredAt: new Date().toISOString(),
        sessionId: `session-${RUN}`,
        source: 'direct',
        countryCode: 'NG',
      },
    ]).expect(202);
  });

  afterAll(async () => {
    await prisma.productAnalyticsEvent.deleteMany({
      where: {
        OR: [
          { ideaId },
          { campaignId },
          { resourceId: { in: [ideaId, campaignId, 'home'] } },
        ],
      },
    });
    await prisma.resourceReachDailyMetric.deleteMany({
      where: { resourceId: { in: [ideaId, campaignId] } },
    });
    await prisma.resourceAcquisitionDailyMetric.deleteMany({
      where: { resourceId: { in: [ideaId, campaignId] } },
    });
    await prisma.resourceCountryDailyMetric.deleteMany({
      where: { resourceId: { in: [ideaId, campaignId] } },
    });
    await prisma.campaignFunnelDailyMetric.deleteMany({
      where: { campaignId },
    });
    await prisma.campaign.deleteMany({ where: { id: campaignId } });
    await prisma.analyticsAccessGrant.deleteMany({
      where: { userId: { in: [creatorId, adminId] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [creatorId, adminId] } },
    });
    await app.close();
  });

  describe('signed ingestion', () => {
    it('rejects an unsigned request', async () => {
      await http()
        .post('/api/v1/internal/analytics/events')
        .send({ events: [] })
        .expect(401);
    });

    it('rejects a stale timestamp', async () => {
      const body = JSON.stringify({ events: [] });
      const timestamp = Math.floor(Date.now() / 1000 - 3600).toString();
      const signature = createHmac('sha256', INGEST_SECRET)
        .update(`${timestamp}.${body}`)
        .digest('hex');
      await http()
        .post('/api/v1/internal/analytics/events')
        .set('Content-Type', 'application/json')
        .set('x-inverge-timestamp', timestamp)
        .set('x-inverge-signature', signature)
        .send(body)
        .expect(401);
    });

    it('rejects a confirmed outcome name from the client allowlist', async () => {
      const res = await ingest([
        {
          eventKey: `confirmed-${RUN}`,
          name: 'idea_supported',
          occurredAt: new Date().toISOString(),
          userId: creatorId,
          ideaId,
        },
      ]).expect(202);

      expect(res.body.accepted).toBe(0);
      expect(res.body.rejected).toEqual([
        expect.objectContaining({ index: 0, reason: expect.any(String) }),
      ]);
    });

    it('persists an allowed page and idea view', async () => {
      const res = await ingest([
        {
          eventKey: `page-${RUN}`,
          name: 'page_viewed',
          occurredAt: new Date().toISOString(),
          sessionId: `session-${RUN}`,
          resourceType: 'PAGE',
          resourceId: 'home',
          source: 'direct',
          countryCode: 'NG',
        },
        {
          eventKey: `idea-${RUN}`,
          name: 'idea_viewed',
          occurredAt: new Date().toISOString(),
          sessionId: `session-${RUN}`,
          ideaId,
          source: 'feed',
          countryCode: 'NG',
        },
      ]).expect(202);

      expect(res.body).toMatchObject({ accepted: 2, rejected: [], persisted: 2 });
    });

    it('deduplicates a replayed event key', async () => {
      const res = await ingest([
        {
          eventKey: `idea-${RUN}`,
          name: 'idea_viewed',
          occurredAt: new Date().toISOString(),
          sessionId: `session-${RUN}`,
          ideaId,
          source: 'feed',
          countryCode: 'NG',
        },
      ]).expect(202);

      expect(res.body).toMatchObject({
        accepted: 1,
        rejected: [],
        persisted: 0,
        duplicates: 1,
      });
    });

    it('does not expose a public browser ingest route', async () => {
      await http()
        .post('/api/v1/analytics/events')
        .send({ events: [] })
        .expect(404);
    });
  });

  describe('roll-ups', () => {
    it('rebuilds reach, acquisition and country counts idempotently', async () => {
      // #given the raw events written above
      // #when the nightly aggregation runs twice
      await aggregation.aggregateReach(day);
      await aggregation.aggregateAcquisition(day);
      await aggregation.aggregateCountries(day);
      await aggregation.aggregateReach(day);
      await aggregation.aggregateAcquisition(day);
      await aggregation.aggregateCountries(day);

      // #then the rerun replaces, rather than doubles, the day's counts
      const reach = await prisma.resourceReachDailyMetric.findFirst({
        where: { resourceType: 'IDEA', resourceId: ideaId },
      });
      expect(reach).toMatchObject({ views: 1, uniqueSessions: 1 });

      const acquisition = await prisma.resourceAcquisitionDailyMetric.findFirst({
        where: { resourceType: 'IDEA', resourceId: ideaId, source: 'feed' },
      });
      expect(acquisition).toMatchObject({ views: 1, uniqueSessions: 1 });

      const country = await prisma.resourceCountryDailyMetric.findFirst({
        where: { resourceType: 'IDEA', resourceId: ideaId, countryCode: 'NG' },
      });
      expect(country).toMatchObject({ views: 1, uniqueSessions: 1 });
    });
  });

  describe('read access', () => {
    it('requires authentication', async () => {
      await http().get(`/api/v1/ideas/${ideaId}/analytics/summary`).expect(401);
    });

    it('404s a non-owner', async () => {
      await http()
        .get(`/api/v1/ideas/${ideaId}/analytics/summary`)
        .set(auth(otherToken))
        .expect(404);
    });

    it('serves basic reach to the owner', async () => {
      const res = await http()
        .get(`/api/v1/ideas/${ideaId}/analytics/summary`)
        .set(auth(creatorToken))
        .expect(200);

      expect(res.body.totals).toMatchObject({
        views: 1,
        uniqueSessions: 1,
        uniqueSessionsExact: true,
      });
    });

    it('closes premium reports until a grant is approved', async () => {
      const res = await http()
        .get(`/api/v1/ideas/${ideaId}/analytics/acquisition`)
        .set(auth(creatorToken))
        .expect(403);

      expect(res.body.error.code).toBe('ANALYTICS_ENTITLEMENT_REQUIRED');
      expect(res.body.error.details).toMatchObject({
        requestStatus: 'NONE',
        canRequest: true,
      });
    });

    it('lets an admin read premium reports without a grant', async () => {
      const res = await http()
        .get(`/api/v1/ideas/${ideaId}/analytics/acquisition`)
        .set(auth(adminToken))
        .expect(200);

      expect(res.body.sources).toEqual([
        expect.objectContaining({ source: 'feed', views: 1 }),
      ]);
    });
  });

  describe('request-gated access', () => {
    let requestId: string;

    it('reports no request before the first ask', async () => {
      const res = await http()
        .get('/api/v1/analytics/access')
        .set(auth(creatorToken))
        .expect(200);

      expect(res.body).toMatchObject({
        premium: false,
        requestStatus: 'NONE',
        canRequest: true,
      });
    });

    it('creates one pending request', async () => {
      const first = await http()
        .post('/api/v1/analytics/access-requests')
        .set(auth(creatorToken))
        .expect(200);
      expect(first.body).toMatchObject({
        premium: false,
        requestStatus: 'PENDING',
        canRequest: false,
        source: 'REQUEST',
      });

      const second = await http()
        .post('/api/v1/analytics/access-requests')
        .set(auth(creatorToken))
        .expect(200);
      expect(second.body.requestStatus).toBe('PENDING');

      const rows = await prisma.analyticsAccessGrant.findMany({
        where: { userId: creatorId },
      });
      expect(rows).toHaveLength(1);
      requestId = rows[0].id;
    });

    it('still closes premium while the request is pending', async () => {
      await http()
        .get(`/api/v1/ideas/${ideaId}/analytics/acquisition`)
        .set(auth(creatorToken))
        .expect(403);
    });

    it('lists pending requests for an admin only', async () => {
      await http()
        .get('/api/v1/admin/analytics/access-requests?status=PENDING')
        .set(auth(creatorToken))
        .expect(403);

      const res = await http()
        .get('/api/v1/admin/analytics/access-requests?status=PENDING')
        .set(auth(adminToken))
        .expect(200);

      expect(res.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: requestId,
            userId: creatorId,
            status: 'PENDING',
          }),
        ]),
      );
    });

    it('opens premium after an admin approves the request', async () => {
      const decided = await http()
        .patch(`/api/v1/admin/analytics/access-requests/${requestId}`)
        .set(auth(adminToken))
        .send({ status: 'APPROVED' })
        .expect(200);
      expect(decided.body).toMatchObject({
        id: requestId,
        status: 'APPROVED',
        source: 'REQUEST',
      });

      const access = await http()
        .get('/api/v1/analytics/access')
        .set(auth(creatorToken))
        .expect(200);
      expect(access.body).toMatchObject({
        premium: true,
        requestStatus: 'APPROVED',
        canRequest: false,
      });

      const res = await http()
        .get(`/api/v1/ideas/${ideaId}/analytics/acquisition`)
        .set(auth(creatorToken))
        .expect(200);
      expect(res.body.sources).toEqual([
        expect.objectContaining({ source: 'feed', views: 1 }),
      ]);
    });

    it('reports the entitlement in auth capabilities', async () => {
      const res = await http()
        .get('/api/v1/auth/capabilities')
        .set(auth(creatorToken))
        .expect(200);

      expect(res.body.analytics).toMatchObject({
        tier: 'premium',
        premium: true,
        requestStatus: 'APPROVED',
        canRequest: false,
        available: true,
      });
    });
  });

  describe('query budget', () => {
    beforeAll(async () => {
      await prisma.analyticsAccessGrant.upsert({
        where: {
          userId_feature: {
            userId: creatorId,
            feature: 'analytics.premium',
          },
        },
        update: {
          status: 'APPROVED',
          source: 'ADMIN',
          decidedAt: new Date(),
          decidedBy: adminId,
        },
        create: {
          userId: creatorId,
          feature: 'analytics.premium',
          status: 'APPROVED',
          source: 'ADMIN',
          decidedAt: new Date(),
          decidedBy: adminId,
        },
      });
    });

    async function measuredQueries(run: () => Promise<unknown>): Promise<number> {
      counter.reset();
      try {
        await run();
      } catch (error) {
        counter.stop();
        throw error;
      }
      return counter.stop();
    }

    it('keeps the basic idea reports within their operation budgets', async () => {
      const summary = await measuredQueries(async () => {
        await http()
          .get(`/api/v1/ideas/${ideaId}/analytics/summary`)
          .set(auth(creatorToken))
          .expect(200);
      });
      expect(summary).toBe(7);

      const timeseries = await measuredQueries(async () => {
        await http()
          .get(`/api/v1/ideas/${ideaId}/analytics/timeseries`)
          .set(auth(creatorToken))
          .expect(200);
      });
      expect(timeseries).toBe(4);

      const validation = await measuredQueries(async () => {
        await http()
          .get(`/api/v1/ideas/${ideaId}/analytics/validation`)
          .set(auth(creatorToken))
          .expect(200);
      });
      expect(validation).toBe(7);
    });

    it('keeps the premium idea reports within their operation budgets', async () => {
      const acquisition = await measuredQueries(async () => {
        await http()
          .get(`/api/v1/ideas/${ideaId}/analytics/acquisition`)
          .set(auth(creatorToken))
          .expect(200);
      });
      expect(acquisition).toBe(5);

      const geography = await measuredQueries(async () => {
        await http()
          .get(`/api/v1/ideas/${ideaId}/analytics/geography`)
          .set(auth(creatorToken))
          .expect(200);
      });
      expect(geography).toBe(5);
    });

    it('keeps the campaign reports within their operation budgets', async () => {
      const summary = await measuredQueries(async () => {
        await http()
          .get(`/api/v1/campaigns/${campaignId}/analytics/summary`)
          .set(auth(creatorToken))
          .expect(200);
      });
      expect(summary).toBe(7);

      const funnel = await measuredQueries(async () => {
        await http()
          .get(`/api/v1/campaigns/${campaignId}/analytics/funnel`)
          .set(auth(creatorToken))
          .expect(200);
      });
      expect(funnel).toBe(8);
    });

    it('keeps entitlement and admin reads bounded', async () => {
      const access = await measuredQueries(async () => {
        await http()
          .get('/api/v1/analytics/access')
          .set(auth(creatorToken))
          .expect(200);
      });
      expect(access).toBe(3);

      const overview = await measuredQueries(async () => {
        await http()
          .get('/api/v1/admin/analytics/overview')
          .set(auth(adminToken))
          .expect(200);
      });
      expect(overview).toBe(4);

      const requests = await measuredQueries(async () => {
        await http()
          .get('/api/v1/admin/analytics/access-requests?status=APPROVED')
          .set(auth(adminToken))
          .expect(200);
      });
      expect(requests).toBe(2);
    });
  });
});
