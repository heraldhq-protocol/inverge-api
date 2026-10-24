import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { envFlag } from '../../config/feature-flags';
import { AuthModule } from '../auth/auth.module';
import { NotificationDispatchProcessor } from './notification-dispatch.processor';
import { NOTIFICATION_QUEUE } from './notification-dispatch.contract';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

// A BullMQ Worker dials Redis during bootstrap, so the queue is not registered at
// all when queues are disabled (tests, a web-only replica). The service then
// dispatches inline.
const queueEnabled = envFlag('QUEUE_ENABLED');

@Module({
  imports: [
    AuthModule,
    ...(queueEnabled
      ? [BullModule.registerQueue({ name: NOTIFICATION_QUEUE })]
      : []),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    ...(queueEnabled ? [NotificationDispatchProcessor] : []),
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
