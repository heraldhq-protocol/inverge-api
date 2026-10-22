import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { NotificationsService } from './notifications.service';
import {
  NOTIFICATION_QUEUE,
  NotificationDispatchJob,
} from './notification-dispatch.contract';

/**
 * Retries delivery against the persisted row. A vendor failure throws, so
 * BullMQ applies the queue's exponential backoff (five attempts).
 */
@Processor(NOTIFICATION_QUEUE)
export class NotificationDispatchProcessor extends WorkerHost {
  constructor(private readonly notifications: NotificationsService) {
    super();
  }

  process(job: Job<NotificationDispatchJob>) {
    return this.notifications.dispatch(job.data.notificationId);
  }
}
