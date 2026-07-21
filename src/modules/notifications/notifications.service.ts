import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_PORT,
  NotificationMessage,
  NotificationPort,
} from '../../ports/notification/notification.port';

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(NOTIFICATION_PORT) private readonly port: NotificationPort,
  ) {}

  // Phase 0: direct dispatch. TODO(Phase 2): route through the 'notification-dispatch'
  // BullMQ queue so time-critical objection-window alerts get retries + delivery SLAs (FR-702).
  notify(message: NotificationMessage) {
    return this.port.send(message);
  }
}
