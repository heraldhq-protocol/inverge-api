import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(NotificationDispatchProcessor.name);

  constructor(private readonly notifications: NotificationsService) {
    super();
  }

  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.warn(
      `Notification worker is unavailable (${error.message}); ` +
        'persisted notifications stay queued for retry.',
    );
  }

  process(job: Job<NotificationDispatchJob>) {
    return this.notifications.dispatch(job.data.notificationId);
  }
}
