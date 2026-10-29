import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { Env } from '../../../config/env.validation';
import { EmailPort } from '../../../ports/email/email.port';
import { EmailVerificationService } from './email-verification.service';
import { hashVerificationCode } from './email-code';

const USER_ID = 'user-1';
const SECRET = 'test-email-code-secret-at-least-32-characters';

function config(): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    EMAIL_VERIFICATION_CODE_TTL_SECONDS: 600,
    EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: 60,
    EMAIL_VERIFICATION_MAX_ATTEMPTS: 5,
    EMAIL_VERIFICATION_MAX_PER_HOUR: 5,
    EMAIL_CODE_SECRET: SECRET,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<
    Env,
    true
  >;
}

function makeTx() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    emailVerificationChallenge: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn(
        async ({ data }: { data: Record<string, unknown> }) => data,
      ),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

function makeService(tx: ReturnType<typeof makeTx>) {
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
    emailVerificationChallenge: {
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const email: jest.Mocked<EmailPort> = {
    send: jest.fn().mockResolvedValue(undefined),
  };
  const service = new EmailVerificationService(
    prisma as unknown as PrismaService,
    config(),
    email,
  );
  return { service, prisma, email };
}

describe('EmailVerificationService', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('request', () => {
    it('normalises, hashes and sends a six-digit code without storing it', async () => {
      // #given an account with no verified address
      const tx = makeTx();
      tx.user.update.mockResolvedValue({});
      const { service, prisma, email } = makeService(tx);
      prisma.user.findUnique.mockResolvedValue({
        email: null,
        emailVerifiedAt: null,
      });

      // #when a code is requested for a mixed-case address
      const result = await service.request(USER_ID, '  Ada@Example.COM ');

      // #then the address is canonical, the provider sees it, and the database
      // receives only a keyed digest bound to the challenge id
      expect(result).toMatchObject({
        status: 'code_sent',
        email: 'ada@example.com',
      });
      expect(email.send).toHaveBeenCalledTimes(1);
      const message = email.send.mock.calls[0][0];
      expect(message.to).toBe('ada@example.com');
      const code = /Verification code: (\d{6})/.exec(message.text)?.[1];
      expect(code).toBeTruthy();

      const created =
        tx.emailVerificationChallenge.create.mock.calls[0][0].data;
      expect(created.email).toBe('ada@example.com');
      expect(created.purpose).toBe('SIGNUP');
      expect(created.codeHash).toBe(
        hashVerificationCode(SECRET, created.id as string, code!),
      );
      expect(JSON.stringify(created)).not.toContain(code!);
      expect(created.maxAttempts).toBe(5);
      expect(created.expiresAt).toBeInstanceOf(Date);
    });

    it('does not issue a second code while a verified address is unchanged', async () => {
      // #given an account whose address is already confirmed
      const tx = makeTx();
      const { service, prisma, email } = makeService(tx);
      prisma.user.findUnique.mockResolvedValue({
        email: 'ada@example.com',
        emailVerifiedAt: new Date(),
      });

      // #when the same address is requested
      const result = await service.request(USER_ID, 'ADA@example.com');

      // #then nothing is sent and the state is reported plainly
      expect(result).toEqual({
        status: 'already_verified',
        email: 'ada@example.com',
      });
      expect(email.send).not.toHaveBeenCalled();
      expect(tx.emailVerificationChallenge.create).not.toHaveBeenCalled();
    });

    it('enforces the resend cooldown before sending another message', async () => {
      // #given an active challenge sent moments ago
      const tx = makeTx();
      tx.emailVerificationChallenge.findFirst.mockResolvedValue({
        lastSentAt: new Date(),
      });
      const { service, prisma, email } = makeService(tx);
      prisma.user.findUnique.mockResolvedValue({
        email: 'old@example.com',
        emailVerifiedAt: new Date(),
      });

      // #when a different address is requested
      const result = await service.request(USER_ID, 'new@example.com');

      // #then the caller is told to wait; no mail or challenge is produced
      expect(result.status).toBe('cooldown');
      if (result.status === 'cooldown') {
        expect(result.retryAfterSeconds).toBeGreaterThan(0);
      }
      expect(email.send).not.toHaveBeenCalled();
      expect(tx.emailVerificationChallenge.create).not.toHaveBeenCalled();
    });

    it('rejects an invalid address before touching the database', async () => {
      // #given a malformed address
      const tx = makeTx();
      const { service, prisma, email } = makeService(tx);

      // #then the request fails as a validation error
      await expect(
        service.request(USER_ID, 'not-an-email'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(email.send).not.toHaveBeenCalled();
    });

    it('clears a pending change when delivery fails', async () => {
      // #given a verified account changing address and a provider outage
      const tx = makeTx();
      const { service, prisma, email } = makeService(tx);
      prisma.user.findUnique.mockResolvedValue({
        email: 'old@example.com',
        emailVerifiedAt: new Date(),
      });
      email.send.mockRejectedValue(new Error('provider down'));

      // #when the code cannot be delivered
      const result = await service.request(USER_ID, 'new@example.com');

      // #then the pending address is removed so it cannot look half-confirmed
      expect(result).toEqual({ status: 'delivery_failed' });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { pendingEmail: null, pendingEmailRequestedAt: null },
      });
      expect(prisma.emailVerificationChallenge.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deliveryFailedAt: expect.any(Date) }),
        }),
      );
    });
  });

  describe('verify', () => {
    const challenge = (code: string) => ({
      id: 'challenge-1',
      email: 'ada@example.com',
      purpose: 'SIGNUP',
      codeHash: hashVerificationCode(SECRET, 'challenge-1', code),
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
      maxAttempts: 5,
      consumedAt: null,
    });

    it('consumes a valid code once and stamps the verified address', async () => {
      // #given a live challenge and an empty email slot
      const tx = makeTx();
      tx.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([challenge('123456')]);
      tx.user.findUnique
        .mockResolvedValueOnce({ email: null, emailVerifiedAt: null })
        .mockResolvedValueOnce(null);
      const { service } = makeService(tx);

      // #when the code is entered
      const result = await service.verify(USER_ID, 'ada@example.com', '123456');

      // #then the code is consumed, the row is stamped and the address is stored
      expect(result).toEqual({
        status: 'verified',
        email: 'ada@example.com',
        verifiedAt: expect.any(String),
      });
      expect(tx.emailVerificationChallenge.updateMany).toHaveBeenNthCalledWith(
        1,
        {
          where: { id: 'challenge-1', consumedAt: null },
          data: { consumedAt: expect.any(Date) },
        },
      );
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: {
          email: 'ada@example.com',
          emailVerified: true,
          emailVerifiedAt: expect.any(Date),
          pendingEmail: null,
          pendingEmailRequestedAt: null,
        },
      });
    });

    it('counts a wrong code against the attempt budget without verifying', async () => {
      // #given a live challenge
      const tx = makeTx();
      tx.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([challenge('123456')]);
      const { service } = makeService(tx);

      // #when a different code is submitted
      const result = await service.verify(USER_ID, 'ada@example.com', '000000');

      // #then the attempt is recorded and no ownership change happens
      expect(result).toEqual({ status: 'invalid' });
      expect(tx.emailVerificationChallenge.update).toHaveBeenCalledWith({
        where: { id: 'challenge-1' },
        data: { attempts: { increment: 1 } },
      });
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('rejects an expired challenge and supersedes it', async () => {
      // #given a challenge whose expiry has passed
      const tx = makeTx();
      tx.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { ...challenge('123456'), expiresAt: new Date(Date.now() - 1_000) },
        ]);
      const { service } = makeService(tx);

      // #when the code is entered
      const result = await service.verify(USER_ID, 'ada@example.com', '123456');

      // #then it cannot be used and is taken out of the live set
      expect(result).toEqual({ status: 'expired' });
      expect(tx.emailVerificationChallenge.update).toHaveBeenCalledWith({
        where: { id: 'challenge-1' },
        data: { supersededAt: expect.any(Date) },
      });
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('refuses to merge an address owned by another account', async () => {
      // #given a valid code for an address already verified elsewhere
      const tx = makeTx();
      tx.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([challenge('123456')]);
      tx.user.findUnique
        .mockResolvedValueOnce({ email: null, emailVerifiedAt: null })
        .mockResolvedValueOnce({ id: 'other-user' });
      const { service } = makeService(tx);

      // #when the code is entered
      const result = await service.verify(USER_ID, 'ada@example.com', '123456');

      // #then the code is burned but no account is linked or rewritten
      expect(result).toEqual({ status: 'unavailable' });
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.emailVerificationChallenge.update).toHaveBeenCalledWith({
        where: { id: 'challenge-1' },
        data: { consumedAt: expect.any(Date) },
      });
    });

    it('stops accepting guesses after the challenge attempt cap', async () => {
      // #given a challenge at its limit
      const tx = makeTx();
      tx.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { ...challenge('123456'), attempts: 5, maxAttempts: 5 },
        ]);
      const { service } = makeService(tx);

      // #when another guess arrives
      const result = await service.verify(USER_ID, 'ada@example.com', '123456');

      // #then the code is no longer checked
      expect(result).toEqual({ status: 'too_many_attempts' });
      expect(tx.emailVerificationChallenge.update).not.toHaveBeenCalled();
    });
  });

  describe('cancelPending', () => {
    it('retires every live challenge and clears the proposed address', async () => {
      // #given an account with a pending change
      const tx = makeTx();
      const { service } = makeService(tx);

      // #when the caller abandons the screen
      const result = await service.cancelPending(USER_ID);

      // #then the pending address and both SIGNUP/CHANGE codes are retired
      expect(result).toEqual({ pendingEmail: null });
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { pendingEmail: null, pendingEmailRequestedAt: null },
      });
      expect(tx.emailVerificationChallenge.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, consumedAt: null, supersededAt: null },
        data: { supersededAt: expect.any(Date) },
      });
    });
  });

  describe('resend', () => {
    it('requires an active challenge rather than starting a new flow', async () => {
      // #given no live challenge
      const tx = makeTx();
      const { service, prisma } = makeService(tx);
      prisma.user.findUnique.mockResolvedValue({
        email: 'ada@example.com',
        pendingEmail: null,
      });

      // #then resend fails with a stable code instead of guessing an address
      await expect(service.resend(USER_ID)).rejects.toMatchObject({
        response: { code: 'EMAIL_NO_ACTIVE_CODE' },
      });
    });
  });
});
