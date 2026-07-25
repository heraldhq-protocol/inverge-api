import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformParamsService } from '../platform-params/platform-params.service';
import {
  MODERATION_CLASSIFIER_PORT,
  ModeratableContent,
  ModerationClassifierPort,
} from '../../ports/moderation/moderation.port';
import { buildBrief, buildReasons, route } from './moderation-routing';

export interface ScreenOptions {
  ideaId?: string;
  submittedById?: string;
  submitterBanned?: boolean; // L1 deterministic gate input (FR-1002)
}

// The moderation harness (FR-1001–1007). Runs a submission through the layers:
//   L1 deterministic gates → L2 AI/stub classification → routing → dual reasons → brief,
// then records an off-chain ModerationCase (NFR-17: no on-chain authority, advisory only).
@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    @Inject(MODERATION_CLASSIFIER_PORT) private readonly classifier: ModerationClassifierPort,
    private readonly prisma: PrismaService,
    private readonly params: PlatformParamsService,
  ) {}

  async screen(content: ModeratableContent, opts: ScreenOptions = {}) {
    const threshold = await this.params.getNumber('moderation.riskThreshold', 0.5);

    // L1 — deterministic gates (Phase 0: submitter-ban check; sanctions/geo/wallet deferred).
    const l1FailureCodes = opts.submitterBanned ? ['L1-SUBMITTER-BANNED'] : [];
    const l1Passed = l1FailureCodes.length === 0;

    // L2 — classification (off-chain flags only).
    const result = await this.classifier.classify(content);
    const flaggedCodes = result.categories
      .filter((c) => c.riskScore >= threshold)
      .map((c) => c.code);

    const routing = route(l1Passed, l1FailureCodes, flaggedCodes);
    const { internalReason, externalReason } = buildReasons(l1FailureCodes, result.categories, flaggedCodes);
    const brief = buildBrief(content.kind, l1Passed, l1FailureCodes, result.categories, routing.decision);

    return this.prisma.moderationCase.create({
      data: {
        kind: content.kind,
        ideaId: opts.ideaId ?? null,
        submittedById: opts.submittedById ?? null,
        decision: routing.decision,
        maxRisk: result.maxRisk,
        categories: result.categories as object,
        reasonCodes: routing.reasonCodes,
        internalReason,
        externalReason,
        brief,
        provider: result.provider,
        policyVersion: result.policyVersion,
      },
    });
  }

  // Best-effort screen for hot paths (e.g. idea publish): records a case, never throws,
  // never blocks the caller. Returns the case or null on failure.
  async screenSafe(content: ModeratableContent, opts: ScreenOptions = {}) {
    try {
      return await this.screen(content, opts);
    } catch (e) {
      this.logger.warn(`Moderation screen failed (non-blocking): ${(e as Error).message}`);
      return null;
    }
  }
}
