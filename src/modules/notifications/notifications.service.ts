import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { logQueueErrors } from '../../common/queue/queue-errors';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  NOTIFICATION_PORT,
  NotificationMessage,
  NotificationPort,
} from '../../ports/notification/notification.port';
import {
  asCursorDate,
  buildPage,
  decodeCursor,
  encodeCursor,
  filterFingerprint,
  keysetCondition,
} from '../../common/http/pagination';
import {
  ListNotificationsQueryDto,
  MarkAllNotificationsReadDto,
  NotificationListDto,
  NotificationReadDto,
  UnreadNotificationCountDto,
} from './dto/notification.dto';
import {
  NOTIFICATION_QUEUE,
  NotificationDispatchJob,
} from './notification-dispatch.contract';

const NOTIFICATION_PAGE_SIZE = 24;
const NOTIFICATION_MAX_PAGE_SIZE = 50;

function asData(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Persist-then-dispatch notifications (FR-702).
 *
 * The row is written first, so a Redis or vendor outage cannot lose the alert:
 * the queue retries delivery against the stored row. When queues are disabled
 * the call dispatches inline and records the failure, but never fails the domain
 * operation that produced the notification. A repeated event with the same
 * `dedupeKey` is a no-op.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_PORT) private readonly port: NotificationPort,
    @Optional()
    @InjectQueue(NOTIFICATION_QUEUE)
    private readonly queue?: Queue<NotificationDispatchJob>,
  ) {
    if (queue) logQueueErrors(queue, this.logger);
  }

  async notify(message: NotificationMessage): Promise<void> {
    let row: { id: string };
    try {
      row = await this.prisma.notification.create({
        data: {
          userId: message.toUserId,
          template: message.template,
          data: message.data as Prisma.InputJsonValue,
          dedupeKey: message.dedupeKey ?? null,
        },
        select: { id: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return;
      }
      // The domain commit is already durable. Losing a notification is worse
      // than losing the response, but not as bad as reporting a failed
      // conversion that actually succeeded.
      this.logger.error(
        `Could not persist ${message.template} notification: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    if (!this.queue) {
      await this.dispatch(row.id).catch((error: unknown) => {
        this.logger.warn(
          `Inline ${message.template} dispatch failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      return;
    }

    try {
      await this.queue.add('dispatch', { notificationId: row.id }, {
        jobId: `notification:${row.id}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 1_000,
        removeOnFail: 1_000,
      });
    } catch (error) {
      // Queue enqueue failed (Redis down). The row is durable; try once inline
      // so a transient queue outage does not delay a time-critical alert.
      this.logger.warn(
        `Could not enqueue ${message.template} notification; dispatching inline: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.dispatch(row.id).catch((inlineError: unknown) => {
        this.logger.warn(
          `Inline ${message.template} dispatch failed: ${
            inlineError instanceof Error ? inlineError.message : String(inlineError)
          }`,
        );
      });
    }
  }

  /**
   * Delivers one persisted row. Throws on vendor failure so a BullMQ worker can
   * retry; a row that was already delivered is a no-op.
   */
  async dispatch(notificationId: string): Promise<void> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: {
        id: true,
        userId: true,
        template: true,
        data: true,
        dispatchedAt: true,
      },
    });
    if (!notification || notification.dispatchedAt) return;

    try {
      await this.port.send({
        toUserId: notification.userId,
        template: notification.template,
        data: asData(notification.data) ?? {},
      });
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          dispatchedAt: new Date(),
          dispatchAttempts: { increment: 1 },
          lastDispatchError: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.notification
        .update({
          where: { id: notification.id },
          data: {
            dispatchAttempts: { increment: 1 },
            lastDispatchError: message.slice(0, 500),
          },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async list(
    userId: string,
    query: ListNotificationsQueryDto,
  ): Promise<NotificationListDto> {
    const limit = Math.min(
      Math.max(query.limit ?? NOTIFICATION_PAGE_SIZE, 1),
      NOTIFICATION_MAX_PAGE_SIZE,
    );
    const fingerprint = filterFingerprint({
      route: 'me.notifications',
      userId,
      unreadOnly: Boolean(query.unreadOnly),
    });
    const cursor = query.cursor
      ? decodeCursor(query.cursor, fingerprint)
      : null;

    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        ...(query.unreadOnly ? { readAt: null } : {}),
        ...(cursor
          ? keysetCondition('createdAt', 'desc', cursor, asCursorDate)
          : {}),
      },
      select: {
        id: true,
        template: true,
        data: true,
        readAt: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = buildPage(rows, limit, (row) =>
      encodeCursor(row.createdAt.toISOString(), row.id, fingerprint),
    );

    return {
      data: page.data.map((row) => ({
        id: row.id,
        template: row.template,
        data: asData(row.data),
        readAt: row.readAt ? row.readAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
      })),
      page: page.page,
    };
  }

  async unreadCount(userId: string): Promise<UnreadNotificationCountDto> {
    const count = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    return { count };
  }

  async markRead(userId: string, id: string): Promise<NotificationReadDto> {
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId },
      select: { id: true, readAt: true },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    if (notification.readAt) {
      return { id, readAt: notification.readAt.toISOString() };
    }

    const readAt = new Date();
    await this.prisma.notification.update({
      where: { id },
      data: { readAt },
    });
    return { id, readAt: readAt.toISOString() };
  }

  async markAllRead(userId: string): Promise<MarkAllNotificationsReadDto> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }
}
