export const AI_COMPLETION_PORT = Symbol('AI_COMPLETION_PORT');

/**
 * One structured completion. Callers own prompting and output validation; an
 * adapter only transports text and usage back.
 */
export type AiCompletionInput = {
  system: string;
  user: string;
  maxOutputTokens: number;
  /** Aborts the provider request when the caller's timeout elapses. */
  signal?: AbortSignal;
};

export type AiCompletionOutput = {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export interface AiCompletionPort {
  complete(input: AiCompletionInput): Promise<AiCompletionOutput>;
}

/** The provider is selected but its credentials are missing. */
export class AiNotConfiguredError extends Error {
  constructor(message = 'The AI provider is not configured') {
    super(message);
    this.name = 'AiNotConfiguredError';
  }
}
