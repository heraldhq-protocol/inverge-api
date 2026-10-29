import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './create-test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Auth capabilities (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const PREFIX = `e2e-capabilities-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  async function signIn(sub: string): Promise<string> {
    const res = await http()
      .post('/api/v1/auth/session')
      .send({ accessToken: `stub:${PREFIX}-${sub}:${PREFIX}-${sub}@e2e.test#verified` })
      .expect(201);
    return res.body.sessionToken as string;
  }

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
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
    const res = await http().get('/api/v1/auth/capabilities').expect(401);

    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('reports the blockers that keep an unverified account from submitting campaigns', async () => {
    const token = await signIn('unverified');

    const res = await http()
      .get('/api/v1/auth/capabilities')
      .set(bearer(token))
      .expect(200);

    expect(res.body.verification).toMatchObject({
      identityVerified: false,
      fundsEligible: false,
    });
    expect(res.body.verification.blockers).toEqual(
      expect.arrayContaining(['Identity verification (KYC) is required']),
    );
    expect(res.body.capabilities.submitCampaigns).toBe(false);
  });

  it('reflects verification and admin role changes without caching', async () => {
    const token = await signIn('promoted');
    const user = await prisma.user.findUniqueOrThrow({
      where: { providerUserId: `did:privy:stub:${PREFIX}-promoted` },
      select: { id: true },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { kycStatus: 'VERIFIED', amlStatus: 'CLEAR', role: 'ADMIN' },
    });

    const res = await http()
      .get('/api/v1/auth/capabilities')
      .set(bearer(token))
      .expect(200);

    expect(res.body.verification).toEqual({
      emailVerified: true,
      identityVerified: true,
      fundsEligible: true,
      blockers: [],
    });
    expect(res.body.capabilities).toMatchObject({
      submitCampaigns: true,
      reviewCampaigns: true,
      managePlatform: true,
    });
  });

  it('never exposes KYC provider references or the provider subject', async () => {
    const token = await signIn('projection');

    const res = await http()
      .get('/api/v1/auth/capabilities')
      .set(bearer(token))
      .expect(200);

    expect(res.body).not.toHaveProperty('kycProviderRef');
    expect(res.body).not.toHaveProperty('providerUserId');
    expect(JSON.stringify(res.body)).not.toContain(PREFIX);
  });

  // F-11 / FR-216: a ban must stop both a new exchange and an already-issued session.
  it('refuses a new session for a banned account', async () => {
    const token = await signIn('banned-exchange');
    const user = await prisma.user.findUniqueOrThrow({
      where: {
        providerUserId: `did:privy:stub:${PREFIX}-banned-exchange`,
      },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { bannedAt: new Date() },
    });

    const res = await http()
      .post('/api/v1/auth/session')
      .send({
        accessToken: `stub:${PREFIX}-banned-exchange:${PREFIX}-banned-exchange@e2e.test#verified`,
      })
      .expect(403);

    expect(res.body.sessionToken).toBeUndefined();
    expect(res.body.user).toBeUndefined();

    // The token minted before the ban is no longer usable either.
    await http()
      .get('/api/v1/auth/me')
      .set(bearer(token))
      .expect(403);
  });
});
