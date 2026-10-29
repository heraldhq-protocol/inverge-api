import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../../generated/prisma/client';
import type { EmailVerificationPurpose } from '../../../generated/prisma/client';
import { randomUUID } from 'node:crypto';
import { Env } from '../../../config/env.validation';
import { PrismaService } from '../../../prisma/prisma.service';
import { EMAIL_PORT, EmailPort } from '../../../ports/email/email.port';
import { normalizeEmail } from './email-normalization';
import {
  generateVerificationCode,
  hashVerificationCode,
  parseVerificationCode,
  verificationCodeMatches,
} from './email-code';
import { renderVerificationEmail } from './email-template';

export type RequestCodeResult =
  | {
      status: 'code_sent';
      email: string;
      expiresAt: string;
      resendAvailableAt: string;
    }
  | { status: 'already_verified'; email: string }
  | { status: 'cooldown'; retryAfterSeconds: number }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'delivery_failed' };

export type VerifyCodeResult =
  | { status: 'verified'; email: string; verifiedAt: string }
  | { status: 'already_verified'; email: string }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'too_many_attempts' }
  | { status: 'unavailable' };

interface LockedChallenge {
  id: string;
  email: string;
  purpose: EmailVerificationPurpose;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  consumedAt: Date | null;
}

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);
  private readonly ttlSeconds: number;
  private readonly cooldownSeconds: number;
  private readonly maxAttempts: number;
  private readonly maxPerHour: number;
  private readonly codeSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
  ) {
    this.ttlSeconds = this.config.get('EMAIL_VERIFICATION_CODE_TTL_SECONDS', {
      infer: true,
    });
    this.cooldownSeconds = this.config.get(
      'EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS',
      { infer: true },
    );
    this.maxAttempts = this.config.get('EMAIL_VERIFICATION_MAX_ATTEMPTS', {
      infer: true,
    });
    this.maxPerHour = this.config.get('EMAIL_VERIFICATION_MAX_PER_HOUR', {
      infer: true,
    });
    this.codeSecret = this.config.get('EMAIL_CODE_SECRET', { infer: true });
  }

  async status(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        emailVerifiedAt: true,
        pendingEmail: true,
        pendingEmailRequestedAt: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const now = new Date();
    const challenge = await this.prisma.emailVerificationChallenge.findFirst({
      where: {
        userId,
        consumedAt: null,
        supersededAt: null,
        deliveryFailedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        email: true,
        purpose: true,
        expiresAt: true,
        attempts: true,
        maxAttempts: true,
        lastSentAt: true,
      },
    });

    return {
      email: user.email,
      verified: user.emailVerifiedAt !== null,
      verifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
      pendingEmail: user.pendingEmail,
      pendingRequestedAt: user.pendingEmailRequestedAt?.toISOString() ?? null,
      challenge: challenge
        ? {
            email: challenge.email,
            purpose: challenge.purpose,
            expiresAt: challenge.expiresAt.toISOString(),
            resendAvailableAt: new Date(
              challenge.lastSentAt.getTime() + this.cooldownSeconds * 1_000,
            ).toISOString(),
            attemptsRemaining: Math.max(
              0,
              challenge.maxAttempts - challenge.attempts,
            ),
          }
        : null,
    };
  }

  async request(userId: string, rawEmail: string): Promise<RequestCodeResult> {
    const email = this.requireEmail(rawEmail);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const hasVerifiedEmail =
      user.email !== null && user.emailVerifiedAt !== null;
    if (hasVerifiedEmail && user.email === email) {
      return { status: 'already_verified', email };
    }

    // With no verified address yet, any requested address is a SIGNUP proof. A
    // verified account asking for a different address is a CHANGE, and the old
    // address stays in place until the new one is verified.
    const purpose: EmailVerificationPurpose = hasVerifiedEmail
      ? 'CHANGE'
      : 'SIGNUP';
    return this.issue(userId, email, purpose);
  }

  async verify(
    userId: string,
    rawEmail: string,
    rawCode: string,
  ): Promise<VerifyCodeResult> {
    const email = this.requireEmail(rawEmail);
    const code = parseVerificationCode(rawCode);
    if (!code) return { status: 'invalid' };

    const now = new Date();
    let outcome: VerifyCodeResult;

    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, userId);
        const challenge = await this.lockLatestChallenge(tx, userId, email);
        if (!challenge) return { status: 'invalid' } as VerifyCodeResult;

        if (challenge.expiresAt.getTime() <= now.getTime()) {
          await tx.emailVerificationChallenge.update({
            where: { id: challenge.id },
            data: { supersededAt: now },
          });
          return { status: 'expired' } as VerifyCodeResult;
        }
        if (challenge.attempts >= challenge.maxAttempts) {
          return { status: 'too_many_attempts' } as VerifyCodeResult;
        }

        await tx.emailVerificationChallenge.update({
          where: { id: challenge.id },
          data: { attempts: { increment: 1 } },
        });

        if (
          !verificationCodeMatches(
            challenge.codeHash,
            this.codeSecret,
            challenge.id,
            code,
          )
        ) {
          return { status: 'invalid' } as VerifyCodeResult;
        }

        const current = await tx.user.findUnique({
          where: { id: userId },
          select: { email: true, emailVerifiedAt: true },
        });
        if (!current) throw new NotFoundException('User not found');

        if (current.email === email && current.emailVerifiedAt !== null) {
          await tx.emailVerificationChallenge.update({
            where: { id: challenge.id },
            data: { consumedAt: now },
          });
          return { status: 'already_verified', email } as VerifyCodeResult;
        }

        // Another account may already own this address. The user has proven
        // mailbox control, but accounts are never merged automatically; this is
        // a generic conflict, not an enumeration oracle.
        const owner = await tx.user.findUnique({
          where: { email },
          select: { id: true },
        });
        if (owner && owner.id !== userId) {
          await tx.emailVerificationChallenge.update({
            where: { id: challenge.id },
            data: { consumedAt: now },
          });
          return { status: 'unavailable' } as VerifyCodeResult;
        }

        const consumed = await tx.emailVerificationChallenge.updateMany({
          where: { id: challenge.id, consumedAt: null },
          data: { consumedAt: now },
        });
        // A concurrent request consumed the same code first.
        if (consumed.count !== 1)
          return { status: 'invalid' } as VerifyCodeResult;

        await tx.emailVerificationChallenge.updateMany({
          where: {
            userId,
            id: { not: challenge.id },
            consumedAt: null,
            supersededAt: null,
          },
          data: { supersededAt: now },
        });

        await tx.user.update({
          where: { id: userId },
          data: {
            email,
            emailVerified: true,
            emailVerifiedAt: now,
            pendingEmail: null,
            pendingEmailRequestedAt: null,
          },
        });

        return {
          status: 'verified',
          email,
          verifiedAt: now.toISOString(),
        } as VerifyCodeResult;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { status: 'unavailable' };
      }
      throw error;
    }

    return outcome;
  }

  async resend(userId: string): Promise<RequestCodeResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, pendingEmail: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const now = new Date();
    const issued = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, userId);
      const latest = await tx.emailVerificationChallenge.findFirst({
        where: {
          userId,
          consumedAt: null,
          supersededAt: null,
          deliveryFailedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!latest) return { kind: 'none' as const };

      const availableAt =
        latest.lastSentAt.getTime() + this.cooldownSeconds * 1_000;
      if (availableAt > now.getTime()) {
        return {
          kind: 'cooldown' as const,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((availableAt - now.getTime()) / 1_000),
          ),
        };
      }

      const recent = await tx.emailVerificationChallenge.count({
        where: {
          userId,
          createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1_000) },
        },
      });
      if (recent >= this.maxPerHour) {
        return { kind: 'rate_limited' as const, retryAfterSeconds: 3_600 };
      }

      await tx.emailVerificationChallenge.updateMany({
        where: { userId, consumedAt: null, supersededAt: null },
        data: { supersededAt: now },
      });

      return this.createChallenge(
        tx,
        userId,
        latest.email,
        latest.purpose,
        now,
      );
    });

    if (issued.kind === 'none') {
      throw new BadRequestException({
        code: 'EMAIL_NO_ACTIVE_CODE',
        message: 'Request a new verification code first.',
      });
    }
    if (issued.kind === 'cooldown')
      return {
        status: 'cooldown',
        retryAfterSeconds: issued.retryAfterSeconds,
      };
    if (issued.kind === 'rate_limited')
      return {
        status: 'rate_limited',
        retryAfterSeconds: issued.retryAfterSeconds,
      };

    return this.deliver(issued, userId);
  }

  async cancelPending(userId: string) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, userId);
      await tx.user.update({
        where: { id: userId },
        data: { pendingEmail: null, pendingEmailRequestedAt: null },
      });
      // Abandoning the screen must also retire a SIGNUP code, not only a
      // pending change; otherwise the old code stays live while the caller
      // enters a different address. The hourly issuance cap still bounds abuse.
      await tx.emailVerificationChallenge.updateMany({
        where: { userId, consumedAt: null, supersededAt: null },
        data: { supersededAt: now },
      });
    });
    return { pendingEmail: null };
  }

  private async issue(
    userId: string,
    email: string,
    purpose: EmailVerificationPurpose,
  ): Promise<RequestCodeResult> {
    const now = new Date();
    const issued = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, userId);

      const recent = await tx.emailVerificationChallenge.count({
        where: {
          userId,
          createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1_000) },
        },
      });
      if (recent >= this.maxPerHour) {
        return { kind: 'rate_limited' as const, retryAfterSeconds: 3_600 };
      }

      const latest = await tx.emailVerificationChallenge.findFirst({
        where: {
          userId,
          consumedAt: null,
          supersededAt: null,
          deliveryFailedAt: null,
        },
        orderBy: { lastSentAt: 'desc' },
      });
      if (latest) {
        const availableAt =
          latest.lastSentAt.getTime() + this.cooldownSeconds * 1_000;
        if (availableAt > now.getTime()) {
          return {
            kind: 'cooldown' as const,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((availableAt - now.getTime()) / 1_000),
            ),
          };
        }
      }

      await tx.emailVerificationChallenge.updateMany({
        where: { userId, consumedAt: null, supersededAt: null },
        data: { supersededAt: now },
      });

      await tx.user.update({
        where: { id: userId },
        data:
          purpose === 'CHANGE'
            ? { pendingEmail: email, pendingEmailRequestedAt: now }
            : { pendingEmail: null, pendingEmailRequestedAt: null },
      });

      return this.createChallenge(tx, userId, email, purpose, now);
    });

    if (issued.kind === 'cooldown')
      return {
        status: 'cooldown',
        retryAfterSeconds: issued.retryAfterSeconds,
      };
    if (issued.kind === 'rate_limited')
      return {
        status: 'rate_limited',
        retryAfterSeconds: issued.retryAfterSeconds,
      };

    return this.deliver(issued, userId);
  }

  private async createChallenge(
    tx: Prisma.TransactionClient,
    userId: string,
    email: string,
    purpose: EmailVerificationPurpose,
    now: Date,
  ) {
    const id = randomUUID();
    const code = generateVerificationCode();
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1_000);
    await tx.emailVerificationChallenge.create({
      data: {
        id,
        userId,
        purpose,
        email,
        codeHash: hashVerificationCode(this.codeSecret, id, code),
        expiresAt,
        maxAttempts: this.maxAttempts,
        lastSentAt: now,
      },
    });
    return {
      kind: 'issued' as const,
      id,
      email,
      purpose,
      code,
      expiresAt,
      lastSentAt: now,
    };
  }

  private async deliver(
    issued: {
      id: string;
      email: string;
      purpose: EmailVerificationPurpose;
      code: string;
      expiresAt: Date;
      lastSentAt: Date;
    },
    userId: string,
  ): Promise<RequestCodeResult> {
    const content = renderVerificationEmail({
      code: issued.code,
      expiresInMinutes: Math.max(1, Math.round(this.ttlSeconds / 60)),
      purpose: issued.purpose,
    });

    try {
      await this.email.send({
        to: issued.email,
        subject: content.subject,
        text: content.text,
        html: content.html,
        idempotencyKey: `email-verification/${issued.id}`,
      });
    } catch (error) {
      const status =
        error instanceof Error && 'providerStatus' in error
          ? (error as { providerStatus?: number }).providerStatus
          : undefined;
      this.logger.warn(
        `Email verification delivery failed (${status ?? 'network'})`,
      );
      await this.prisma.emailVerificationChallenge
        .update({
          where: { id: issued.id },
          data: { deliveryFailedAt: new Date(), supersededAt: new Date() },
        })
        .catch(() => undefined);
      if (issued.purpose === 'CHANGE') {
        await this.prisma.user
          .update({
            where: { id: userId },
            data: { pendingEmail: null, pendingEmailRequestedAt: null },
          })
          .catch(() => undefined);
      }
      return { status: 'delivery_failed' };
    }

    return {
      status: 'code_sent',
      email: issued.email,
      expiresAt: issued.expiresAt.toISOString(),
      resendAvailableAt: new Date(
        issued.lastSentAt.getTime() + this.cooldownSeconds * 1_000,
      ).toISOString(),
    };
  }

  private requireEmail(rawEmail: string): string {
    const email = normalizeEmail(rawEmail);
    if (!email) {
      throw new BadRequestException({
        code: 'EMAIL_INVALID',
        message: 'Enter a valid email address.',
      });
    }
    return email;
  }

  private async lock(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    // Serialise issuance/verification for one user across API replicas. Without
    // this, two concurrent requests could both supersede and issue a live code.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`email:${userId}`}))`;
  }

  private async lockLatestChallenge(
    tx: Prisma.TransactionClient,
    userId: string,
    email: string,
  ): Promise<LockedChallenge | null> {
    const rows = await tx.$queryRaw<LockedChallenge[]>`
      SELECT id, email, purpose, "codeHash", "expiresAt", attempts, "maxAttempts", "consumedAt"
      FROM "EmailVerificationChallenge"
      WHERE "userId" = ${userId}
        AND email = ${email}
        AND "consumedAt" IS NULL
        AND "supersededAt" IS NULL
      ORDER BY "createdAt" DESC
      LIMIT 1
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }
}
