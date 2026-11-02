import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTestApp } from './create-test-app';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

const OUTBOX = resolve(process.cwd(), '.local', 'email-outbox');

interface OutboxMessage {
  to: string;
  subject: string;
  text: string;
  writtenAt: string;
}

async function messageTo(email: string): Promise<OutboxMessage | null> {
  let names: string[];
  try {
    names = await readdir(OUTBOX);
  } catch {
    return null;
  }
  const messages: OutboxMessage[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(
        await readFile(join(OUTBOX, name), 'utf8'),
      ) as OutboxMessage;
      if (parsed.to === email) messages.push(parsed);
    } catch {
      // A partially written file from a concurrent test is not a match.
    }
  }
  messages.sort((a, b) => b.writtenAt.localeCompare(a.writtenAt));
  return messages[0] ?? null;
}

describe('Email system (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const PREFIX = `e2e-email-${Date.now()}`;
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function signIn(
    sub: string,
    email: string,
    verified = false,
  ): Promise<{ token: string; userId: string; email: string }> {
    const address = `${PREFIX}-${email}`;
    const response = await http()
      .post('/api/v1/auth/session')
      .send({
        accessToken: `stub:${PREFIX}-${sub}:${address}${verified ? '#verified' : ''}`,
      })
      .expect(201);
    const user = await prisma.user.findFirstOrThrow({
      where: { providerUserId: `did:privy:stub:${PREFIX}-${sub}` },
      select: { id: true, email: true },
    });
    return {
      token: response.body.sessionToken as string,
      userId: user.id,
      email: user.email ?? address,
    };
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.emailDelivery.deleteMany({
        where: { idempotencyKey: { startsWith: PREFIX } },
      });
      await prisma.emailSuppression.deleteMany({
        where: { email: { contains: PREFIX } },
      });
      await prisma.user.deleteMany({
        where: { providerUserId: { startsWith: `did:privy:stub:${PREFIX}` } },
      });
    }
    if (app) await app.close();
  });

  describe('registration email and verification', () => {
    it('captures a provider-verified address without an OTP step', async () => {
      const user = await signIn('verified', 'verified@e2e.test', true);

      const response = await http()
        .get('/api/v1/auth/me')
        .set(bearer(user.token))
        .expect(200);

      expect(response.body.emailVerified).toBe(true);
      expect(response.body.requiresEmailVerification).toBe(false);
    });

    it('requires verification when the provider claim is not verified, and accepts a one-time code', async () => {
      const user = await signIn('unverified', 'unverified@e2e.test');

      const me = await http()
        .get('/api/v1/auth/me')
        .set(bearer(user.token))
        .expect(200);
      expect(me.body.requiresEmailVerification).toBe(true);

      await http()
        .post('/api/v1/auth/email/request')
        .set(bearer(user.token))
        .send({ email: user.email })
        .expect(200);

      const message = await messageTo(user.email);
      expect(message?.subject).toBe('Your Inverge verification code');
      const code = /Verification code: (\d{6})/.exec(message?.text ?? '')?.[1];
      expect(code).toMatch(/^\d{6}$/);

      const verified = await http()
        .post('/api/v1/auth/email/verify')
        .set(bearer(user.token))
        .send({ code, email: user.email })
        .expect(200);
      expect(verified.body).toMatchObject({ status: 'verified', email: user.email });

      // The code is single-use: the same value is rejected afterwards.
      const reused = await http()
        .post('/api/v1/auth/email/verify')
        .set(bearer(user.token))
        .send({ code, email: user.email })
        .expect(400);
      expect(reused.body.error.code).toBe('EMAIL_CODE_INVALID');

      const challenge = await prisma.emailVerificationChallenge.findFirstOrThrow({
        where: { userId: user.userId },
        orderBy: { createdAt: 'desc' },
        select: { codeHash: true },
      });
      expect(challenge.codeHash).not.toContain(code as string);
    });

    it('enforces the resend cooldown and rejects an expired code', async () => {
      const user = await signIn('expiry', 'expiry@e2e.test');

      await http()
        .post('/api/v1/auth/email/request')
        .set(bearer(user.token))
        .send({ email: user.email })
        .expect(200);

      const cooldown = await http()
        .post('/api/v1/auth/email/request')
        .set(bearer(user.token))
        .send({ email: user.email })
        .expect(429);
      expect(cooldown.body.error.code).toBe('EMAIL_RESEND_COOLDOWN');
      expect(cooldown.body.error.details.retryAfterSeconds).toBeGreaterThan(0);

      await prisma.emailVerificationChallenge.updateMany({
        where: { userId: user.userId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      const expired = await http()
        .post('/api/v1/auth/email/verify')
        .set(bearer(user.token))
        .send({ code: '123456', email: user.email })
        .expect(400);
      expect(expired.body.error.code).toBe('EMAIL_CODE_EXPIRED');
    });

    it('alerts the previous address after a verified change', async () => {
      const user = await signIn('change', 'old-change@e2e.test', true);
      const newEmail = `${PREFIX}-new-change@e2e.test`;

      await http()
        .post('/api/v1/auth/email/request')
        .set(bearer(user.token))
        .send({ email: newEmail })
        .expect(200);

      const message = await messageTo(newEmail);
      const code = /Verification code: (\d{6})/.exec(message?.text ?? '')?.[1];
      expect(code).toMatch(/^\d{6}$/);

      await http()
        .post('/api/v1/auth/email/verify')
        .set(bearer(user.token))
        .send({ code, email: newEmail })
        .expect(200);

      const alert = await messageTo(user.email);
      expect(alert?.subject).toBe('Your Inverge email address was changed');
      expect(alert?.text).toContain('previous address');
    });

    it('rejects a wrong code without consuming the challenge', async () => {
      const user = await signIn('wrong-code', 'wrong-code@e2e.test');
      await http()
        .post('/api/v1/auth/email/request')
        .set(bearer(user.token))
        .send({ email: user.email })
        .expect(200);

      const message = await messageTo(user.email);
      const code = /Verification code: (\d{6})/.exec(message?.text ?? '')?.[1];
      expect(code).toMatch(/^\d{6}$/);
      const wrong = code === '000000' ? '000001' : '000000';

      const invalid = await http()
        .post('/api/v1/auth/email/verify')
        .set(bearer(user.token))
        .send({ code: wrong, email: user.email })
        .expect(400);
      expect(invalid.body.error.code).toBe('EMAIL_CODE_INVALID');

      const live = await prisma.emailVerificationChallenge.findFirstOrThrow({
        where: { userId: user.userId },
        select: { consumedAt: true, attempts: true },
      });
      expect(live.consumedAt).toBeNull();
      expect(live.attempts).toBe(1);
    });
  });

  describe('editorial consent', () => {
    let token: string;
    let userId: string;
    let unsubscribeUrl: string;

    beforeAll(async () => {
      const user = await signIn('consent', 'consent@e2e.test', true);
      token = user.token;
      userId = user.userId;
    });

    it('is not subscribed after registration', async () => {
      const state = await http()
        .get('/api/v1/me/email/preferences')
        .set(bearer(token))
        .expect(200);

      expect(state.body.editorial.subscribed).toBe(false);
      expect(state.body.unsubscribeUrl).toBeNull();
    });

    it('records explicit consent and issues a working unsubscribe link', async () => {
      const subscribed = await http()
        .put('/api/v1/me/email/editorial')
        .set(bearer(token))
        .send({ subscribed: true })
        .expect(200);
      expect(subscribed.body.subscribed).toBe(true);

      const state = await http()
        .get('/api/v1/me/email/preferences')
        .set(bearer(token))
        .expect(200);
      unsubscribeUrl = state.body.unsubscribeUrl as string;
      expect(unsubscribeUrl).toContain('/api/v1/email/preferences/');

      const path = new URL(unsubscribeUrl).pathname;
      const page = await http().get(path).expect(200);
      expect(page.text).toContain('Editorial email preferences');
      expect(page.text).toContain('Unsubscribe from editorial email');

      // The token action itself is a POST; a mail scanner prefetching the GET
      // cannot unsubscribe the account.
      const stillSubscribed = await prisma.emailSubscription.findUnique({
        where: { userId },
        select: { status: true },
      });
      expect(stillSubscribed?.status).toBe('SUBSCRIBED');
    });

    it('unsubscribes by token and suppresses marketing while keeping transactional mail', async () => {
      const path = `${new URL(unsubscribeUrl).pathname}/unsubscribe`;
      const unsubscribed = await http().post(path).expect(200);
      expect(unsubscribed.body.subscribed).toBe(false);

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true },
      });
      const suppression = await prisma.emailSuppression.findUnique({
        where: { email: user.email! },
        select: { reason: true },
      });
      expect(suppression?.reason).toBe('UNSUBSCRIBED');

      // A forged token is rejected.
      const invalid = await http()
        .get(`/api/v1/email/preferences/${encodeURIComponent('forged.token')}`)
        .expect(400);
      expect(invalid.body.error.code).toBe('EMAIL_PREFERENCE_TOKEN_INVALID');
    });

    it('resubscribing clears only the marketing opt-out', async () => {
      await http()
        .put('/api/v1/me/email/editorial')
        .set(bearer(token))
        .send({ subscribed: false })
        .expect(200);
      await http()
        .put('/api/v1/me/email/editorial')
        .set(bearer(token))
        .send({ subscribed: true })
        .expect(200);

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true },
      });
      expect(
        await prisma.emailSuppression.findUnique({ where: { email: user.email! } }),
      ).toBeNull();
    });

    it('will not subscribe an unverified address', async () => {
      const user = await signIn('consent-unverified', 'consent-unverified@e2e.test');
      const response = await http()
        .put('/api/v1/me/email/editorial')
        .set(bearer(user.token))
        .send({ subscribed: true })
        .expect(409);
      expect(response.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    });
  });

  describe('Resend delivery webhooks', () => {
    const secret = process.env.RESEND_WEBHOOK_SECRET!;
    const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
    let userId: string;
    let recipient: string;
    let deliveryId: string;

    function sign(body: string, eventId: string): Record<string, string> {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac('sha256', key)
        .update(`${eventId}.${timestamp}.${body}`)
        .digest('base64');
      return {
        'svix-id': eventId,
        'svix-signature': `v1,${signature}`,
        'svix-timestamp': String(timestamp),
      };
    }

    function envelope(type: string, emailId: string): string {
      return JSON.stringify({
        type,
        created_at: new Date().toISOString(),
        data: {
          email_id: emailId,
          to: [recipient],
          subject: 'Test',
          ...(type === 'email.bounced' ? { bounce: { type: 'Permanent' } } : {}),
        },
      });
    }

    beforeAll(async () => {
      const user = await signIn('webhook', 'webhook@e2e.test', true);
      userId = user.userId;
      recipient = user.email;
      const delivery = await prisma.emailDelivery.create({
        data: {
          category: 'TRANSACTIONAL',
          idempotencyKey: `${PREFIX}-webhook-delivery`,
          providerMessageId: `${PREFIX}-provider-1`,
          recipient,
          status: 'SENT',
          template: 'IDEA_PUBLISHED',
          userId,
        },
        select: { id: true },
      });
      deliveryId = delivery.id;
    });

    it('rejects an unsigned webhook', async () => {
      const body = envelope('email.delivered', `${PREFIX}-provider-1`);
      const response = await http()
        .post('/api/v1/webhooks/resend')
        .set('content-type', 'application/json')
        .send(body)
        .expect(400);
      expect(response.body.error.code).toBe('EMAIL_WEBHOOK_SIGNATURE_INVALID');
    });

    it('moves a delivery to delivered once and ignores a replay', async () => {
      const body = envelope('email.delivered', `${PREFIX}-provider-1`);
      const eventId = `${PREFIX}-evt-delivered`;
      const headers = sign(body, eventId);

      await http()
        .post('/api/v1/webhooks/resend')
        .set(headers)
        .set('content-type', 'application/json')
        .send(body)
        .expect(200);

      const delivered = await prisma.emailDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
        select: { status: true, deliveredAt: true },
      });
      expect(delivered.status).toBe('DELIVERED');
      expect(delivered.deliveredAt).not.toBeNull();

      const replay = await http()
        .post('/api/v1/webhooks/resend')
        .set(headers)
        .set('content-type', 'application/json')
        .send(body)
        .expect(200);
      expect(replay.body.replayed).toBe(true);
    });

    it('suppresses a hard bounce and keeps the terminal status', async () => {
      const body = envelope('email.bounced', `${PREFIX}-provider-1`);
      await http()
        .post('/api/v1/webhooks/resend')
        .set(sign(body, `${PREFIX}-evt-bounced`))
        .set('content-type', 'application/json')
        .send(body)
        .expect(200);

      const bounced = await prisma.emailDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
        select: { status: true },
      });
      expect(bounced.status).toBe('BOUNCED');
      const suppression = await prisma.emailSuppression.findUnique({
        where: { email: recipient },
        select: { reason: true },
      });
      expect(suppression?.reason).toBe('HARD_BOUNCE');

      // A later delivered event cannot reopen a bounce.
      const late = envelope('email.delivered', `${PREFIX}-provider-1`);
      await http()
        .post('/api/v1/webhooks/resend')
        .set(sign(late, `${PREFIX}-evt-late-delivered`))
        .set('content-type', 'application/json')
        .send(late)
        .expect(200);
      expect(
        (
          await prisma.emailDelivery.findUniqueOrThrow({
            where: { id: deliveryId },
            select: { status: true },
          })
        ).status,
      ).toBe('BOUNCED');
    });

    it('acknowledges an unknown delivery without inventing a record', async () => {
      const body = envelope('email.delivered', `${PREFIX}-unknown-provider`);
      const response = await http()
        .post('/api/v1/webhooks/resend')
        .set(sign(body, `${PREFIX}-evt-unknown`))
        .set('content-type', 'application/json')
        .send(body)
        .expect(200);
      expect(response.body.ignored).toBe(true);
    });
  });
});
