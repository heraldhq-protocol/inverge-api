import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformParamsService } from '../platform-params/platform-params.service';
import {
  QUALITY_SCORER_PORT,
  QualityReport,
  QualityScorerPort,
} from '../../ports/quality/quality-scorer.port';

export interface QualityEvaluation extends QualityReport {
  tier: 'LINK_ONLY' | 'DISCOVERABLE' | 'FEATURED';
  floor: number;
}

// FR-271/272: score an idea's pitch, persist the coaching report + score, and (when
// applying) set its discoverability tier from the admin-configured quality floor.
// Scoring is advisory — it never rejects; a below-floor idea just stays LINK_ONLY.
@Injectable()
export class QualityService {
  constructor(
    @Inject(QUALITY_SCORER_PORT) private readonly scorer: QualityScorerPort,
    private readonly prisma: PrismaService,
    private readonly params: PlatformParamsService,
  ) {}

  async evaluate(ideaId: string, applyTier: boolean): Promise<QualityEvaluation> {
    const idea = await this.prisma.idea.findUnique({
      where: { id: ideaId },
      select: {
        title: true, problem: true, solution: true, targetUser: true,
        currentAlternative: true, askBreakdown: true, roadmapSteps: true,
        category: true, discoverabilityTier: true,
      },
    });
    if (!idea) throw new NotFoundException('Idea not found');

    const report = await this.scorer.score(idea);
    const floor = await this.params.getNumber('idea.qualityFloor', 0.7);

    // Editorial FEATURED is never demoted by scoring; otherwise the floor decides.
    let tier = idea.discoverabilityTier as QualityEvaluation['tier'];
    if (applyTier && tier !== 'FEATURED') {
      tier = report.score >= floor ? 'DISCOVERABLE' : 'LINK_ONLY';
    }

    await this.prisma.$transaction([
      this.prisma.ideaQualityReport.create({
        data: { ideaId, score: report.score, checks: report.checks as object },
      }),
      this.prisma.idea.update({
        where: { id: ideaId },
        data: {
          qualityScore: report.score,
          qualityScoredAt: new Date(),
          ...(applyTier ? { discoverabilityTier: tier } : {}),
        },
      }),
    ]);

    return { ...report, tier, floor };
  }

  // Latest coaching report for an idea (FR-271a creator-facing guidance).
  async latestReport(ideaId: string) {
    const report = await this.prisma.ideaQualityReport.findFirst({
      where: { ideaId },
      orderBy: { computedAt: 'desc' },
    });
    if (!report) throw new NotFoundException('No quality report for this idea');
    return report;
  }
}
