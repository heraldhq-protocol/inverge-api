import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Admin boost-price config + FR-904 audit trail, against real Postgres.
describe('Admin — boost prices + audit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let adminId: string;
  const PREFIX = `e2e-admin-${Date.now()}`;
  const http = () => request(app.getHttpServer());
  const auth = { get Authorization() { return `Bearer ${token}`; } };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    const res = await http().post('/auth/session').send({ accessToken: `stub:${PREFIX}:${PREFIX}@e2e.test` }).expect(201);
    token = res.body.sessionToken;
    adminId = res.body.user.id;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.platformParamAudit.deleteMany({ where: { changedBy: adminId } }); // scrub test audit rows
      await prisma.platformParam.upsert({ where: { key: 'boost.basic.priceUSD' }, update: { value: 5 }, create: { key: 'boost.basic.priceUSD', value: 5 } });
      await prisma.platformParam.upsert({ where: { key: 'boost.featured.priceUSD' }, update: { value: 20 }, create: { key: 'boost.featured.priceUSD', value: 20 } });
      await prisma.user.deleteMany({ where: { privyDid: { startsWith: PREFIX } } });
    }
    if (app) await app.close();
  });

  it('401 without a token', async () => {
    await http().get('/admin/params/audit').expect(401);
    await http().patch('/admin/boost-prices').send({ basicPriceUSD: 5 }).expect(401);
  });

  it('400 on an invalid price', async () => {
    await http().patch('/admin/boost-prices').set(auth).send({ basicPriceUSD: -1 }).expect(400);
    await http().patch('/admin/boost-prices').set(auth).send({ basicDurationDays: 0 }).expect(400);
  });

  it('configures Basic/Featured prices and reflects them', async () => {
    const res = await http().patch('/admin/boost-prices').set(auth).send({ basicPriceUSD: 7, featuredPriceUSD: 22 }).expect(200);
    expect(res.body).toMatchObject({ basic: { priceUSD: 7 }, featured: { priceUSD: 22 } });
    const get = await http().get('/admin/boost-prices').set(auth).expect(200);
    expect(get.body.basic.priceUSD).toBe(7);
    expect(get.body.featured.priceUSD).toBe(22);
  });

  it('a no-op edit (same value) adds no audit row', async () => {
    const before = await prisma.platformParamAudit.count({ where: { key: 'boost.basic.priceUSD', changedBy: adminId } });
    await http().patch('/admin/boost-prices').set(auth).send({ basicPriceUSD: 7 }).expect(200); // unchanged
    const after = await prisma.platformParamAudit.count({ where: { key: 'boost.basic.priceUSD', changedBy: adminId } });
    expect(after).toBe(before);
  });

  it('a real change appends an audit row (old -> new + actor)', async () => {
    await http().patch('/admin/boost-prices').set(auth).send({ basicPriceUSD: 9 }).expect(200);
    const res = await http().get('/admin/params/audit').query({ key: 'boost.basic.priceUSD' }).set(auth).expect(200);
    expect(res.body[0]).toMatchObject({ key: 'boost.basic.priceUSD', oldValue: 7, newValue: 9, changedBy: adminId });
  });

  it('the audit endpoint also serves the generic PATCH /admin/params path', async () => {
    await http().patch('/admin/params').set(auth).send({ params: { 'validation.minSupporters': 42 } }).expect(200);
    const res = await http().get('/admin/params/audit').query({ key: 'validation.minSupporters' }).set(auth).expect(200);
    expect(res.body[0]).toMatchObject({ key: 'validation.minSupporters', newValue: 42, changedBy: adminId });
    await prisma.platformParam.update({ where: { key: 'validation.minSupporters' }, data: { value: 50 } }); // restore
  });
});
