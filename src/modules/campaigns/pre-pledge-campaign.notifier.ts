import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import type { NotificationMessage } from '../../ports/notification/notification.port';
import {
  IDEA_CONVERTED_TO_CAMPAIGN,
  type IdeaConvertedToCampaignEvent,
  type PublishedCampaignSnapshot,
} from './pre-pledge-conversion.event';

function firstNameFrom(value: string | null | undefined): string | undefined {
  const first = value?.trim().split(/\s+/)[0] ?? '';
  return first.length > 0 ? first.slice(0, 40) : undefined;
}

function money(value: PublishedCampaignSnapshot['targetAmount']): string | undefined {
  if (!value) return undefined;
  const amount = Number(value.toFixed(2));
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return new Intl.NumberFormat('en-US', {
    currency: 'USD',
    maximumFractionDigits: 2,
    style: 'currency',
  }).format(amount);
}

function dateLabel(value: Date | null): string | undefined {
  if (!value) return undefined;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(value);
}

/**
 * Resolves eligible pre-pledgers and carried-over supporters, then persists one
 * notification row per person inside the campaign-publication transaction.
 *
 * The rows are the durable outbox. A repeated publication event cannot create a
 * second row because the dedupe key is `(campaign, recipient)` unique; a user
 * with no verified email still gets an in-app row, which dispatch marks
 * suppressed instead of pretending the email was sent.
 */
@Injectable()
export class PrePledgeCampaignNotifier {
  private readonly logger = new Logger(PrePledgeCampaignNotifier.name);

  constructor(private readonly notifications: NotificationsService) {}

  async prepare(
    tx: Prisma.TransactionClient,
    event: IdeaConvertedToCampaignEvent,
    campaign: PublishedCampaignSnapshot,
  ): Promise<string[]> {
    if (!campaign.ideaId) return [];

    const idea = await tx.idea.findUnique({
      where: { id: campaign.ideaId },
      select: { title: true },
    });
    const signals = await tx.ideaSignal.findMany({
      where: {
        ideaId: campaign.ideaId,
        user: { bannedAt: null },
        OR: [
          { type: 'PRE_PLEDGE', amountUsd: { gt: 0 } },
          { type: 'SUPPORT' },
        ],
      },
      select: {
        userId: true,
        user: {
          select: {
            creatorProfile: { select: { displayName: true } },
          },
        },
      },
      distinct: ['userId'],
      orderBy: { userId: 'asc' },
    });

    const seen = new Set<string>();
    const messages: NotificationMessage[] = [];
    const cover = campaign.coverImageUrl?.trim();
    const fundingGoal = money(campaign.targetAmount);
    const fundingDeadline = dateLabel(campaign.deadline);

    for (const signal of signals) {
      if (seen.has(signal.userId)) continue;
      seen.add(signal.userId);
      const firstName = firstNameFrom(signal.user.creatorProfile?.displayName);
      messages.push({
        data: {
          campaignId: campaign.id,
          campaignSummary: campaign.summary,
          campaignTitle: campaign.title,
          ...(cover ? { coverImageUrl: cover } : {}),
          ...(firstName ? { firstName } : {}),
          ...(fundingDeadline ? { fundingDeadline } : {}),
          ...(fundingGoal ? { fundingGoal } : {}),
          ideaId: event.ideaId,
          ideaTitle: idea?.title ?? campaign.title,
        },
        dedupeKey: `${IDEA_CONVERTED_TO_CAMPAIGN}:${campaign.id}:${signal.userId}`,
        template: IDEA_CONVERTED_TO_CAMPAIGN,
        toUserId: signal.userId,
      });
    }

    if (messages.length === 0) return [];
    const ids = await this.notifications.createManyInTransaction(tx, messages);
    this.logger.log(
      `campaign=${campaign.id} event=${event.eventId} eligible=${messages.length} created=${ids.length}`,
    );
    return ids;
  }

  /** Enqueue after commit. Never awaited by the publication response path. */
  async dispatch(notificationIds: readonly string[]): Promise<void> {
    await this.notifications.dispatchPersisted(notificationIds);
  }
}
