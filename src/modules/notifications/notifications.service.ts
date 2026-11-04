import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JOBS_QUEUE, JOB_NAMES } from '../../common/queue/job-names';
import { logQueueErrors } from '../../common/queue/queue-errors';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationMessage } from '../../ports/notification/notification.port';
import { EmailDeliveryService } from '../email/email-delivery.service';
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

const NOTIFICATION_PAGE_SIZE = 24;
const NOTIFICATION_MAX_PAGE_SIZE = 50;

function asData(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface NotificationPreferences {
  notifyEmailUpdates: boolean;
  notifyMilestoneReviews: boolean;
  notifyCreatorUpdates: boolean;
  notifyDiscoveryDigest: boolean;
}

/**
 * Which setting governs a template. Mandatory account, security, campaign and
 * compliance mail returns `null`: it is not a marketing preference and cannot be
 * turned off, only suppressed by an unverified address or a provider block.
 */
export function notificationPreferenceFor(
  template: string,
): keyof NotificationPreferences | null {
  if (template.startsWith('MILESTONE_')) return 'notifyMilestoneReviews';
  if (template === 'DISCOVERY_DIGEST') return 'notifyDiscoveryDigest';
  if (template.startsWith('KYC_') || template.startsWith('AML_')) {
    return null;
  }
  if (template.startsWith('PROGRAMME_')) {
    // Programme registration, submission and results are account activity, not
    // marketing. They are subject to email verification, not a marketing opt-out.
    return null;
  }
  // A pre-pledger's one-off update about an idea they supported is part of
  // "Email updates" (important idea/campaign activity), not the creator-update
  // feed they may have opted out of.
  if (template === 'IDEA_CONVERTED_TO_CAMPAIGN') {
    return 'notifyEmailUpdates';
  }
  if (template.startsWith('IDEA_') || template.startsWith('CAMPAIGN_')) {
    return 'notifyCreatorUpdates';
  }
  return 'notifyEmailUpdates';
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
    private readonly emailDelivery: EmailDeliveryService,
    @Optional()
    @InjectQueue(JOBS_QUEUE)
    private readonly queue?: Queue,
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

    await this.schedule(row.id, message.template);
  }

  /**
   * Creates notification rows inside a domain transaction. The caller gets the
   * ids back and schedules them after commit, so a campaign transition and its
   * recipient rows cannot silently diverge. `skipDuplicates` makes a repeated
   * event a no-op.
   */
  async createManyInTransaction(
    tx: Prisma.TransactionClient,
    messages: readonly NotificationMessage[],
  ): Promise<string[]> {
    if (messages.length === 0) return [];
    const rows = await tx.notification.createManyAndReturn({
      data: messages.map((message) => ({
        data: message.data as Prisma.InputJsonValue,
        dedupeKey: message.dedupeKey ?? null,
        template: message.template,
        userId: message.toUserId,
      })),
      select: { id: true },
      skipDuplicates: true,
    });
    return rows.map((row) => row.id);
  }

  /** Schedules already-persisted rows. Safe to call after a crash/restart. */
  async dispatchPersisted(ids: readonly string[]): Promise<void> {
    await Promise.allSettled(ids.map((id) => this.schedule(id)));
  }

  /**
   * Re-schedules rows whose dispatch was lost between commit and enqueue. Only
   * rows with attempts left are considered; a suppressed or delivered row is
   * never retried.
   */
  async sweepUndispatched(limit = 50): Promise<number> {
    const before = new Date(Date.now() - 5 * 60_000);
    const rows = await this.prisma.notification.findMany({
      where: {
        createdAt: { lt: before },
        dispatchAttempts: { lt: 5 },
        dispatchedAt: null,
        suppressedAt: null,
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    await this.dispatchPersisted(rows.map((row) => row.id));
    return rows.length;
  }

  private async schedule(notificationId: string, template = 'notification'): Promise<void> {
    if (!this.queue) {
      await this.dispatch(notificationId).catch((error: unknown) => {
        this.logger.warn(
          `Inline ${template} dispatch failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      return;
    }

    try {
      await this.queue.add(
        JOB_NAMES.notificationDispatch,
        { notificationId },
        {
          jobId: `notification:${notificationId}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: 1_000,
          removeOnFail: 1_000,
        },
      );
    } catch (error) {
      // Queue enqueue failed (Redis down). The row is durable; try once inline
      // so a transient queue outage does not delay a time-critical alert.
      this.logger.warn(
        `Could not enqueue ${template} notification; dispatching inline: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.dispatch(notificationId).catch((inlineError: unknown) => {
        this.logger.warn(
          `Inline ${template} dispatch failed: ${
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
        suppressedAt: true,
        user: {
          select: {
            email: true,
            emailVerifiedAt: true,
            notifyEmailUpdates: true,
            notifyMilestoneReviews: true,
            notifyCreatorUpdates: true,
            notifyDiscoveryDigest: true,
          },
        },
      },
    });
    if (!notification || notification.dispatchedAt || notification.suppressedAt) {
      return;
    }

    const preference = notificationPreferenceFor(notification.template);
    if (
      !notification.user.email ||
      notification.user.emailVerifiedAt === null ||
      (preference !== null && !notification.user[preference])
    ) {
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { suppressedAt: new Date() },
      });
      return;
    }

    try {
      const outcome = await this.emailDelivery.sendNotification({
        toUserId: notification.userId,
        toEmail: notification.user.email,
        notificationId: notification.id,
        template: notification.template,
        data: asData(notification.data) ?? {},
      });

      if (outcome.status === 'suppressed') {
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: {
            dispatchAttempts: { increment: 1 },
            lastDispatchError: outcome.reason.slice(0, 500),
            suppressedAt: new Date(),
          },
        });
        return;
      }
      if (outcome.status === 'exhausted') {
        // The delivery ledger already holds the provider error. Do not claim a
        // send and do not spin the queue on a permanently failed row.
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: {
            dispatchAttempts: { increment: 1 },
            lastDispatchError: 'EMAIL_RETRIES_EXHAUSTED',
          },
        });
        return;
      }

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
