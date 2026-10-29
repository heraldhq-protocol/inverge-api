import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { EmailDeliveryError, EmailMessage, EmailPort } from './email.port';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend adapter (REST, no SDK).
 *
 * Only the status code is surfaced in the thrown error; Resend's response body
 * can contain the recipient and message content and must not reach logs or an
 * API response. A timeout is a delivery failure, not a reason to mark an email
 * verified.
 */
@Injectable()
export class ResendEmailAdapter implements EmailPort {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async send(message: EmailMessage): Promise<void> {
    const apiKey = this.config.get('RESEND_API_KEY', { infer: true });
    const from = this.fromAddress();
    if (!apiKey)
      throw new EmailDeliveryError('Email provider is not configured');

    const replyTo = this.config.get('EMAIL_REPLY_TO', { infer: true });
    const timeoutMs = this.config.get('EMAIL_DELIVERY_TIMEOUT_MS', {
      infer: true,
    });

    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(message.idempotencyKey
            ? { 'Idempotency-Key': message.idempotencyKey }
            : {}),
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new EmailDeliveryError('Email provider request failed');
    }

    if (!response.ok) {
      throw new EmailDeliveryError(
        `Email provider rejected the message (${response.status})`,
        response.status,
      );
    }
  }

  private fromAddress(): string {
    const address = this.config.get('EMAIL_FROM', { infer: true });
    const name = this.config.get('EMAIL_FROM_NAME', { infer: true });
    if (!address)
      throw new EmailDeliveryError('Email sender is not configured');
    return name ? `${name} <${address}>` : address;
  }
}
