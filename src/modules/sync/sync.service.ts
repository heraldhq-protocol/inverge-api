import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Idea } from '../../generated/prisma/client';
import { MetricsService } from '../metrics/metrics.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PlatformParamsService } from '../platform-params/platform-params.service';
import { ConvertIdeaDto } from './dto/convert-idea.dto';

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly params: PlatformParamsService,
    private readonly notifications: NotificationsService,
    private readonly metrics: MetricsService,
  ) {}

  // FR-204/205: convert an idea to a DRAFT campaign once the validation gate clears.
  // Lands in DRAFT only — FR-311 application fee + FR-304 curation gate publication (Phase 1).
  async convert(userId: string, ideaId: string, dto: ConvertIdeaDto) {
    const idea = await this.prisma.idea.findUnique({ where: { id: ideaId } });
    if (!idea) throw new NotFoundException('Idea not found');
    if (idea.creatorId !== userId) throw new ForbiddenException('Not your idea');
    if (idea.status === 'CONVERTED') {
      throw new BadRequestException('Idea already converted');
    }
    if (!(await this.meetsValidationThreshold(idea))) {
      throw new ForbiddenException('Idea has not cleared the validation threshold');
    }

    // FR-302: tranche percentages must sum to 100.
    const sum = dto.milestones.reduce((acc, m) => acc + m.tranchePct, 0);
    if (Math.round(sum) !== 100) {
      throw new BadRequestException('Milestone tranche percentages must sum to 100');
    }

    const campaign = await this.prisma.$transaction(async (tx) => {
      const created = await tx.campaign.create({
        data: {
          ideaId: idea.id,
          ideaSnapshot: {
            title: idea.title,
            problem: idea.problem,
            solution: idea.solution,
            roadmap: idea.roadmap,
            askAmount: Number(idea.askAmount),
          },
          creatorId: idea.creatorId,
          type: dto.type,
          tokenType: dto.tokenType,
          targetAmount: dto.targetAmount,
          deadline: new Date(dto.deadline),
          workingCapitalPct: dto.workingCapitalPct ?? 0,
          status: 'DRAFT',
          milestones: {
            create: dto.milestones.map((m, i) => ({
              index: i,
              title: m.title,
              deliverable: m.deliverable,
              tranchePct: m.tranchePct,
              evidenceDefinition: m.evidenceDefinition as object,
            })),
          },
        },
      });
      await tx.idea.update({
        where: { id: idea.id },
        data: { status: 'CONVERTED' },
      });
      return created;
    });

    await this.notifyWaitlist(idea.id, campaign.id); // FR-205
    return campaign;
  }

  // FR-204/204a gate — shape locked; numbers are admin-configurable PlatformParams,
  // read at call time so a change applies to the next conversion attempt. The gate
  // reads the WEIGHTED pre-pledge figure (FR-207), not the raw sum, so inflated or
  // sybil pledges cannot clear it. The required figure is the max of the platform
  // floor and the creator's declared target (FR-204), and it must be SUSTAINED across
  // the validation window (FR-204a), not merely touched.
  async meetsValidationThreshold(idea: Idea, now: Date = new Date()): Promise<boolean> {
    const [minSup, minWeighted, minPct, minFbCount, minFbRating] = await Promise.all([
      this.params.getNumber('validation.minSupporters', 50),
      this.params.getNumber('validation.minWeightedUSD', 2000),
      this.params.getNumber('validation.minPrePledgePctOfAsk', 0.1),
      this.params.getNumber('validation.minFeedbackCount', 10),
      this.params.getNumber('validation.minAvgFeedbackRating', 3),
    ]);

    const weighted = Number(idea.weightedPrePledgeTotal);
    const ask = Number(idea.askAmount);
    const creatorTarget = idea.creatorPrePledgeTarget
      ? Number(idea.creatorPrePledgeTarget)
      : 0;
    // Required weighted interest: platform floor, the pct-of-ask backstop, and the
    // creator's own declared minimum — whichever is highest.
    const requiredWeighted = Math.max(minWeighted, minPct * ask, creatorTarget);

    if (idea.supporterCount < minSup) return false;
    if (weighted < requiredWeighted) return false;
    if (idea.feedbackCount < minFbCount) return false;
    if (Number(idea.feedbackScore) < minFbRating) return false;

    // FR-204a: the figure must have HELD above the bar over the window, not spiked once.
    return this.metrics.isSustained(
      idea.id,
      requiredWeighted,
      weighted,
      idea.validatingSince,
      now,
    );
  }

  private async notifyWaitlist(ideaId: string, campaignId: string) {
    const supporters = await this.prisma.ideaSignal.findMany({
      where: { ideaId, type: 'SUPPORT' },
      select: { userId: true },
    });
    for (const s of supporters) {
      await this.notifications.notify({
        toUserId: s.userId,
        template: 'WAITLIST_CONVERSION',
        data: { ideaId, campaignId },
      });
    }
  }
}
