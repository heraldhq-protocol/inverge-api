import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformParamsService } from '../platform-params/platform-params.service';
import {
  MODERATION_CLASSIFIER_PORT,
  ModeratableContent,
  ModerationClassifierPort,
} from '../../ports/moderation/moderation.port';
import {
  DUPLICATE_DETECTOR_PORT,
  DuplicateDetectorPort,
} from '../../ports/dedup/dedup.port';
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
    @Inject(DUPLICATE_DETECTOR_PORT) private readonly detector: DuplicateDetectorPort,
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
    const categories = [...result.categories];

    // Near-duplicate detection (FR-1003): a substantially similar existing idea becomes a
    // POL-FRD finding, so the harness holds it for review.
    const dedupThreshold = await this.params.getNumber('moderation.dedupThreshold', 0.8);
    const [match] = await this.detector.findSimilar({ text: content.text, excludeIdeaId: opts.ideaId });
    if (match && match.similarity >= dedupThreshold) {
      categories.push({
        code: 'POL-FRD',
        riskScore: match.similarity,
        excerpt: `Similar to "${match.title}" (${match.ideaId})`,
        draftReason:
          'This idea appears to substantially duplicate an existing one. Make it distinct or explain how it differs.',
      });
    }

    const maxRisk = categories.reduce((m, c) => Math.max(m, c.riskScore), 0);
    const flaggedCodes = categories.filter((c) => c.riskScore >= threshold).map((c) => c.code);

    const routing = route(l1Passed, l1FailureCodes, flaggedCodes);
    const { internalReason, externalReason } = buildReasons(l1FailureCodes, categories, flaggedCodes);
    const brief = buildBrief(content.kind, l1Passed, l1FailureCodes, categories, routing.decision);

    return this.prisma.moderationCase.create({
      data: {
        kind: content.kind,
        ideaId: opts.ideaId ?? null,
        submittedById: opts.submittedById ?? null,
        decision: routing.decision,
        maxRisk: Math.round(maxRisk * 1e4) / 1e4,
        categories: categories as object,
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
