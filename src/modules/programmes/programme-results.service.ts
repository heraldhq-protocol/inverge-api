import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  isPrizeAdvertisable,
  readRubric,
  scoringConfigurationFrom,
} from './programme-config';
import {
  rankEntries,
  standingsChecksum,
  type RankableEntry,
  type RankingResult,
} from './programme-scoring';

const RANKED_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'SHORTLISTED',
  'ACCEPTED',
] as const;

type ResultsProgramme = Prisma.ProgrammeGetPayload<{
  include: {
    prizes: true;
    entries: {
      include: {
        idea: { select: { supporterCount: true } };
        evaluations: {
          select: {
            judgeId: true;
            status: true;
            scores: true;
            participantFeedback: true;
          };
        };
        judgeConflicts: { select: { judge: { select: { judgeId: true } } } };
      };
    };
  };
}>;

export type ComputedStandings = {
  result: RankingResult;
  checksum: string;
  standings: Record<string, unknown>[];
};

function asScores(value: Prisma.JsonValue): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
}

@Injectable()
export class ProgrammeResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Recomputes the standings from stored snapshots. Nothing is cached here: a
   * published result is the same pure function applied to the same inputs, and
   * its checksum proves it.
   */
  async compute(programmeId: string): Promise<ComputedStandings> {
    const programme = await this.load(programmeId);
    const config = scoringConfigurationFrom(programme);

    const entries: RankableEntry[] = programme.entries.map((entry) => {
      const conflicted = new Set(entry.judgeConflicts.map((row) => row.judge.judgeId));
      return {
        id: entry.id,
        title: entry.title,
        submittedAt: entry.submittedAt ?? entry.createdAt,
        curatedRank: entry.curatedRank,
        communitySupporters: entry.idea.supporterCount,
        evaluations: entry.evaluations
          .filter((evaluation) => !conflicted.has(evaluation.judgeId))
          .map((evaluation) => ({
            judgeId: evaluation.judgeId,
            status: evaluation.status,
            scores: asScores(evaluation.scores),
          })),
      };
    });

    const result = rankEntries(entries, config);
    const checksum = createHash('sha256')
      .update(standingsChecksum(result))
      .digest('hex');

    const feedbackByEntry = new Map<string, string[]>();
    for (const entry of programme.entries) {
      const conflicted = new Set(entry.judgeConflicts.map((row) => row.judge.judgeId));
      feedbackByEntry.set(
        entry.id,
        entry.evaluations
          .filter(
            (evaluation) =>
              evaluation.status === 'SUBMITTED' &&
              !conflicted.has(evaluation.judgeId) &&
              typeof evaluation.participantFeedback === 'string' &&
              evaluation.participantFeedback.trim().length > 0,
          )
          .map((evaluation) => evaluation.participantFeedback!.trim()),
      );
    }

    const all = [...result.ranked, ...result.unranked];
    all.sort((left, right) => {
      const leftRank = left.rank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = right.rank ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.entry.id.localeCompare(right.entry.id);
    });

    const standings = all.map((entry) => ({
      entryId: entry.entry.id,
      title: entry.entry.title,
      rank: entry.rank,
      officialScore: entry.officialScore,
      judgeScore: entry.judgeScore,
      communityScore: entry.communityScore,
      communitySupporters: entry.entry.communitySupporters,
      completedEvaluations: entry.completedEvaluations,
      incompleteReason: entry.incompleteReason,
      disqualified: entry.disqualified,
      participantFeedback: feedbackByEntry.get(entry.entry.id) ?? [],
    }));

    return { result, checksum, standings };
  }

  async preview(programmeId: string) {
    const programme = await this.load(programmeId);
    const computed = await this.compute(programmeId);
    return {
      programmeId,
      status: programme.status,
      resultsVisibility: programme.resultsVisibility,
      checksum: computed.checksum,
      methodology: computed.result.methodology,
      communityScaleMax: computed.result.communityScaleMax,
      rankedCount: computed.result.ranked.length,
      unrankedCount: computed.result.unranked.length,
      excluded: computed.result.unranked.map((entry) => ({
        entryId: entry.entry.id,
        title: entry.entry.title,
        reason: entry.incompleteReason,
      })),
      standings: computed.standings,
    };
  }

  async publish(
    adminId: string,
    programmeId: string,
    notes?: string,
    visibility: 'PROVISIONAL' | 'PUBLIC' = 'PUBLIC',
  ) {
    const programme = await this.load(programmeId);
    if (!['JUDGING', 'RESULTS_REVIEW'].includes(programme.status)) {
      throw new ConflictException({
        code: 'RESULTS_NOT_READY',
        message:
          'Move the programme into judging or results review before publishing results.',
      });
    }
    if (
      (programme.judgingMethod === 'JUDGES' || programme.judgingMethod === 'HYBRID') &&
      readRubric(programme.rubric).length === 0
    ) {
      throw new BadRequestException({
        code: 'RUBRIC_REQUIRED',
        message: 'A judged programme needs a published rubric before results can be published.',
      });
    }

    const computed = await this.compute(programmeId);

    const publication = await this.prisma.$transaction(async (tx) => {
      // Two organisers publishing at once must not fight over the same
      // revision number. The lock is scoped to this programme's results.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`programme-results:${programmeId}`}))`;

      const latest = await tx.programmeResultPublication.findFirst({
        where: { programmeId },
        orderBy: { revision: 'desc' },
        select: { revision: true },
      });
      const revision = (latest?.revision ?? 0) + 1;

      const created = await tx.programmeResultPublication.create({
        data: {
          programmeId,
          revision,
          standings: computed.standings as Prisma.InputJsonValue,
          methodology: computed.result.methodology as unknown as Prisma.InputJsonValue,
          checksum: computed.checksum,
          publishedBy: adminId,
          notes: notes ?? null,
        },
      });

      await tx.programme.update({
        where: { id: programmeId },
        data: {
          resultsVisibility: visibility,
          status: visibility === 'PUBLIC' ? 'COMPLETED' : 'RESULTS_REVIEW',
          publishedAt: programme.publishedAt ?? new Date(),
          version: { increment: 1 },
        },
      });

      await tx.programmeAuditEvent.create({
        data: {
          programmeId,
          actorId: adminId,
          action: visibility === 'PUBLIC' ? 'results.published' : 'results.provisional',
          after: {
            revision,
            checksum: computed.checksum,
            ranked: computed.result.ranked.length,
            unranked: computed.result.unranked.length,
          },
        },
      });

      return created;
    });

    const ranked = computed.result.ranked;
    if (visibility === 'PUBLIC') {
      await Promise.all(
        ranked.map((entry) => {
          const standing = computed.standings.find(
            (row) => row.entryId === entry.entry.id,
          );
          return this.notifications
            .notify({
              toUserId: this.participantOf(programme, entry.entry.id),
              template: 'PROGRAMME_RESULTS_PUBLISHED',
              data: {
                programmeTitle: programme.title,
                programmeSlug: programme.slug,
                rank: entry.rank === null ? null : String(entry.rank),
                officialScore:
                  entry.officialScore === null ? null : String(entry.officialScore),
                feedback: Array.isArray(standing?.participantFeedback)
                  ? (standing.participantFeedback as string[]).join(' · ')
                  : null,
              },
              dedupeKey: `programme:${programmeId}:results:${publication.revision}:entry:${entry.entry.id}`,
            })
            .catch(() => undefined);
        }),
      );

      const winners = ranked.slice(0, 3);
      await Promise.all(
        winners.map((entry) =>
          this.notifications
            .notify({
              toUserId: this.participantOf(programme, entry.entry.id),
              template: 'PROGRAMME_WINNER',
              data: {
                programmeTitle: programme.title,
                programmeSlug: programme.slug,
                rank: entry.rank === null ? null : String(entry.rank),
                prize: programme.prizes.find(
                  (prize) =>
                    prize.placement === entry.rank && isPrizeAdvertisable(prize),
                )?.title,
              },
              dedupeKey: `programme:${programmeId}:winner:${publication.revision}:${entry.entry.id}`,
            })
            .catch(() => undefined),
        ),
      );
    }

    return {
      id: publication.id,
      revision: publication.revision,
      checksum: publication.checksum,
      publishedAt: publication.publishedAt.toISOString(),
      visibility,
      rankedCount: ranked.length,
      unrankedCount: computed.result.unranked.length,
      methodology: computed.result.methodology,
      standings: computed.standings,
    };
  }

  async unpublish(adminId: string, programmeId: string) {
    const programme = await this.prisma.programme.findUnique({
      where: { id: programmeId },
      select: { id: true, resultsVisibility: true },
    });
    if (!programme) {
      throw new NotFoundException({
        code: 'PROGRAMME_NOT_FOUND',
        message: 'That programme does not exist.',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.programme.update({
        where: { id: programmeId },
        data: { resultsVisibility: 'HIDDEN', version: { increment: 1 } },
      });
      await tx.programmeAuditEvent.create({
        data: {
          programmeId,
          actorId: adminId,
          action: 'results.unpublished',
          before: { resultsVisibility: programme.resultsVisibility },
          after: { resultsVisibility: 'HIDDEN' },
        },
      });
    });

    return { resultsVisibility: 'HIDDEN' as const };
  }

  async getPublished(programmeId: string) {
    return this.prisma.programmeResultPublication.findFirst({
      where: { programmeId },
      orderBy: { revision: 'desc' },
    });
  }

  /** Aggregate-only sponsor/organiser report (FR-1212/1213). */
  async aggregateReport(programmeId: string) {
    const programme = await this.prisma.programme.findUnique({
      where: { id: programmeId },
      select: {
        id: true,
        title: true,
        slug: true,
        status: true,
        _count: { select: { registrations: true, entries: true } },
      },
    });
    if (!programme) {
      throw new NotFoundException({
        code: 'PROGRAMME_NOT_FOUND',
        message: 'That programme does not exist.',
      });
    }

    const [submitted, shortlisted, entryIdeas, repeatParticipants] =
      await Promise.all([
        this.prisma.programmeEntry.count({
          where: { programmeId, status: { in: [...RANKED_STATUSES] } },
        }),
        this.prisma.programmeEntry.count({
          where: { programmeId, status: { in: ['SHORTLISTED', 'ACCEPTED'] } },
        }),
        this.prisma.programmeEntry.findMany({
          where: { programmeId, status: { in: [...RANKED_STATUSES] } },
          select: { ideaId: true, idea: { select: { feedbackCount: true } } },
        }),
        this.prisma.programmeRegistration.groupBy({
          by: ['userId'],
          where: { programmeId },
          _count: { _all: true },
        }),
      ]);

    const ideaIds = entryIdeas.map((row) => row.ideaId);
    const supporters = await this.prisma.ideaSignal.findMany({
      where: { ideaId: { in: ideaIds }, type: 'SUPPORT' },
      select: { userId: true },
      distinct: ['userId'],
    });
    const feedbackTotal = entryIdeas.reduce(
      (sum, row) => sum + row.idea.feedbackCount,
      0,
    );

    return {
      programmeId: programme.id,
      title: programme.title,
      slug: programme.slug,
      status: programme.status,
      registeredParticipants: programme._count.registrations,
      eligibleSubmissions: submitted,
      completionRate:
        programme._count.entries === 0
          ? 0
          : Math.round((submitted / programme._count.entries) * 10000) / 100,
      shortlistedIdeas: shortlisted,
      uniqueSupporters: supporters.length,
      feedbackResponses: feedbackTotal,
      repeatParticipants: repeatParticipants.filter((row) => row._count._all > 1).length,
      personalDataIncluded: false,
    };
  }

  private participantOf(programme: ResultsProgramme, entryId: string): string {
    const entry = programme.entries.find((row) => row.id === entryId);
    if (!entry) {
      throw new NotFoundException({
        code: 'ENTRY_NOT_FOUND',
        message: 'That entry does not exist.',
      });
    }
    return entry.participantId;
  }

  private async load(programmeId: string): Promise<ResultsProgramme> {
    const programme = await this.prisma.programme.findUnique({
      where: { id: programmeId },
      include: {
        prizes: { orderBy: { placement: 'asc' } },
        entries: {
          where: {
            status: { in: [...RANKED_STATUSES] },
            submittedAt: { not: null },
          },
          include: {
            idea: { select: { supporterCount: true } },
            evaluations: {
              select: {
                judgeId: true,
                status: true,
                scores: true,
                participantFeedback: true,
              },
            },
            judgeConflicts: { select: { judge: { select: { judgeId: true } } } },
          },
        },
      },
    });
    if (!programme) {
      throw new NotFoundException({
        code: 'PROGRAMME_NOT_FOUND',
        message: 'That programme does not exist.',
      });
    }
    return programme;
  }
}
