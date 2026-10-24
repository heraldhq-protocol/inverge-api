import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './create-test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Notifications read model (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const PREFIX = `e2e-notifications-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  async function signIn(sub: string): Promise<string> {
    const res = await http()
      .post('/api/v1/auth/session')
      .send({ accessToken: `stub:${PREFIX}-${sub}:${PREFIX}-${sub}@e2e.test` })
      .expect(201);
    return res.body.sessionToken as string;
  }

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  let alice: string;
  let bob: string;
  let aliceId: string;
  let unreadIds: string[];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);

    alice = await signIn('alice');
    bob = await signIn('bob');
    const aliceUser = await prisma.user.findFirstOrThrow({
      where: { providerUserId: { startsWith: `did:privy:stub:${PREFIX}-alice` } },
      select: { id: true },
    });
    aliceId = aliceUser.id;
    const bobUser = await prisma.user.findFirstOrThrow({
      where: { providerUserId: { startsWith: `did:privy:stub:${PREFIX}-bob` } },
      select: { id: true },
    });

    const rows = await Promise.all(
      [0, 1, 2].map((index) =>
        prisma.notification.create({
          data: {
            userId: aliceId,
            template: `E2E_${index}`,
            data: { index },
            createdAt: new Date(Date.now() - index * 1_000),
          },
          select: { id: true },
        }),
      ),
    );
    unreadIds = rows.map((row) => row.id);

    await prisma.notification.create({
      data: {
        userId: bobUser.id,
        template: 'E2E_BOB',
        data: { index: 99 },
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({
        where: { providerUserId: { startsWith: `did:privy:stub:${PREFIX}` } },
      });
    }
    if (app) await app.close();
  });

  it('requires a session', async () => {
    const response = await http().get('/api/v1/me/notifications').expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns only the caller’s notifications, newest first', async () => {
    const response = await http()
      .get('/api/v1/me/notifications')
      .set(bearer(alice))
      .expect(200);

    expect(response.body.data.map((row: { id: string }) => row.id)).toEqual(
      unreadIds,
    );
    expect(response.body.data[0].data).toEqual({ index: 0 });
    expect(response.body.page).toMatchObject({
      limit: 24,
      hasMore: false,
      total: null,
      totalKind: 'omitted',
    });
  });

  it('filters unread and counts them for the badge', async () => {
    const unread = await http()
      .get('/api/v1/me/notifications?unreadOnly=true')
      .set(bearer(alice))
      .expect(200);
    expect(unread.body.data).toHaveLength(3);

    const count = await http()
      .get('/api/v1/me/notifications/unread-count')
      .set(bearer(alice))
      .expect(200);
    expect(count.body).toEqual({ count: 3 });

    await http()
      .get('/api/v1/me/notifications?unreadOnly=maybe')
      .set(bearer(alice))
      .expect(400);
  });

  it('walks pages with the cursor without repeating a row', async () => {
    const first = await http()
      .get('/api/v1/me/notifications?limit=2')
      .set(bearer(alice))
      .expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.page.hasMore).toBe(true);

    const second = await http()
      .get(
        `/api/v1/me/notifications?limit=2&cursor=${encodeURIComponent(first.body.page.nextCursor)}`,
      )
      .set(bearer(alice))
      .expect(200);

    const ids = [...first.body.data, ...second.body.data].map(
      (row: { id: string }) => row.id,
    );
    expect(ids).toEqual(unreadIds);
  });

  it('marks one row read idempotently and rejects another user’s row', async () => {
    const first = await http()
      .patch(`/api/v1/me/notifications/${unreadIds[0]}/read`)
      .set(bearer(alice))
      .expect(200);
    expect(first.body.id).toBe(unreadIds[0]);
    expect(first.body.readAt).toEqual(expect.any(String));

    const second = await http()
      .patch(`/api/v1/me/notifications/${unreadIds[0]}/read`)
      .set(bearer(alice))
      .expect(200);
    expect(second.body.readAt).toBe(first.body.readAt);

    await http()
      .patch(`/api/v1/me/notifications/${unreadIds[0]}/read`)
      .set(bearer(bob))
      .expect(404);

    const count = await http()
      .get('/api/v1/me/notifications/unread-count')
      .set(bearer(alice))
      .expect(200);
    expect(count.body).toEqual({ count: 2 });
  });

  it('marks every remaining row read in one call', async () => {
    const response = await http()
      .post('/api/v1/me/notifications/read-all')
      .set(bearer(alice))
      .expect(201);
    expect(response.body).toEqual({ updated: 2 });

    const count = await http()
      .get('/api/v1/me/notifications/unread-count')
      .set(bearer(alice))
      .expect(200);
    expect(count.body).toEqual({ count: 0 });
  });
});
