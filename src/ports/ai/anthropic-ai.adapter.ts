import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { Env } from '../../config/env.validation';
import {
  AiCompletionInput,
  AiCompletionOutput,
  AiCompletionPort,
  AiNotConfiguredError,
} from './ai-completion.port';

/**
 * Anthropic-compatible transport used by the creator assistant. AI_BASE_URL may
 * point at DeepSeek (the repository's configured endpoint), so the request stays
 * on the plain Messages API: no Claude-only parameters. The assistant reads only
 * AI_* credentials; ANTHROPIC_* belongs to the moderation adapter.
 *
 * The adapter never logs or returns the prompt; callers get text plus token counts.
 */
@Injectable()
export class AnthropicAiAdapter implements AiCompletionPort {
  private readonly logger = new Logger(AnthropicAiAdapter.name);
  private client: Anthropic | null = null;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string | undefined;

  constructor(config: ConfigService<Env, true>) {
    const read = (key: keyof Env): string | undefined => {
      const value = config.get(key, { infer: true });
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };

    this.model = read('AI_MODEL') ?? 'deepseek-flash';
    this.apiKey = read('AI_API_KEY');
    this.baseUrl = read('AI_BASE_URL');
  }

  private get anthropic(): Anthropic {
    if (!this.client) {
      if (!this.apiKey) {
        throw new AiNotConfiguredError('AI_API_KEY is not configured');
      }
      this.client = new Anthropic({
        apiKey: this.apiKey,
        ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
      });
    }
    return this.client;
  }

  async complete(input: AiCompletionInput): Promise<AiCompletionOutput> {
    try {
      const response = await this.anthropic.messages.create(
        {
          model: this.model,
          max_tokens: input.maxOutputTokens,
          system: input.system,
          messages: [{ role: 'user', content: input.user }],
        },
        input.signal ? { signal: input.signal } : undefined,
      );

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      return {
        text,
        model: this.model,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };
    } catch (error) {
      // The caller maps this to a 502/504. Log the shape only, never the prompt.
      this.logger.warn(
        `AI provider call failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      throw error;
    }
  }
}
