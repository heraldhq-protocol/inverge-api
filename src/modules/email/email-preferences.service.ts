import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { normalizeEmail } from '../auth/email/email-normalization';
import { verifyUnsubscribeToken } from '../../common/email';
import { EmailContextService } from './email-context.service';
import { EmailSuppressionService } from './email-suppression.service';

export interface EditorialPreference {
  subscribed: boolean;
  email: string | null;
  updatedAt: string | null;
}

function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(2, local.length - visible.length))}${email.slice(at)}`;
}

/**
 * Explicit editorial consent. A transactional preference is not consent, and
 * registration never writes a subscription row: absence means "not subscribed".
 */
@Injectable()
export class EmailPreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly context: EmailContextService,
    private readonly suppression: EmailSuppressionService,
  ) {}

  async state(userId: string): Promise<{
    editorial: EditorialPreference;
    transactionalEmailVerified: boolean;
    unsubscribeUrl: string | null;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        emailVerifiedAt: true,
        emailSubscription: {
          select: { email: true, status: true, updatedAt: true, id: true },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const subscription = user.emailSubscription;
    return {
      editorial: {
        subscribed: subscription?.status === 'SUBSCRIBED',
        email: user.email,
        updatedAt: subscription?.updatedAt.toISOString() ?? null,
      },
      transactionalEmailVerified: user.emailVerifiedAt !== null,
      unsubscribeUrl: subscription
        ? this.context.unsubscribeUrl(subscription.id)
        : null,
    };
  }

  async setEditorial(userId: string, subscribed: boolean): Promise<EditorialPreference> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const email = normalizeEmail(user.email);
    if (!email) {
      throw new ConflictException({
        code: 'EMAIL_REQUIRED',
        message: 'Add and verify an email address before subscribing to editorial email.',
      });
    }
    if (subscribed && user.emailVerifiedAt === null) {
      throw new ConflictException({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Verify your email address before subscribing to editorial email.',
      });
    }

    const now = new Date();
    const subscription = await this.prisma.emailSubscription.upsert({
      where: { userId },
      create: {
        email,
        source: 'SETTINGS',
        status: subscribed ? 'SUBSCRIBED' : 'UNSUBSCRIBED',
        subscribedAt: subscribed ? now : null,
        unsubscribedAt: subscribed ? null : now,
        userId,
      },
      update: {
        email,
        status: subscribed ? 'SUBSCRIBED' : 'UNSUBSCRIBED',
        ...(subscribed
          ? { subscribedAt: now, unsubscribedAt: null }
          : { unsubscribedAt: now }),
      },
      select: { email: true, status: true, updatedAt: true },
    });

    if (subscribed) {
      await this.suppression.clearUnsubscribe(email);
    } else {
      await this.suppression.block(email, 'UNSUBSCRIBED', 'SETTINGS');
    }

    return {
      subscribed: subscription.status === 'SUBSCRIBED',
      email: subscription.email,
      updatedAt: subscription.updatedAt.toISOString(),
    };
  }

  /** Read-only state for a link holder; returns only a masked address. */
  async byToken(token: string): Promise<{
    email: string | null;
    subscribed: boolean;
  }> {
    const subscription = await this.subscriptionForToken(token);
    return {
      email: maskEmail(subscription.email),
      subscribed: subscription.status === 'SUBSCRIBED',
    };
  }

  async unsubscribeByToken(token: string): Promise<{ subscribed: false }> {
    const subscription = await this.subscriptionForToken(token);
    const now = new Date();
    await this.prisma.emailSubscription.update({
      where: { id: subscription.id },
      data: {
        email: subscription.email,
        status: 'UNSUBSCRIBED',
        unsubscribedAt: now,
      },
    });
    await this.suppression.block(subscription.email, 'UNSUBSCRIBED', 'EMAIL_LINK');
    return { subscribed: false };
  }

  private async subscriptionForToken(token: string) {
    const secret = this.config.get('EMAIL_UNSUBSCRIBE_SECRET', { infer: true });
    const subscriptionId = verifyUnsubscribeToken(secret, token.slice(0, 200));
    if (!subscriptionId) {
      throw new BadRequestException({
        code: 'EMAIL_PREFERENCE_TOKEN_INVALID',
        message: 'This unsubscribe link is not valid.',
      });
    }
    const subscription = await this.prisma.emailSubscription.findUnique({
      where: { id: subscriptionId },
      select: { id: true, email: true, status: true },
    });
    if (!subscription) throw new NotFoundException('Subscription not found');
    return subscription;
  }
}
