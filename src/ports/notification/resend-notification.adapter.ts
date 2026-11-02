import { Inject, Injectable } from '@nestjs/common';
import { EMAIL_PORT, EmailPort } from '../email/email.port';
import { NotificationMessage, NotificationPort } from './notification.port';
import { renderNotificationEmail } from './notification-email';

/**
 * Notification emails through the same Resend adapter as verification mail.
 *
 * The notification service resolves the recipient address before dispatch. This
 * adapter refuses a message without one instead of guessing an identity.
 */
@Injectable()
export class ResendNotificationAdapter implements NotificationPort {
  constructor(@Inject(EMAIL_PORT) private readonly email: EmailPort) {}

  async send(message: NotificationMessage): Promise<void> {
    if (!message.toEmail) {
      throw new Error('Notification recipient has no email address');
    }
    const content = renderNotificationEmail(message);
    await this.email.send({
      to: message.toEmail,
      subject: content.subject,
      text: content.text,
      html: content.html,
      ...(message.notificationId
        ? { idempotencyKey: `notification/${message.notificationId}` }
        : {}),
    });
  }
}
