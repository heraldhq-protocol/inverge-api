import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookInboxService } from '../../common/webhooks/webhook-inbox.service';
import { normalizeEmail } from '../auth/email/email-normalization';
import { EmailSuppressionService } from './email-suppression.service';
import {
  ResendDeliveryEvent,
  nextDeliveryStatus,
  parseResendWebhook,
  verifyResendWebhook,
} from './resend-webhook';

@Injectable()
export class EmailWebhookService {
  private readonly logger = new Logger(EmailWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly inbox: WebhookInboxService,
    private readonly suppression: EmailSuppressionService,
  ) {}

  async handle(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ) {
    const verdict = verifyResendWebhook({
      rawBody,
      headers,
      secret: this.config.get('RESEND_WEBHOOK_SECRET', { infer: true }),
    });
    if (!verdict.ok) {
      // The reason is a fixed enum, never a secret or a signature value.
      throw new BadRequestException({
        code: 'EMAIL_WEBHOOK_SIGNATURE_INVALID',
        message: 'The webhook signature could not be verified.',
        reason: verdict.reason,
      });
    }

    const event = parseResendWebhook(rawBody);
    if (!event) {
      throw new BadRequestException({
        code: 'EMAIL_WEBHOOK_MALFORMED',
        message: 'The webhook payload is not a Resend event.',
      });
    }

    const result = await this.inbox.run(
      {
        dedupeKey: `RESEND:${verdict.eventId}`,
        eventType: event.rawType,
        provider: 'RESEND',
        rawBody,
      },
      () => this.apply(event),
    );

    return {
      ...(typeof result === 'object' && result !== null ? result : {}),
      received: true,
    };
  }

  private async apply(event: ResendDeliveryEvent) {
    if (event.event === 'IGNORED') {
      return { ignored: true, reason: 'unsupported_event' };
    }

    const delivery = await this.findDelivery(event);

    // A permanent bounce or complaint suppresses the address even when the
    // delivery row predates tracking (or was pruned).
    const recipient =
      normalizeEmail(event.recipient) ??
      (delivery ? normalizeEmail(delivery.recipient) : null);
    if (event.event === 'BOUNCED' && event.hardBounce && recipient) {
      await this.suppression.block(recipient, 'HARD_BOUNCE', 'RESEND');
    }
    if (event.event === 'COMPLAINED' && recipient) {
      await this.suppression.block(recipient, 'COMPLAINT', 'RESEND');
    }

    if (!delivery) {
      this.logger.log(
        `Resend ${event.rawType} for an unknown delivery (${event.providerMessageId ?? 'no id'})`,
      );
      return { ignored: true, reason: 'unknown_delivery' };
    }

    const effectiveEvent =
      event.event === 'BOUNCED' && !event.hardBounce ? 'DELAYED' : event.event;
    const next = nextDeliveryStatus(delivery.status, effectiveEvent);
    if (!next) {
      return { deliveryId: delivery.id, ignored: true, reason: 'no_change' };
    }

    await this.prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: next,
        ...(next === 'DELIVERED' ? { deliveredAt: event.occurredAt } : {}),
        ...(next === 'BOUNCED' ? { bouncedAt: event.occurredAt } : {}),
        ...(next === 'COMPLAINED' ? { complainedAt: event.occurredAt } : {}),
        ...(next === 'FAILED' ? { failedAt: event.occurredAt } : {}),
      },
    });

    return { deliveryId: delivery.id, status: next };
  }

  private async findDelivery(event: ResendDeliveryEvent) {
    if (event.providerMessageId) {
      const byProvider = await this.prisma.emailDelivery.findUnique({
        where: { providerMessageId: event.providerMessageId },
        select: { id: true, recipient: true, status: true },
      });
      if (byProvider) return byProvider;
    }
    if (event.deliveryId) {
      return this.prisma.emailDelivery.findUnique({
        where: { id: event.deliveryId },
        select: { id: true, recipient: true, status: true },
      });
    }
    return null;
  }
}
