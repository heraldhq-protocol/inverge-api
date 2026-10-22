import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, WebhookProvider } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type WebhookReplayResult = { replayed: true } | { inProgress: true };

export type WebhookInboxInput = {
  provider: WebhookProvider;
  /** Raw bytes as received. Only its SHA-256 is persisted. */
  rawBody: string;
  /**
   * Stable identity for the event. Derived from verified, normalized fields
   * (charge reference + status, session reference + status). Falls back to the
   * payload hash when the caller has nothing better.
   */
  dedupeKey?: string;
  /** Normalized event name. Never raw payload text. */
  eventType?: string;
};

const LOCK_STALE_MS = 5 * 60_000;
const MAX_TEXT = 200;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isIgnored(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { ignored?: unknown }).ignored === true
  );
}

/**
 * One durable receipt per verified provider event (webhooks doc 4).
 *
 * Ordering matters: the provider signature is verified by the caller before this
 * service runs, so an unauthenticated request cannot fill the inbox. The receipt
 * is claimed with a compare-and-set update; concurrent retries observe the claim
 * instead of applying the effect twice. A stale `PROCESSING` row can be reclaimed
 * after five minutes (the worker crashed mid-apply).
 *
 * The raw body is never stored. `payloadHash` supports support/debug correlation
 * without retaining KYC documents, names or account numbers.
 */
@Injectable()
export class WebhookInboxService {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(
    input: WebhookInboxInput,
    apply: () => Promise<T>,
  ): Promise<T | WebhookReplayResult> {
    const payloadHash = sha256(input.rawBody);
    const dedupeKey = (input.dedupeKey ?? payloadHash).slice(0, MAX_TEXT);

    let receipt: { id: string };
    try {
      receipt = await this.prisma.webhookReceipt.create({
        data: {
          provider: input.provider,
          dedupeKey,
          payloadHash,
          eventType: input.eventType?.slice(0, 64) ?? null,
        },
        select: { id: true },
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      ) {
        throw error;
      }
      receipt = await this.prisma.webhookReceipt.findUniqueOrThrow({
        where: {
          provider_dedupeKey: { provider: input.provider, dedupeKey },
        },
        select: { id: true },
      });
    }

    const now = new Date();
    const claimed = await this.prisma.webhookReceipt.updateMany({
      where: {
        id: receipt.id,
        OR: [
          { status: 'PENDING' },
          { status: 'FAILED' },
          {
            status: 'PROCESSING',
            lockedAt: { lt: new Date(now.getTime() - LOCK_STALE_MS) },
          },
          { status: 'PROCESSING', lockedAt: null },
        ],
      },
      data: {
        status: 'PROCESSING',
        lockedAt: now,
        attempts: { increment: 1 },
      },
    });

    if (claimed.count === 0) {
      const current = await this.prisma.webhookReceipt.findUniqueOrThrow({
        where: { id: receipt.id },
        select: { status: true },
      });
      return current.status === 'PROCESSING'
        ? { inProgress: true }
        : { replayed: true };
    }

    try {
      const result = await apply();
      await this.prisma.webhookReceipt.update({
        where: { id: receipt.id },
        data: {
          status: isIgnored(result) ? 'IGNORED' : 'PROCESSED',
          processedAt: new Date(),
          lockedAt: null,
          lastError: null,
        },
      });
      return result;
    } catch (error) {
      await this.prisma.webhookReceipt
        .update({
          where: { id: receipt.id },
          data: {
            status: 'FAILED',
            lockedAt: null,
            lastError: errorMessage(error).slice(0, 500),
          },
        })
        .catch(() => undefined);
      throw error;
    }
  }
}
