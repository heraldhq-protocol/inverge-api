import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma/client';
import type { EmailCategory, EmailDeliveryStatus } from '../../generated/prisma/client';
import type { Env } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { EMAIL_PORT, EmailDeliveryError, EmailPort } from '../../ports/email/email.port';
import { NotificationMessage } from '../../ports/notification/notification.port';
import { notificationEmailTemplate } from '../../ports/notification/notification-email';
import { EMAIL_TEMPLATES, EmailTemplateId, TemplateVariables, renderEmailTemplate } from '../../common/email';
import { normalizeEmail } from '../auth/email/email-normalization';
import { EmailContextService } from './email-context.service';

export interface DeliverEmailInput {
  to: string;
  templateId: EmailTemplateId;
  variables: TemplateVariables;
  /** Stable identity for the underlying domain event + recipient. */
  idempotencyKey: string;
  userId?: string | null;
  locale?: string;
}

export type DeliveryOutcome =
  | { status: 'sent'; deliveryId: string; providerMessageId: string | null }
  | { status: 'duplicate'; deliveryId: string; deliveryStatus: EmailDeliveryStatus }
  | { status: 'suppressed'; deliveryId: string; reason: string }
  | { status: 'exhausted'; deliveryId: string };

const TERMINAL_SUCCESS: EmailDeliveryStatus[] = ['SENT', 'DELIVERED'];
const TERMINAL_FAILURE: EmailDeliveryStatus[] = ['BOUNCED', 'COMPLAINED', 'SUPPRESSED'];

function isTerminal(status: EmailDeliveryStatus): boolean {
  return TERMINAL_SUCCESS.includes(status) || TERMINAL_FAILURE.includes(status);
}

/**
 * The only outbound email path.
 *
 * The row is claimed before the provider call, so two workers handling the same
 * event cannot both send, and a retry after a genuine failure is bounded. A
 * provider `202` means accepted, not delivered: `SENT` is recorded with the
 * provider message id and the signed webhook moves it to `DELIVERED`,
 * `BOUNCED` or `COMPLAINED`.
 */
@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);
  private readonly maxAttempts: number;
  private readonly staleSendSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly context: EmailContextService,
    @Inject(EMAIL_PORT) private readonly port: EmailPort,
  ) {
    this.maxAttempts = this.config.get('EMAIL_DELIVERY_MAX_ATTEMPTS', {
      infer: true,
    });
    this.staleSendSeconds = this.config.get('EMAIL_DELIVERY_STALE_SECONDS', {
      infer: true,
    });
  }

  /** Renders and delivers a notification row through the same pipeline. */
  async sendNotification(
    message: NotificationMessage & { toEmail: string },
  ): Promise<DeliveryOutcome> {
    const mapping = notificationEmailTemplate(message);
    return this.deliver({
      idempotencyKey: message.notificationId
        ? `notification/${message.notificationId}`
        : `${message.template}:${message.toUserId}:${message.dedupeKey ?? ''}`,
      templateId: mapping.templateId,
      to: message.toEmail,
      userId: message.toUserId,
      variables: mapping.variables,
    });
  }

  async deliver(input: DeliverEmailInput): Promise<DeliveryOutcome> {
    const to = normalizeEmail(input.to);
    if (!to) {
      throw new EmailDeliveryError('Recipient address is invalid');
    }

    const definition = EMAIL_TEMPLATES[input.templateId];
    if (!definition) {
      throw new EmailDeliveryError('Email template is not registered');
    }
    const category: EmailCategory =
      definition.category === 'marketing' ? 'MARKETING' : 'TRANSACTIONAL';

    const suppression = await this.suppressionFor(to, category, input.userId ?? null);
    if (suppression) {
      const delivery = await this.prisma.emailDelivery.upsert({
        where: { idempotencyKey: input.idempotencyKey },
        create: {
          category,
          idempotencyKey: input.idempotencyKey,
          lastError: suppression.slice(0, 300),
          recipient: to,
          status: 'SUPPRESSED',
          template: input.templateId,
          userId: input.userId ?? null,
        },
        update: {},
        select: { id: true },
      });
      return { status: 'suppressed', deliveryId: delivery.id, reason: suppression };
    }

    let unsubscribeUrl: string | undefined;
    if (category === 'MARKETING') {
      const subscription = input.userId
        ? await this.prisma.emailSubscription.findUnique({
            where: { userId: input.userId },
            select: { id: true },
          })
        : null;
      if (subscription) unsubscribeUrl = this.context.unsubscribeUrl(subscription.id);
    }

    // Render before claiming the row: a template/variable bug must not leave a
    // SENDING row behind for a message that was never attempted.
    const rendered = renderEmailTemplate(
      input.templateId,
      input.variables,
      {
        ...this.context.renderOptions(),
        ...(unsubscribeUrl ? { unsubscribeUrl } : {}),
        ...(input.locale ? { locale: input.locale } : {}),
      },
    );

    const existing = await this.claim(input, to, category);
    if (existing.kind !== 'claimed') return existing.outcome;
    const deliveryId = existing.deliveryId;

    try {
      const result = await this.port.send({
        to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        idempotencyKey: input.idempotencyKey,
        deliveryId,
        ...(unsubscribeUrl ? { listUnsubscribeUrl: unsubscribeUrl } : {}),
      });
      await this.markSent(deliveryId, result.providerMessageId ?? null);
      return {
        status: 'sent',
        deliveryId,
        providerMessageId: result.providerMessageId ?? null,
      };
    } catch (error) {
      const message =
        error instanceof EmailDeliveryError
          ? error.message
          : 'Email provider request failed';
      await this.markFailed(deliveryId, message, category);
      throw error instanceof EmailDeliveryError
        ? error
        : new EmailDeliveryError(message);
    }
  }

  private async claim(
    input: DeliverEmailInput,
    to: string,
    category: EmailCategory,
  ): Promise<
    | { kind: 'claimed'; deliveryId: string }
    | { kind: 'existing'; outcome: DeliveryOutcome }
  > {
    let delivery: { id: string; attempts: number; status: EmailDeliveryStatus };
    try {
      delivery = await this.prisma.emailDelivery.create({
        data: {
          category,
          idempotencyKey: input.idempotencyKey,
          recipient: to,
          template: input.templateId,
          userId: input.userId ?? null,
        },
        select: { id: true, attempts: true, status: true },
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      ) {
        throw error;
      }
      const found = await this.prisma.emailDelivery.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, attempts: true, status: true },
      });
      if (!found) throw error;
      delivery = found;
    }

    if (isTerminal(delivery.status)) {
      return {
        kind: 'existing',
        outcome: {
          status: 'duplicate',
          deliveryId: delivery.id,
          deliveryStatus: delivery.status,
        },
      };
    }
    if (delivery.attempts >= this.maxAttempts) {
      return {
        kind: 'existing',
        outcome: { status: 'exhausted', deliveryId: delivery.id },
      };
    }

    const staleBefore = new Date(
      Date.now() - this.staleSendSeconds * 1_000,
    );
    const claimed = await this.prisma.emailDelivery.updateMany({
      where: {
        id: delivery.id,
        OR: [
          { status: 'PENDING' },
          { status: 'FAILED' },
          { status: 'DELAYED' },
          { status: 'SENDING', updatedAt: { lt: staleBefore } },
        ],
      },
      data: { lastError: null, status: 'SENDING', attempts: { increment: 1 } },
    });

    if (claimed.count !== 1) {
      const current = await this.prisma.emailDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
        select: { status: true },
      });
      return {
        kind: 'existing',
        outcome: {
          status: 'duplicate',
          deliveryId: delivery.id,
          deliveryStatus: current.status,
        },
      };
    }

    return { kind: 'claimed', deliveryId: delivery.id };
  }

  private async markSent(deliveryId: string, providerMessageId: string | null) {
    const sentAt = new Date();
    try {
      // A fast provider webhook may already have moved the row to DELIVERED.
      // Only an unsent row may be promoted to SENT; never regress a terminal or
      // already-confirmed state.
      const updated = await this.prisma.emailDelivery.updateMany({
        where: {
          id: deliveryId,
          status: { in: ['PENDING', 'SENDING', 'DELAYED', 'FAILED'] },
        },
        data: { providerMessageId, sentAt, status: 'SENT' },
      });
      if (updated.count === 0 && providerMessageId) {
        // Fill correlation when the webhook matched the delivery tag first.
        await this.prisma.emailDelivery.updateMany({
          where: { id: deliveryId, providerMessageId: null },
          data: { providerMessageId, sentAt },
        });
      }
    } catch (error) {
      // A provider id collision is not a delivery failure: the message was
      // accepted. Record the acceptance and keep the correlation best-effort.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        await this.prisma.emailDelivery.updateMany({
          where: { id: deliveryId, status: { in: ['PENDING', 'SENDING'] } },
          data: { sentAt, status: 'SENT' },
        });
        return;
      }
      throw error;
    }
  }

  private async markFailed(
    deliveryId: string,
    message: string,
    category: EmailCategory,
  ): Promise<void> {
    this.logger.warn(
      `Email delivery failed (${category.toLowerCase()}): ${message}`,
    );
    await this.prisma.emailDelivery
      .updateMany({
        where: {
          id: deliveryId,
          status: { in: ['PENDING', 'SENDING', 'DELAYED'] },
        },
        data: {
          failedAt: new Date(),
          lastError: message.slice(0, 300),
          status: 'FAILED',
        },
      })
      .catch(() => undefined);
  }

  /**
   * Hard bounces and complaints block every category. An unsubscribe blocks
   * marketing only; transactional mail about the account still has a legal and
   * security reason to arrive.
   */
  private async suppressionFor(
    email: string,
    category: EmailCategory,
    userId: string | null,
  ): Promise<string | null> {
    const blocked = await this.prisma.emailSuppression.findUnique({
      where: { email },
      select: { reason: true },
    });
    if (blocked && (blocked.reason !== 'UNSUBSCRIBED' || category === 'MARKETING')) {
      return blocked.reason;
    }

    if (category !== 'MARKETING') return null;
    if (!userId) return 'NOT_VERIFIED';

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user || user.emailVerifiedAt === null || normalizeEmail(user.email) !== email) {
      return 'NOT_VERIFIED';
    }
    const subscription = await this.prisma.emailSubscription.findUnique({
      where: { userId },
      select: { email: true, status: true },
    });
    if (
      !subscription ||
      subscription.status !== 'SUBSCRIBED' ||
      normalizeEmail(subscription.email) !== email
    ) {
      return 'NOT_SUBSCRIBED';
    }
    return null;
  }
}
