import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import type { AdminUserModel } from '../../generated/prisma/models';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuthService, normalizeAdminEmail } from './admin-auth.service';
import { hashAdminPassword } from './password';
import {
  decryptAdminSecret,
  encryptAdminSecret,
  parseAdminEncryptionKey,
} from './secret-box';
import { hashAdminIdentifier, hashAdminToken } from './tokens';
import { totpCode, totpStep } from './totp';

const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery staple';
const KEY = Buffer.alloc(32, 7);
const ENCODED_KEY = KEY.toString('base64');
const PEPPER = 'p'.repeat(40);

interface Harness {
  service: AdminAuthService;
  prisma: MockPrisma;
  admin: AdminUserModel;
  setAdmin(patch: Partial<AdminUserModel>): void;
  setChallenge(patch: Partial<ChallengeFixture> | null): void;
  events: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  challenges: Array<Record<string, unknown>>;
}

interface ChallengeFixture {
  id: string;
  adminUserId: string;
  tokenHash: string;
  ipHash: string | null;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
  admin: AdminUserModel;
}

type AdminUpdateData = {
  failedLoginAttempts?: number | { increment: number };
  lockedUntil?: Date | null;
  lastTotpStep?: bigint | null;
  totpEnabledAt?: Date | null;
  lastLoginAt?: Date | null;
};

type MockPrisma = {
  adminUser: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  adminChallenge: {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  adminSession: {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  adminAuthEvent: { create: jest.Mock };
  $transaction: jest.Mock;
};

describe('AdminAuthService', () => {
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await hashAdminPassword(PASSWORD);
  });

  function buildHarness(): Harness {
    const now = new Date();
    const admin: AdminUserModel = {
      id: 'admin_1',
      email: 'operator@inverge.example',
      displayName: 'Operator',
      passwordHash,
      passwordUpdatedAt: now,
      totpSecret: encryptAdminSecret(TOTP_SECRET, KEY),
      totpEnabledAt: now,
      lastTotpStep: null,
      role: 'OPERATOR',
      status: 'ACTIVE',
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const adminState = { ...admin };
    let challenge: ChallengeFixture = {
      id: 'challenge_1',
      adminUserId: admin.id,
      tokenHash: 'unset',
      ipHash: null,
      attempts: 0,
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: null,
      createdAt: now,
      admin: adminState,
    };
    const events: Array<Record<string, unknown>> = [];
    const sessions: Array<Record<string, unknown>> = [];
    const challenges: Array<Record<string, unknown>> = [];

    const prisma: MockPrisma = {
      adminUser: {
        findUnique: jest.fn(async () => adminState),
        update: jest.fn(async ({ data }: { data: AdminUpdateData }) => {
          if (
            typeof data.failedLoginAttempts === 'object' &&
            data.failedLoginAttempts?.increment
          ) {
            adminState.failedLoginAttempts += data.failedLoginAttempts.increment;
          }
          if (typeof data.failedLoginAttempts === 'number') {
            adminState.failedLoginAttempts = data.failedLoginAttempts;
          }
          if (data.lockedUntil !== undefined) {
            adminState.lockedUntil = data.lockedUntil;
          }
          if (data.lastTotpStep !== undefined) {
            adminState.lastTotpStep = data.lastTotpStep;
          }
          if (data.totpEnabledAt !== undefined) {
            adminState.totpEnabledAt = data.totpEnabledAt;
          }
          if (data.lastLoginAt !== undefined) {
            adminState.lastLoginAt = data.lastLoginAt;
          }
          return adminState;
        }),
      },
      adminChallenge: {
        findUnique: jest.fn(async () => ({
          ...challenge,
          admin: adminState,
        })),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          challenges.push(data);
          challenge = {
            id: 'challenge_1',
            adminUserId: String(data.adminUserId),
            tokenHash: String(data.tokenHash),
            ipHash: (data.ipHash as string | null) ?? null,
            attempts: 0,
            expiresAt: data.expiresAt as Date,
            consumedAt: null,
            createdAt: now,
            admin: adminState,
          };
          return challenge;
        }),
        update: jest.fn(
          async ({ data }: { data: { attempts?: { increment: number } } }) => {
            if (challenge && data.attempts?.increment) {
              challenge.attempts += data.attempts.increment;
            }
            return { attempts: challenge?.attempts ?? 0 };
          },
        ),
        updateMany: jest.fn(
          async ({
            data,
          }: {
            data: { consumedAt?: Date; attempts?: { increment: number } };
          }) => {
            if (data.attempts?.increment) {
              challenge.attempts += data.attempts.increment;
              return { count: 1 };
            }
            if (data.consumedAt && challenge.consumedAt === null) {
              challenge.consumedAt = data.consumedAt;
              return { count: 1 };
            }
            return { count: 0 };
          },
        ),
      },
      adminSession: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          sessions.push(data);
          return data;
        }),
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(
          async ({ data }: { data: { revokedAt?: Date } }) => {
            if (data.revokedAt) return { count: 1 };
            return { count: 0 };
          },
        ),
      },
      adminAuthEvent: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          events.push(data);
          return data;
        }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (tx: MockPrisma) => Promise<unknown>) => callback(prisma),
    );

    const config = {
      get: jest.fn((key: string) => {
        switch (key) {
          case 'ADMIN_TOTP_ENCRYPTION_KEY':
            return ENCODED_KEY;
          case 'ADMIN_HASH_PEPPER':
            return PEPPER;
          case 'ADMIN_SESSION_TTL_MINUTES':
            return 20;
          case 'ADMIN_SESSION_IDLE_MINUTES':
            return 10;
          case 'ADMIN_LOGIN_MAX_ATTEMPTS':
            return 5;
          case 'ADMIN_LOGIN_LOCK_MINUTES':
            return 15;
          default:
            return undefined;
        }
      }),
    } as unknown as ConfigService<Env, true>;

    const service = new AdminAuthService(
      prisma as unknown as PrismaService,
      config,
    );

    return {
      service,
      prisma,
      admin: adminState,
      setAdmin(patch) {
        Object.assign(adminState, patch);
        prisma.adminUser.findUnique.mockImplementation(async () => adminState);
      },
      setChallenge(patch) {
        if (patch === null) {
          challenge = {
            ...challenge,
            tokenHash: 'unset',
            consumedAt: new Date(),
          };
          return;
        }
        Object.assign(challenge, patch);
        challenge.admin = adminState;
      },
      events,
      sessions,
      challenges,
    };
  }

  describe('login', () => {
    it('returns the same generic error for an unknown email', async () => {
      // given
      const h = buildHarness();
      h.prisma.adminUser.findUnique.mockResolvedValue(null);

      // when
      const attempt = h.service.login('nobody@inverge.example', PASSWORD, {
        ip: '10.0.0.1',
      });

      // then
      await expect(attempt).rejects.toMatchObject({
        status: 401,
        response: { code: 'INVALID_CREDENTIALS' },
      });
      expect(h.prisma.adminChallenge.create).not.toHaveBeenCalled();
    });

    it('increments failed attempts and audits a wrong password', async () => {
      // given
      const h = buildHarness();

      // when
      const attempt = h.service.login(h.admin.email, 'wrong password', {
        ip: '10.0.0.1',
      });

      // then
      await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
      expect(h.prisma.adminUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { failedLoginAttempts: { increment: 1 } },
        }),
      );
      expect(h.events.at(-1)).toMatchObject({
        type: 'LOGIN_FAILED',
        adminUserId: h.admin.id,
      });
    });

    it('locks the account when the failure threshold is reached', async () => {
      // given
      const h = buildHarness();
      h.setAdmin({ failedLoginAttempts: 4 });

      // when
      const attempt = h.service.login(h.admin.email, 'wrong password', {
        ip: '10.0.0.1',
      });

      // then
      await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
      expect(h.admin.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
      expect(h.events.at(-1)).toMatchObject({ type: 'LOCKED_OUT' });
    });

    it('issues a hashed single-use challenge after a correct password', async () => {
      // given
      const h = buildHarness();

      // when
      const result = await h.service.login(h.admin.email, PASSWORD, {
        ip: '10.0.0.1',
      });

      // then
      expect(result.challengeToken).toMatch(/^inv_chl_/);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(h.challenges.at(-1)).toMatchObject({
        adminUserId: h.admin.id,
        tokenHash: hashAdminToken(result.challengeToken),
        ipHash: hashAdminIdentifier('10.0.0.1', PEPPER),
      });
      expect(h.prisma.adminChallenge.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { adminUserId: h.admin.id, consumedAt: null },
        }),
      );
    });

    it('does not issue a challenge to a suspended admin', async () => {
      // given
      const h = buildHarness();
      h.setAdmin({ status: 'SUSPENDED' });

      // when
      const attempt = h.service.login(h.admin.email, PASSWORD, {});

      // then
      await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
      expect(h.prisma.adminChallenge.create).not.toHaveBeenCalled();
      expect(h.events.at(-1)).toMatchObject({
        type: 'LOGIN_FAILED',
        metadata: { reason: 'suspended' },
      });
    });

    it('does not issue a challenge while the admin is locked', async () => {
      // given
      const h = buildHarness();
      h.setAdmin({ lockedUntil: new Date(Date.now() + 60_000) });

      // when
      const attempt = h.service.login(h.admin.email, PASSWORD, {});

      // then
      await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
      expect(h.prisma.adminChallenge.create).not.toHaveBeenCalled();
    });

    it('does not extend a lock when a locked admin guesses again', async () => {
      // given
      const h = buildHarness();
      h.setAdmin({
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 60_000),
      });

      // when
      const attempt = h.service.login(h.admin.email, 'wrong password', {});

      // then
      await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
      expect(h.prisma.adminUser.update).not.toHaveBeenCalled();
    });
  });

  describe('verifyMfa', () => {
    function challengeFor(
      h: Harness,
      token = 'inv_chl_' + 'a'.repeat(43),
    ): string {
      h.setChallenge({
        tokenHash: hashAdminToken(token),
        ipHash: hashAdminIdentifier('10.0.0.1', PEPPER),
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      });
      return token;
    }

    it('consumes the challenge, resets failures and issues a session', async () => {
      // given
      const h = buildHarness();
      const token = challengeFor(h);
      const code = totpCode(TOTP_SECRET);

      // when
      const result = await h.service.verifyMfa(token, code, {
        ip: '10.0.0.1',
      });

      // then
      expect(result.sessionToken).toMatch(/^inv_adm_/);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(result.admin.capabilities).toContain('campaigns.review');
      expect(h.sessions.at(-1)).toMatchObject({
        adminUserId: h.admin.id,
        tokenHash: hashAdminToken(result.sessionToken),
      });
      expect(h.admin.failedLoginAttempts).toBe(0);
      expect(h.admin.lastTotpStep).toBe(totpStep());
      expect(h.events.at(-1)).toMatchObject({ type: 'LOGIN_SUCCEEDED' });
    });

    it('rejects a challenge presented from a different IP and consumes it', async () => {
      // given
      const h = buildHarness();
      const token = challengeFor(h);
      const code = totpCode(TOTP_SECRET);

      // when
      const attempt = h.service.verifyMfa(token, code, { ip: '10.0.0.2' });

      // then
      await expect(attempt).rejects.toMatchObject({
        response: { code: 'MFA_INVALID' },
      });
      expect(h.prisma.adminChallenge.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { consumedAt: expect.any(Date) } }),
      );
      expect(h.events.at(-1)).toMatchObject({
        type: 'MFA_FAILED',
        metadata: { reason: 'ip_mismatch' },
      });
      expect(h.sessions).toHaveLength(0);
    });

    it('counts a wrong code and expires the challenge after five tries', async () => {
      // given
      const h = buildHarness();
      const token = challengeFor(h);
      h.setChallenge({ attempts: 4 });
      const valid = totpCode(TOTP_SECRET);
      const wrong = valid[0] === '0' ? `1${valid.slice(1)}` : `0${valid.slice(1)}`;

      // when
      const attempt = h.service.verifyMfa(token, wrong, { ip: '10.0.0.1' });

      // then
      await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
      expect(h.events.at(-1)).toMatchObject({ type: 'MFA_FAILED' });
      expect(h.prisma.adminChallenge.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { consumedAt: expect.any(Date) } }),
      );
    });

    it('rejects a replayed TOTP step', async () => {
      // given
      const h = buildHarness();
      const token = challengeFor(h);
      h.setAdmin({ lastTotpStep: totpStep() });
      const code = totpCode(TOTP_SECRET);

      // when
      const attempt = h.service.verifyMfa(token, code, { ip: '10.0.0.1' });

      // then
      await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
      expect(h.events.at(-1)).toMatchObject({
        type: 'MFA_REPLAY_REJECTED',
      });
      expect(h.sessions).toHaveLength(0);
    });

    it('rejects a consumed or expired challenge without writing a session', async () => {
      // given
      const h = buildHarness();
      const token = challengeFor(h);
      h.setChallenge({ consumedAt: new Date() });

      // when
      const attempt = h.service.verifyMfa(token, totpCode(TOTP_SECRET), {
        ip: '10.0.0.1',
      });

      // then
      await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
      expect(h.sessions).toHaveLength(0);
    });
  });

  describe('resolveSession', () => {
    function sessionFixture(
      admin: AdminUserModel,
      patch: Record<string, unknown> = {},
    ): Record<string, unknown> {
      const now = new Date();
      return {
        id: 'session_1',
        adminUserId: admin.id,
        tokenHash: hashAdminToken('inv_adm_' + 'b'.repeat(43)),
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + 20 * 60_000),
        revokedAt: null,
        revokedReason: null,
        ipHash: null,
        userAgentHash: null,
        admin,
        ...patch,
      };
    }

    it('returns the current identity and refreshes lastUsedAt when stale', async () => {
      // given
      const h = buildHarness();
      const session = sessionFixture(h.admin, {
        lastUsedAt: new Date(Date.now() - 2 * 60_000),
      });
      h.prisma.adminSession.findUnique.mockResolvedValue(session);

      // when
      const result = await h.service.resolveSession(
        'inv_adm_' + 'b'.repeat(43),
        {},
      );

      // then
      expect(result.admin.id).toBe(h.admin.id);
      expect(result.admin.capabilities).toEqual(
        expect.arrayContaining(['campaigns.review', 'programmes.manage']),
      );
      expect(h.prisma.adminSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session_1' },
          data: { lastUsedAt: expect.any(Date) },
        }),
      );
    });

    it('revokes an idle session and audits the reason', async () => {
      // given
      const h = buildHarness();
      h.prisma.adminSession.findUnique.mockResolvedValue(
        sessionFixture(h.admin, {
          lastUsedAt: new Date(Date.now() - 11 * 60_000),
        }),
      );

      // when
      const attempt = h.service.resolveSession(
        'inv_adm_' + 'b'.repeat(43),
        { ip: '10.0.0.1' },
      );

      // then
      await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
      expect(h.prisma.adminSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ revokedReason: 'idle' }),
        }),
      );
      expect(h.events.at(-1)).toMatchObject({
        type: 'SESSION_REVOKED',
        metadata: { reason: 'idle' },
      });
    });

    it('revokes a session when the admin is suspended', async () => {
      // given
      const h = buildHarness();
      h.setAdmin({ status: 'SUSPENDED' });
      h.prisma.adminSession.findUnique.mockResolvedValue(
        sessionFixture(h.admin),
      );

      // when
      const attempt = h.service.resolveSession(
        'inv_adm_' + 'b'.repeat(43),
        {},
      );

      // then
      await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
      expect(h.prisma.adminSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ revokedReason: 'suspended' }),
        }),
      );
    });
  });

  describe('logout', () => {
    it('revokes the session and writes an audit event', async () => {
      // given
      const h = buildHarness();

      // when
      await h.service.logout({
        sessionId: 'session_1',
        expiresAt: new Date(Date.now() + 60_000),
        admin: {
          id: h.admin.id,
          email: h.admin.email,
          displayName: h.admin.displayName,
          role: h.admin.role,
          capabilities: ['campaigns.read'],
        },
      });

      // then
      expect(h.prisma.adminSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session_1', revokedAt: null },
          data: expect.objectContaining({ revokedReason: 'logout' }),
        }),
      );
      expect(h.events.at(-1)).toMatchObject({
        type: 'SESSION_REVOKED',
        metadata: { reason: 'logout' },
      });
    });
  });
});

describe('normalizeAdminEmail', () => {
  it('trims and lower-cases the address', () => {
    expect(normalizeAdminEmail('  Admin@Inverge.Example ')).toBe(
      'admin@inverge.example',
    );
  });
});

describe('TOTP secret round-trip', () => {
  it('is never stored as plaintext', () => {
    // given
    const key = parseAdminEncryptionKey(ENCODED_KEY);

    // when
    const encrypted = encryptAdminSecret(TOTP_SECRET, key);

    // then
    expect(encrypted).not.toContain(TOTP_SECRET);
    expect(decryptAdminSecret(encrypted, key)).toBe(TOTP_SECRET);
  });
});
