import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './create-test-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { AnalyticsAggregationService } from '../src/modules/analytics/analytics-aggregation.service';
import { utcDayKey } from '../src/modules/analytics/analytics-time';

describe('Product analytics (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let aggregation: AnalyticsAggregationService;
  const PREFIX = `e2e-analytics-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  async function signIn(sub: string): Promise<string> {
    const res = await http()
      .post('/api/v1/auth/session')
      .send({ accessToken: `stub:${PREFIX}-${sub}:${PREFIX}-${sub}@e2e.test` })
      .expect(201);
    return res.body.sessionToken as string;
  }
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  const validIdea = {
    title: 'Analytics signal idea',
    problem: 'Smallholder farmers lack credit history so lenders reject them outright.',
    solution: 'Drone yield estimates become an alternative credit score banks trust.',
    targetUser: 'smallholder maize farmers in Kaduna',
    currentAlternative: 'lenders rely on slow manual farm visits that rarely happen.',
    askBreakdown: { drones: 8000, staff: 12000 },
    roadmapSteps: [
      { date: '2026-Q1', description: 'pilot 200 farms' },
      { date: '2026-Q2', description: 'lender API live' },
    ],
    category: 'agritech',
    askAmount: 25000,
    creatorPrePledgeTarget: 800,
  };

  let creator: string;
  let backer: string;
  let ideaId: string | null = null;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    aggregation = app.get(AnalyticsAggregationService);
    [creator, backer] = await Promise.all([signIn('creator'), signIn('backer')]);

    const created = await http()
      .post('/api/v1/ideas')
      .set(bearer(creator))
      .send(validIdea)
      .expect(201);
    ideaId = created.body.id as string;
    await http()
      .post(`/api/v1/ideas/${ideaId}/publish`)
      .set(bearer(creator))
      .expect(201);
  });

  afterAll(async () => {
    if (prisma) {
      if (ideaId) {
        await prisma.ideaSignalDailyMetric.deleteMany({ where: { ideaId } });
        await prisma.productAnalyticsEvent.deleteMany({ where: { ideaId } });
      }
      await prisma.user.deleteMany({
        where: { providerUserId: { startsWith: `did:privy:stub:${PREFIX}` } },
      });
    }
    if (app) await app.close();
  });

  it('has no public product-analytics ingestion route', async () => {
    const res = await http()
      .post('/api/v1/analytics/events')
      .send({ events: [] })
      .expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('records one signal event per first-time action, never a repeated tap', async () => {
    await http()
      .post(`/api/v1/ideas/${ideaId}/support`)
      .set(bearer(backer))
      .expect(201);
    await http()
      .post(`/api/v1/ideas/${ideaId}/support`)
      .set(bearer(backer))
      .expect(201);
    await http()
      .post(`/api/v1/ideas/${ideaId}/pre-pledge`)
      .set(bearer(backer))
      .send({ amount: 100, currency: 'USD' })
      .expect(201);

    const events = await prisma.productAnalyticsEvent.findMany({
      where: { ideaId: ideaId! },
      orderBy: { occurredAt: 'asc' },
    });

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.signalType)).toEqual(['SUPPORT', 'PRE_PLEDGE']);
    expect(events.every((event) => event.name === 'IDEA_SIGNAL')).toBe(true);
    expect(events.every((event) => event.userId !== null)).toBe(true);
  });

  it('stores no network or free-text fields on an event', async () => {
    const [event] = await prisma.productAnalyticsEvent.findMany({
      where: { ideaId: ideaId! },
      take: 1,
    });

    expect(Object.keys(event)).not.toEqual(
      expect.arrayContaining(['ip', 'ipHash', 'userAgent', 'email', 'query']),
    );
  });

  it('rolls the day up idempotently and counts distinct actors', async () => {
    const day = utcDayKey(new Date());

    await aggregation.aggregateIdeaSignals(day);
    await aggregation.aggregateIdeaSignals(day);

    const metric = await prisma.ideaSignalDailyMetric.findUniqueOrThrow({
      where: { ideaId_day: { ideaId: ideaId!, day: new Date(`${day}T00:00:00.000Z`) } },
    });

    expect(metric.supportCount).toBe(1);
    expect(metric.prePledgeCount).toBe(1);
    expect(metric.uniqueActors).toBe(1);
  });
});
