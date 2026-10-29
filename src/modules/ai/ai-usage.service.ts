import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import type { AiUsageStatus } from '../../generated/prisma/client';

export type AiUsageSnapshot = {
  requestsToday: number;
  tokensToday: number;
  requestsPerDay: number;
  tokensPerDay: number;
};

export type AiUsageRecord = {
  userId: string;
  surface: string;
  action: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: AiUsageStatus;
  requestId: string;
};

export function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * Daily quota and append-only metering. Counts are read from the event table so
 * a restart cannot reset a budget. Prompts, drafts and model output are never
 * stored here.
 */
@Injectable()
export class AiUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  get limits(): { requestsPerDay: number; tokensPerDay: number } {
    return {
      requestsPerDay: this.config.get('AI_DAILY_REQUESTS_PER_USER', {
        infer: true,
      }),
      tokensPerDay: this.config.get('AI_DAILY_TOKENS_PER_USER', {
        infer: true,
      }),
    };
  }

  async snapshot(userId: string, now: Date = new Date()): Promise<AiUsageSnapshot> {
    const since = startOfUtcDay(now);
    const [requests, tokens] = await Promise.all([
      this.prisma.aiUsageEvent.count({
        where: { userId, createdAt: { gte: since } },
      }),
      this.prisma.aiUsageEvent.aggregate({
        where: { userId, createdAt: { gte: since } },
        _sum: { inputTokens: true, outputTokens: true },
      }),
    ]);

    return {
      requestsToday: requests,
      tokensToday:
        (tokens._sum.inputTokens ?? 0) + (tokens._sum.outputTokens ?? 0),
      ...this.limits,
    };
  }

  async assertWithinDailyQuota(userId: string): Promise<void> {
    const usage = await this.snapshot(userId);
    const requestBlocked = usage.requestsToday >= usage.requestsPerDay;
    const tokenBlocked = usage.tokensToday >= usage.tokensPerDay;
    if (!requestBlocked && !tokenBlocked) return;

    throw new HttpException(
      {
        code: 'AI_QUOTA_EXCEEDED',
        message: tokenBlocked
          ? 'Your daily AI token allowance is used up. Try again tomorrow.'
          : 'Your daily AI request allowance is used up. Try again tomorrow.',
        details: {
          requestsToday: usage.requestsToday,
          requestsPerDay: usage.requestsPerDay,
          tokensToday: usage.tokensToday,
          tokensPerDay: usage.tokensPerDay,
        },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  async record(event: AiUsageRecord): Promise<void> {
    await this.prisma.aiUsageEvent.create({
      data: {
        userId: event.userId,
        surface: event.surface,
        action: event.action,
        model: event.model,
        promptVersion: event.promptVersion,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        latencyMs: event.latencyMs,
        status: event.status,
        requestId: event.requestId,
      },
    });
  }
}
