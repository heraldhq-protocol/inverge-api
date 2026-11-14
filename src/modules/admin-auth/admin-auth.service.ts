import {
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import type { Prisma } from '../../generated/prisma/client';
import type { AdminUserModel } from '../../generated/prisma/models';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  AdminIdentity,
  AdminSessionContext,
} from './admin-auth.types';
import { adminCapabilitiesForRole } from './capabilities';
import {
  DUMMY_PASSWORD_HASH,
  verifyAdminPassword,
} from './password';
import {
  AdminSecretBoxError,
  decryptAdminSecret,
  parseAdminEncryptionKey,
} from './secret-box';
import {
  createAdminChallengeToken,
  createAdminSessionToken,
  hashAdminIdentifier,
  hashAdminToken,
} from './tokens';
import { verifyTotpCode } from './totp';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_MAX_ATTEMPTS = 5;
const LAST_USED_GRANULARITY_MS = 60 * 1000;

interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

interface ContextHashes {
  ipHash: string | null;
  userAgentHash: string | null;
}

export interface LoginResult {
  challengeToken: string;
  expiresAt: Date;
}

export interface MfaResult {
  sessionToken: string;
  expiresAt: Date;
  admin: AdminIdentity;
}

export interface AdminMeResult {
  admin: AdminIdentity;
  expiresAt: Date;
}

/**
 * Dedicated admin authentication, phases 1-2 (docs/admin/admin-auth.md).
 *
 * Password and TOTP are two separate steps joined by a single-use challenge.
 * No session exists until a valid code has been consumed, and every failure
 * returns the same shape so account existence, suspension and lock state are
 * not observable from the API.
 */
@Injectable()
export class AdminAuthService {
  private cachedEncryptionKey: Buffer | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async login(
    email: string,
    password: string,
    context: RequestContext,
  ): Promise<LoginResult> {
    this.encryptionKey();
    const now = new Date();
    const hashes = this.contextHashes(context);
    const admin = await this.prisma.adminUser.findUnique({
      where: { email: normalizeAdminEmail(email) },
    });

    if (!admin) {
      // Spend the same Argon2 work as a known account so the response time does
      // not answer "does this inbox have an admin row?".
      await verifyAdminPassword(DUMMY_PASSWORD_HASH, password);
      throw this.invalidCredentials();
    }

    const passwordOk = await verifyAdminPassword(admin.passwordHash, password);
    if (!passwordOk) {
      // Do not extend an existing lock with further guesses; the lock should
      // expire on its own timer, not on an attacker's retry loop.
      if (!isLocked(admin, now)) {
        await this.registerFailure(admin, 'LOGIN_FAILED', hashes, now);
      }
      throw this.invalidCredentials();
    }

    if (admin.status !== 'ACTIVE') {
      await this.recordEvent(admin.id, 'LOGIN_FAILED', hashes, {
        reason: 'suspended',
      });
      throw this.invalidCredentials();
    }

    if (isLocked(admin, now)) {
      throw this.invalidCredentials();
    }

    const challengeToken = createAdminChallengeToken();
    const challengeExpiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);

    await this.prisma.$transaction(async (tx) => {
      // One live challenge per admin: a second password success invalidates a
      // challenge an attacker may already hold.
      await tx.adminChallenge.updateMany({
        where: { adminUserId: admin.id, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.adminChallenge.create({
        data: {
          adminUserId: admin.id,
          tokenHash: hashAdminToken(challengeToken),
          ipHash: hashes.ipHash,
          expiresAt: challengeExpiresAt,
        },
      });
    });

    return { challengeToken, expiresAt: challengeExpiresAt };
  }

  async verifyMfa(
    challengeToken: string,
    code: string,
    context: RequestContext,
  ): Promise<MfaResult> {
    const encryptionKey = this.encryptionKey();
    const now = new Date();
    const hashes = this.contextHashes(context);
    const challenge = await this.prisma.adminChallenge.findUnique({
      where: { tokenHash: hashAdminToken(challengeToken) },
      include: { admin: true },
    });

    if (
      !challenge ||
      challenge.consumedAt !== null ||
      challenge.expiresAt.getTime() <= now.getTime()
    ) {
      throw this.invalidMfa();
    }

    const { admin } = challenge;
    if (admin.status !== 'ACTIVE' || isLocked(admin, now)) {
      throw this.invalidMfa();
    }

    // The challenge is bound to the IP that passed the password step. A missing
    // request IP cannot satisfy a challenge that recorded one.
    if (challenge.ipHash !== null && challenge.ipHash !== hashes.ipHash) {
      await this.prisma.$transaction(async (tx) => {
        const consumed = await tx.adminChallenge.updateMany({
          where: { id: challenge.id, consumedAt: null },
          data: { consumedAt: now },
        });
        if (consumed.count !== 1) return;
        await tx.adminAuthEvent.create({
          data: {
            adminUserId: admin.id,
            type: 'MFA_FAILED',
            ipHash: hashes.ipHash,
            userAgentHash: hashes.userAgentHash,
            metadata: { reason: 'ip_mismatch' },
          },
        });
      });
      throw this.invalidMfa();
    }

    let secret: string;
    try {
      secret = decryptAdminSecret(admin.totpSecret, encryptionKey);
    } catch (error) {
      if (error instanceof AdminSecretBoxError) {
        throw new InternalServerErrorException({
          code: 'ADMIN_AUTH_STATE_INVALID',
          message: 'Admin authentication is temporarily unavailable.',
        });
      }
      throw error;
    }

    const verification = verifyTotpCode({
      secret,
      code,
      atMs: now.getTime(),
      lastStep: admin.lastTotpStep,
    });

    if (!verification.ok) {
      const eventType =
        verification.reason === 'replay'
          ? 'MFA_REPLAY_REJECTED'
          : 'MFA_FAILED';
      await this.registerMfaFailure(challenge.id, admin, eventType, hashes, now);
      throw this.invalidMfa();
    }

    const token = createAdminSessionToken();
    const tokenHash = hashAdminToken(token);
    const expiresAt = new Date(
      now.getTime() + this.minutes('ADMIN_SESSION_TTL_MINUTES') * 60_000,
    );

    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.adminChallenge.updateMany({
        where: {
          id: challenge.id,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) {
        throw this.invalidMfa();
      }

      await tx.adminSession.create({
        data: {
          adminUserId: admin.id,
          tokenHash,
          expiresAt,
          ipHash: hashes.ipHash,
          userAgentHash: hashes.userAgentHash,
        },
      });

      await tx.adminUser.update({
        where: { id: admin.id },
        data: {
          lastTotpStep: verification.step,
          totpEnabledAt: admin.totpEnabledAt ?? now,
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: now,
        },
      });

      await tx.adminAuthEvent.create({
        data: {
          adminUserId: admin.id,
          type: 'LOGIN_SUCCEEDED',
          ipHash: hashes.ipHash,
          userAgentHash: hashes.userAgentHash,
          metadata: { mfa: 'totp' },
        },
      });
    });

    return {
      sessionToken: token,
      expiresAt,
      admin: toIdentity(admin),
    };
  }

  async resolveSession(
    token: string,
    context: RequestContext,
  ): Promise<AdminSessionContext> {
    const now = new Date();
    const hashes = this.contextHashes(context);
    const session = await this.prisma.adminSession.findUnique({
      where: { tokenHash: hashAdminToken(token) },
      include: { admin: true },
    });

    if (!session || session.revokedAt !== null) {
      throw this.invalidSession();
    }

    if (session.admin.status !== 'ACTIVE') {
      await this.revokeSession(
        session.id,
        'suspended',
        session.adminUserId,
        hashes,
      );
      throw this.invalidSession();
    }

    if (session.expiresAt.getTime() <= now.getTime()) {
      await this.revokeSession(
        session.id,
        'expired',
        session.adminUserId,
        hashes,
      );
      throw this.invalidSession();
    }

    const idleDeadline =
      session.lastUsedAt.getTime() +
      this.minutes('ADMIN_SESSION_IDLE_MINUTES') * 60_000;
    if (idleDeadline <= now.getTime()) {
      await this.revokeSession(session.id, 'idle', session.adminUserId, hashes);
      throw this.invalidSession();
    }

    if (now.getTime() - session.lastUsedAt.getTime() >= LAST_USED_GRANULARITY_MS) {
      await this.prisma.adminSession.update({
        where: { id: session.id },
        data: { lastUsedAt: now },
      });
    }

    return {
      sessionId: session.id,
      expiresAt: session.expiresAt,
      admin: toIdentity(session.admin),
    };
  }

  async logout(session: AdminSessionContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.adminSession.updateMany({
        where: { id: session.sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'logout' },
      });
      if (revoked.count === 1) {
        await tx.adminAuthEvent.create({
          data: {
            adminUserId: session.admin.id,
            type: 'SESSION_REVOKED',
            metadata: { reason: 'logout' },
          },
        });
      }
    });
  }

  private async registerFailure(
    admin: AdminUserModel,
    type: 'LOGIN_FAILED',
    hashes: ContextHashes,
    now: Date,
  ): Promise<void> {
    const maxAttempts = this.config.get('ADMIN_LOGIN_MAX_ATTEMPTS', {
      infer: true,
    });
    const lockMinutes = this.config.get('ADMIN_LOGIN_LOCK_MINUTES', {
      infer: true,
    });

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.adminUser.update({
        where: { id: admin.id },
        data: { failedLoginAttempts: { increment: 1 } },
      });
      const locked = updated.failedLoginAttempts >= maxAttempts;
      if (locked) {
        await tx.adminUser.update({
          where: { id: admin.id },
          data: {
            lockedUntil: new Date(now.getTime() + lockMinutes * 60_000),
          },
        });
      }
      await tx.adminAuthEvent.create({
        data: {
          adminUserId: admin.id,
          type: locked ? 'LOCKED_OUT' : type,
          ipHash: hashes.ipHash,
          userAgentHash: hashes.userAgentHash,
          metadata: {
            failedAttempts: updated.failedLoginAttempts,
            locked,
          },
        },
      });
    });
  }

  private async registerMfaFailure(
    challengeId: string,
    admin: AdminUserModel,
    type: 'MFA_FAILED' | 'MFA_REPLAY_REJECTED',
    hashes: ContextHashes,
    now: Date,
  ): Promise<void> {
    const maxAttempts = this.config.get('ADMIN_LOGIN_MAX_ATTEMPTS', {
      infer: true,
    });
    const lockMinutes = this.config.get('ADMIN_LOGIN_LOCK_MINUTES', {
      infer: true,
    });

    await this.prisma.$transaction(async (tx) => {
      // A concurrent successful verification may have consumed this challenge
      // first. In that case the failure must not count against the admin or
      // revive a challenge that no longer exists.
      const incremented = await tx.adminChallenge.updateMany({
        where: {
          id: challengeId,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { attempts: { increment: 1 } },
      });
      if (incremented.count !== 1) return;

      const challenge = await tx.adminChallenge.findUnique({
        where: { id: challengeId },
        select: { attempts: true },
      });
      const attempts = challenge?.attempts ?? 0;
      if (attempts >= CHALLENGE_MAX_ATTEMPTS) {
        await tx.adminChallenge.updateMany({
          where: { id: challengeId, consumedAt: null },
          data: { consumedAt: now },
        });
      }

      const updated = await tx.adminUser.update({
        where: { id: admin.id },
        data: { failedLoginAttempts: { increment: 1 } },
      });
      const locked = updated.failedLoginAttempts >= maxAttempts;
      if (locked) {
        await tx.adminUser.update({
          where: { id: admin.id },
          data: {
            lockedUntil: new Date(now.getTime() + lockMinutes * 60_000),
          },
        });
      }

      await tx.adminAuthEvent.create({
        data: {
          adminUserId: admin.id,
          type,
          ipHash: hashes.ipHash,
          userAgentHash: hashes.userAgentHash,
          metadata: {
            failedAttempts: updated.failedLoginAttempts,
            challengeAttempts: attempts,
            locked,
          },
        },
      });
    });
  }

  private async revokeSession(
    id: string,
    reason: string,
    adminUserId: string,
    hashes: ContextHashes,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.adminSession.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
      if (revoked.count === 1) {
        await tx.adminAuthEvent.create({
          data: {
            adminUserId,
            type: 'SESSION_REVOKED',
            ipHash: hashes.ipHash,
            userAgentHash: hashes.userAgentHash,
            metadata: { reason },
          },
        });
      }
    });
  }

  private async recordEvent(
    adminUserId: string,
    type: 'LOGIN_FAILED',
    hashes: ContextHashes,
    metadata: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.prisma.adminAuthEvent.create({
      data: {
        adminUserId,
        type,
        ipHash: hashes.ipHash,
        userAgentHash: hashes.userAgentHash,
        metadata,
      },
    });
  }

  private contextHashes(context: RequestContext): ContextHashes {
    const pepper = this.config.get('ADMIN_HASH_PEPPER', { infer: true });
    return {
      ipHash: hashAdminIdentifier(context.ip, pepper),
      userAgentHash: hashAdminIdentifier(context.userAgent, pepper),
    };
  }

  private minutes(
    key: 'ADMIN_SESSION_TTL_MINUTES' | 'ADMIN_SESSION_IDLE_MINUTES',
  ): number {
    return this.config.get(key, { infer: true });
  }

  private encryptionKey(): Buffer {
    if (this.cachedEncryptionKey) return this.cachedEncryptionKey;
    const encoded = this.config.get('ADMIN_TOTP_ENCRYPTION_KEY', {
      infer: true,
    });
    try {
      this.cachedEncryptionKey = parseAdminEncryptionKey(encoded);
    } catch {
      throw new ServiceUnavailableException({
        code: 'ADMIN_AUTH_NOT_CONFIGURED',
        message: 'Admin authentication is not configured.',
      });
    }
    return this.cachedEncryptionKey;
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password.',
    });
  }

  private invalidMfa(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'MFA_INVALID',
      message: 'That code is not valid.',
    });
  }

  private invalidSession(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'SESSION_EXPIRED',
      message: 'Admin authentication required.',
    });
  }
}

export function normalizeAdminEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isLocked(admin: AdminUserModel, now: Date): boolean {
  return (
    admin.lockedUntil !== null && admin.lockedUntil.getTime() > now.getTime()
  );
}

function toIdentity(admin: AdminUserModel): AdminIdentity {
  return {
    id: admin.id,
    email: admin.email,
    displayName: admin.displayName,
    role: admin.role,
    capabilities: adminCapabilitiesForRole(admin.role),
  };
}
