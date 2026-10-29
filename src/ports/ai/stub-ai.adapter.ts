import { Injectable } from '@nestjs/common';
import {
  AiCompletionInput,
  AiCompletionOutput,
  AiCompletionPort,
} from './ai-completion.port';

/**
 * Offline, deterministic adapter for development and automated tests.
 *
 * It is not a fallback: production rejects AI_PROVIDER=stub at boot, and the
 * output says plainly that no model was called. That keeps a local demo from
 * being mistaken for a real suggestion.
 */
@Injectable()
export class StubAiAdapter implements AiCompletionPort {
  async complete(input: AiCompletionInput): Promise<AiCompletionOutput> {
    const text = JSON.stringify({
      proposal:
        'Offline stub suggestion. Set AI_PROVIDER=anthropic to run a real model.',
      notes: ['No model was called; this response comes from the stub adapter.'],
      assumptions: [],
    });

    return {
      text,
      model: 'stub',
      inputTokens: Math.ceil(input.user.length / 4),
      outputTokens: Math.ceil(text.length / 4),
    };
  }
}
