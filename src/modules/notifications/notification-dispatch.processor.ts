import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { NotificationsService } from './notifications.service';
import type { NotificationDispatchJob } from './notification-dispatch.contract';

/**
 * Retries delivery against the persisted row. A vendor failure throws, so the
 * job's exponential backoff (five attempts) applies. `JobsProcessor` owns the
 * only Worker; this class is the handler behind one job name.
 */
@Injectable()
export class NotificationDispatchProcessor {
  constructor(private readonly notifications: NotificationsService) {}

  process(job: Job<NotificationDispatchJob>) {
    return this.notifications.dispatch(job.data.notificationId);
  }
}
