import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Admin RBAC (FR-901) + boost-price config + FR-904 audit trail, against real Postgres.
describe('Admin — RBAC, boost prices + audit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let adminId: string;
  let userToken: string;
  let userId: string;
  // The stub provider derives the DID and email from the token prefix, so the
  // two callers must diverge inside the first few characters to be distinct users.
  const RUN = Date.now().toString(36);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function session(prefix: 'a' | 'u') {
    const res = await http()
      .post('/auth/session')
      .send({ accessToken: `${prefix}${RUN}` })
      .expect(201);
    return { token: res.body.sessionToken as string, id: res.body.user.id as string };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    ({ token: adminToken, id: adminId } = await session('a'));
    await prisma.user.update({ where: { id: adminId }, data: { role: 'ADMIN' } }); // seed the admin
    ({ token: userToken, id: userId } = await session('u')); // stays a plain USER
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.platformParamAudit.deleteMany({ where: { changedBy: adminId } });
      await prisma.platformParam.upsert({ where: { key: 'boost.basic.priceUSD' }, update: { value: 5 }, create: { key: 'boost.basic.priceUSD', value: 5 } });
      await prisma.platformParam.upsert({ where: { key: 'boost.featured.priceUSD' }, update: { value: 20 }, create: { key: 'boost.featured.priceUSD', value: 20 } });
      await prisma.user.deleteMany({ where: { id: { in: [adminId, userId] } } });
    }
    if (app) await app.close();
  });

  // ── access control ──────────────────────────────────────────────
  it('401 without a token', async () => {
    await http().get('/admin/params/audit').expect(401);
    await http().patch('/admin/boost-prices').send({ basicPriceUSD: 5 }).expect(401);
  });

  it('403 for an authenticated non-admin', async () => {
    await http().get('/admin/params/audit').set(bearer(userToken)).expect(403);
    await http().patch('/admin/boost-prices').set(bearer(userToken)).send({ basicPriceUSD: 5 }).expect(403);
    await http().get('/admin/users').set(bearer(userToken)).expect(403);
  });

  it('400 on an invalid price', async () => {
    await http().patch('/admin/boost-prices').set(bearer(adminToken)).send({ basicPriceUSD: -1 }).expect(400);
    await http().patch('/admin/boost-prices').set(bearer(adminToken)).send({ basicDurationDays: 0 }).expect(400);
  });

  // ── boost prices + audit ────────────────────────────────────────
  it('configures Basic/Featured prices and reflects them', async () => {
    const res = await http().patch('/admin/boost-prices').set(bearer(adminToken)).send({ basicPriceUSD: 7, featuredPriceUSD: 22 }).expect(200);
    expect(res.body).toMatchObject({ basic: { priceUSD: 7 }, featured: { priceUSD: 22 } });
    const get = await http().get('/admin/boost-prices').set(bearer(adminToken)).expect(200);
    expect(get.body.basic.priceUSD).toBe(7);
    expect(get.body.featured.priceUSD).toBe(22);
  });

  it('a no-op edit (same value) adds no audit row', async () => {
    const before = await prisma.platformParamAudit.count({ where: { key: 'boost.basic.priceUSD', changedBy: adminId } });
    await http().patch('/admin/boost-prices').set(bearer(adminToken)).send({ basicPriceUSD: 7 }).expect(200);
    const after = await prisma.platformParamAudit.count({ where: { key: 'boost.basic.priceUSD', changedBy: adminId } });
    expect(after).toBe(before);
  });

  it('a real change appends an audit row (old -> new + actor)', async () => {
    await http().patch('/admin/boost-prices').set(bearer(adminToken)).send({ basicPriceUSD: 9 }).expect(200);
    const res = await http().get('/admin/params/audit').query({ key: 'boost.basic.priceUSD' }).set(bearer(adminToken)).expect(200);
    expect(res.body[0]).toMatchObject({ key: 'boost.basic.priceUSD', oldValue: 7, newValue: 9, changedBy: adminId });
  });

  // ── user / role management ──────────────────────────────────────
  it('lists users (searchable), without leaking KYC internals', async () => {
    const res = await http().get('/admin/users').query({ query: RUN.slice(0, 7) }).set(bearer(adminToken)).expect(200);
    const ids = res.body.map((u: any) => u.id);
    expect(ids).toContain(userId);
    expect(res.body[0]).toHaveProperty('role');
    expect(res.body[0]).not.toHaveProperty('kycProviderRef');
  });

  it('grants and revokes admin, gating access accordingly', async () => {
    // plain user is denied before promotion
    await http().get('/admin/boost-prices').set(bearer(userToken)).expect(403);
    // promote
    const up = await http().patch(`/admin/users/${userId}/role`).set(bearer(adminToken)).send({ role: 'ADMIN' }).expect(200);
    expect(up.body).toMatchObject({ id: userId, role: 'ADMIN' });
    await http().get('/admin/boost-prices').set(bearer(userToken)).expect(200); // now allowed
    // revoke
    const down = await http().patch(`/admin/users/${userId}/role`).set(bearer(adminToken)).send({ role: 'USER' }).expect(200);
    expect(down.body).toMatchObject({ id: userId, role: 'USER' });
    await http().get('/admin/boost-prices').set(bearer(userToken)).expect(403); // denied again
  });

  it('blocks self-demotion (anti-lockout)', async () => {
    await http().patch(`/admin/users/${adminId}/role`).set(bearer(adminToken)).send({ role: 'USER' }).expect(400);
  });

  it('404 on an unknown user', async () => {
    await http().patch('/admin/users/nope-does-not-exist/role').set(bearer(adminToken)).send({ role: 'ADMIN' }).expect(404);
  });
});
