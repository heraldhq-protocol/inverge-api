import { Injectable, Logger } from '@nestjs/common';
import { NotificationMessage, NotificationPort } from './notification.port';

// Offline dev adapter — logs instead of dispatching.
@Injectable()
export class StubNotificationAdapter implements NotificationPort {
  private readonly logger = new Logger('Notifications');

  async send(message: NotificationMessage): Promise<void> {
    this.logger.log(
      `[stub] ${message.template} -> user:${message.toUserId} ${JSON.stringify(message.data)}`,
    );
  }
}
