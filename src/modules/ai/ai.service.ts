import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  GatewayTimeoutException,
  BadGatewayException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Env } from '../../config/env.validation';
import { TelemetryService } from '../../common/telemetry/telemetry.service';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import {
  AI_COMPLETION_PORT,
  AiCompletionPort,
  AiNotConfiguredError,
} from '../../ports/ai/ai-completion.port';
import { IdeasService } from '../ideas/ideas.service';
import { AiEntitlementService } from './ai-entitlement.service';
import { AiUsageService } from './ai-usage.service';
import {
  IDEA_ASSISTANT_PROMPT_VERSION,
  type IdeaAssistantAction,
} from './ai.constants';
import { IdeaAssistantDto, IdeaAssistantResultDto } from './dto/ai.dto';
import {
  buildIdeaAssistantPrompt,
  sanitizeIdeaContext,
} from './prompts/idea-assistant.prompt';
import { parseIdeaAssistantOutput } from './schemas/idea-assistant.schema';

/**
 * Orchestrates one idea-assistant request. The chain is deliberately linear:
 * configured -> owner -> entitled -> within quota -> size-checked -> provider
 * (timed) -> schema-validated -> metered. A provider result is never written to
 * the idea; the client owns accept/regenerate/discard.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @Inject(AI_COMPLETION_PORT)
    private readonly provider: AiCompletionPort,
    private readonly config: ConfigService<Env, true>,
    private readonly ideas: IdeasService,
    private readonly entitlement: AiEntitlementService,
    private readonly usage: AiUsageService,
    private readonly telemetry: TelemetryService,
  ) {}

  async suggestForIdea(
    user: AuthenticatedUser,
    ideaId: string,
    dto: IdeaAssistantDto,
  ): Promise<IdeaAssistantResultDto> {
    if (!this.entitlement.isConfigured()) {
      throw new ServiceUnavailableException({
        code: 'AI_NOT_CONFIGURED',
        message:
          'The AI assistant is not configured on this deployment. Manual editing still works.',
      });
    }

    await this.ideas.getOwned(user.id, ideaId);

    const access = await this.entitlement.entitlement(user);
    if (!access.premium) {
      throw new ForbiddenException({
        code: 'AI_ENTITLEMENT_REQUIRED',
        message:
          access.requestStatus === 'PENDING'
            ? 'Your AI access request is still under review.'
            : 'The AI assistant requires an approved AI access grant.',
        details: { requestStatus: access.requestStatus },
      });
    }

    const text = dto.text.trim();
    const context = sanitizeIdeaContext(dto.context);
    const maxInputChars = this.config.get('AI_MAX_INPUT_CHARS', { infer: true });
    const totalChars =
      text.length +
      Object.values(context).reduce((sum, value) => sum + value.length, 0);
    if (totalChars > maxInputChars) {
      throw new BadRequestException({
        code: 'AI_INPUT_TOO_LARGE',
        message: `Keep the selected text and context under ${maxInputChars} characters.`,
        details: { totalChars, maxInputChars },
      });
    }

    await this.usage.assertWithinDailyQuota(user.id);

    const prompt = buildIdeaAssistantPrompt({
      action: dto.action,
      target: dto.target,
      text,
      context,
    });
    const maxOutputTokens = this.config.get('AI_MAX_OUTPUT_TOKENS', {
      infer: true,
    });
    const timeoutMs = this.config.get('AI_TIMEOUT_MS', { infer: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const completion = await this.provider.complete({
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;

      const parsed = parseIdeaAssistantOutput(completion.text, dto.action);
      if (!parsed.ok) {
        await this.record(user.id, dto, {
          model: completion.model,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          latencyMs,
          status: 'INVALID_OUTPUT',
          promptVersion: prompt.promptVersion,
        });
        this.telemetry.inc('ai_requests_total', {
          surface: 'idea',
          action: dto.action,
          status: 'INVALID_OUTPUT',
        });
        throw new BadGatewayException({
          code: 'AI_INVALID_OUTPUT',
          message:
            'The assistant returned an unusable response. Nothing was changed; try again.',
        });
      }

      await this.record(user.id, dto, {
        model: completion.model,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        latencyMs,
        status: 'OK',
        promptVersion: prompt.promptVersion,
      });
      this.telemetry.inc('ai_requests_total', {
        surface: 'idea',
        action: dto.action,
        status: 'OK',
      });
      this.telemetry.observe('ai_request_duration_ms', latencyMs, {
        surface: 'idea',
        action: dto.action,
      });

      return {
        suggestionId: randomUUID(),
        action: dto.action,
        target: dto.target,
        baseRevision: dto.baseRevision,
        proposal: parsed.value.proposal,
        notes: parsed.value.notes,
        assumptions: parsed.value.assumptions,
        meta: {
          model: completion.model,
          promptVersion: prompt.promptVersion,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          latencyMs,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;

      const latencyMs = Date.now() - startedAt;
      const timedOut = controller.signal.aborted;
      await this.record(user.id, dto, {
        model: 'unknown',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs,
        status: timedOut ? 'TIMEOUT' : 'PROVIDER_ERROR',
        promptVersion: prompt.promptVersion,
      }).catch(() => undefined);

      if (error instanceof AiNotConfiguredError) {
        throw new ServiceUnavailableException({
          code: 'AI_NOT_CONFIGURED',
          message:
            'The AI provider credentials are missing. Manual editing still works.',
        });
      }

      this.telemetry.inc('ai_requests_total', {
        surface: 'idea',
        action: dto.action,
        status: timedOut ? 'TIMEOUT' : 'PROVIDER_ERROR',
      });

      if (timedOut) {
        throw new GatewayTimeoutException({
          code: 'AI_TIMEOUT',
          message:
            'The assistant took too long. Nothing was changed; try again.',
        });
      }

      throw new BadGatewayException({
        code: 'AI_UNAVAILABLE',
        message:
          'The assistant is temporarily unavailable. Nothing was changed; try again.',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async record(
    userId: string,
    dto: IdeaAssistantDto,
    meta: {
      model: string;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
      status: 'OK' | 'INVALID_OUTPUT' | 'TIMEOUT' | 'PROVIDER_ERROR';
      promptVersion: string;
    },
  ): Promise<void> {
    try {
      await this.usage.record({
        userId,
        surface: 'idea',
        action: dto.action as IdeaAssistantAction,
        model: meta.model,
        promptVersion: meta.promptVersion ?? IDEA_ASSISTANT_PROMPT_VERSION,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        latencyMs: meta.latencyMs,
        status: meta.status,
        requestId: dto.clientRequestId,
      });
    } catch (error) {
      // A metering write must not discard a valid suggestion, but it is loud:
      // the next quota read will undercount until the table catches up.
      this.logger.error(
        `Failed to record AI usage: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }
}
