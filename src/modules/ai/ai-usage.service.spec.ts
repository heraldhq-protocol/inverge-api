import { HttpException } from '@nestjs/common';
import { AiUsageService, startOfUtcDay } from './ai-usage.service';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import type { PrismaService } from '../../prisma/prisma.service';

function service(options: {
  requests: number;
  inputTokens?: number;
  outputTokens?: number;
  requestLimit?: number;
  tokenLimit?: number;
}): AiUsageService {
  const prisma = {
    aiUsageEvent: {
      count: jest.fn().mockResolvedValue(options.requests),
      aggregate: jest.fn().mockResolvedValue({
        _sum: {
          inputTokens: options.inputTokens ?? 0,
          outputTokens: options.outputTokens ?? 0,
        },
      }),
      create: jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;

  const limits: Record<string, number> = {
    AI_DAILY_REQUESTS_PER_USER: options.requestLimit ?? 30,
    AI_DAILY_TOKENS_PER_USER: options.tokenLimit ?? 60_000,
  };
  const config = {
    get: (key: string) => limits[key],
  } as unknown as ConfigService<Env, true>;

  return new AiUsageService(prisma, config);
}

describe('startOfUtcDay', () => {
  it('returns midnight UTC for the given instant', () => {
    expect(startOfUtcDay(new Date('2026-10-29T23:59:59.000Z'))).toEqual(
      new Date('2026-10-29T00:00:00.000Z'),
    );
  });
});

describe('AiUsageService.assertWithinDailyQuota', () => {
  it('allows a request below both caps', async () => {
    // #given a creator with 3 requests and 1000 tokens today
    const usage = service({ requests: 3, inputTokens: 600, outputTokens: 400 });

    // #then nothing is thrown
    await expect(usage.assertWithinDailyQuota('user-1')).resolves.toBeUndefined();
  });

  it('rejects when the request cap is reached', async () => {
    // #given the request cap is already spent
    const usage = service({ requests: 30, requestLimit: 30 });

    // #then a 429 with a stable code is raised
    await expect(usage.assertWithinDailyQuota('user-1')).rejects.toMatchObject({
      status: 429,
    });
    try {
      await usage.assertWithinDailyQuota('user-1');
    } catch (error) {
      const response = (error as HttpException).getResponse() as {
        code: string;
      };
      expect(response.code).toBe('AI_QUOTA_EXCEEDED');
    }
  });

  it('rejects when the token cap is reached even below the request cap', async () => {
    // #given few requests but the full token budget spent
    const usage = service({
      requests: 2,
      inputTokens: 30_000,
      outputTokens: 30_000,
      tokenLimit: 60_000,
    });

    // #then the call is refused
    await expect(usage.assertWithinDailyQuota('user-1')).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe('AiUsageService.record', () => {
  it('writes only counts and routing metadata', async () => {
    // #given a completed call
    const prisma = {
      aiUsageEvent: { create: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const config = { get: () => 30 } as unknown as ConfigService<Env, true>;
    const usage = new AiUsageService(prisma, config);

    // #when the event is recorded
    await usage.record({
      userId: 'user-1',
      surface: 'idea',
      action: 'improve',
      model: 'deepseek-v4.1-flash',
      promptVersion: 'idea-assistant.v1',
      inputTokens: 120,
      outputTokens: 80,
      latencyMs: 900,
      status: 'OK',
      requestId: 'req-1',
    });

    // #then the row contains no prompt or output text
    const data = (prisma.aiUsageEvent.create as jest.Mock).mock.calls[0][0].data;
    expect(data).toEqual({
      userId: 'user-1',
      surface: 'idea',
      action: 'improve',
      model: 'deepseek-v4.1-flash',
      promptVersion: 'idea-assistant.v1',
      inputTokens: 120,
      outputTokens: 80,
      latencyMs: 900,
      status: 'OK',
      requestId: 'req-1',
    });
  });
});
