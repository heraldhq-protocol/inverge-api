import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DeclareJudgeConflictDto,
  SaveEvaluationDto,
  SubmitEvaluationDto,
} from './dto/programme.dto';
import { readRubric } from './programme-config';
import { weightedJudgeScore, type RubricCriterion } from './programme-scoring';
import {
  judgeEntryInclude,
  projectJudgeEntry,
  type JudgeEntry,
} from './programme-projections';

const JUDGEABLE_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'SHORTLISTED',
  'ACCEPTED',
] as const;

function asScores(value: Prisma.JsonValue): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
}

function scoreIssues(
  scores: Record<string, number>,
  rubric: readonly RubricCriterion[],
): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = [];
  for (const criterion of rubric) {
    const value = scores[criterion.id];
    if (value === undefined) {
      if (criterion.required !== false) {
        issues.push({
          field: `scores.${criterion.id}`,
          message: `Score "${criterion.label}" before submitting.`,
        });
      }
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({
        field: `scores.${criterion.id}`,
        message: `"${criterion.label}" must be a number.`,
      });
    } else if (value < criterion.minScore || value > criterion.maxScore) {
      issues.push({
        field: `scores.${criterion.id}`,
        message: `"${criterion.label}" must be between ${criterion.minScore} and ${criterion.maxScore}.`,
      });
    }
  }
  const unknown = Object.keys(scores).filter(
    (id) => !rubric.some((criterion) => criterion.id === id),
  );
  for (const id of unknown) {
    issues.push({
      field: `scores.${id}`,
      message: 'Unknown rubric criterion.',
    });
  }
  return issues;
}

@Injectable()
export class ProgrammeJudgingService {
  constructor(private readonly prisma: PrismaService) {}

  async listProgrammes(judgeId: string) {
    const assignments = await this.prisma.programmeJudge.findMany({
      where: { judgeId, status: 'ACTIVE' },
      include: {
        programme: {
          select: {
            id: true,
            slug: true,
            title: true,
            status: true,
            judgingMethod: true,
            judgingStartsAt: true,
            judgingEndsAt: true,
            resultsAt: true,
            rubric: true,
            minimumEvaluations: true,
            _count: {
              select: {
                entries: {
                  where: { status: { in: [...JUDGEABLE_STATUSES] } },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return assignments.map((assignment) => ({
      assignmentId: assignment.id,
      programmeId: assignment.programme.id,
      slug: assignment.programme.slug,
      title: assignment.programme.title,
      status: assignment.programme.status,
      judgingMethod: assignment.programme.judgingMethod,
      judgingStartsAt: assignment.programme.judgingStartsAt.toISOString(),
      judgingEndsAt: assignment.programme.judgingEndsAt.toISOString(),
      resultsAt: assignment.programme.resultsAt.toISOString(),
      entryCount: assignment.programme._count.entries,
      criteria: readRubric(assignment.programme.rubric).length,
      minimumEvaluations: assignment.programme.minimumEvaluations,
      conflictDeclaration: assignment.conflictDeclaration,
    }));
  }

  async getWorkspace(judge: User, programmeId: string) {
    const assignment = await this.requireAssignment(judge.id, programmeId);
    const entries = await this.prisma.programmeEntry.findMany({
      where: {
        programmeId,
        status: { in: [...JUDGEABLE_STATUSES] },
        submittedAt: { not: null },
      },
      include: judgeEntryInclude,
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
    });

    const evaluations = await this.prisma.programmeEvaluation.findMany({
      where: { programmeId, judgeId: judge.id },
      select: { entryId: true, status: true, revision: true },
    });
    const evaluated = new Map(evaluations.map((row) => [row.entryId, row]));

    const queue = entries.map((entry) => {
      const row = evaluated.get(entry.id);
      return {
        id: entry.id,
        title: entry.title,
        category: entry.category,
        submittedAt: entry.submittedAt?.toISOString() ?? null,
        conflict: entry.judgeConflicts.some((conflict) => conflict.judge.judgeId === judge.id),
        evaluationStatus: row?.status ?? null,
        revision: row?.revision ?? null,
      };
    });

    return {
      assignment: {
        id: assignment.id,
        status: assignment.status,
        conflictDeclaration: assignment.conflictDeclaration,
      },
      programme: {
        id: programmeId,
        title: assignment.programme.title,
        status: assignment.programme.status,
        judgingMethod: assignment.programme.judgingMethod,
        rubric: readRubric(assignment.programme.rubric),
        minimumEvaluations: assignment.programme.minimumEvaluations,
      },
      progress: {
        total: queue.filter((row) => !row.conflict).length,
        submitted: queue.filter((row) => row.evaluationStatus === 'SUBMITTED').length,
        drafts: queue.filter((row) => row.evaluationStatus === 'DRAFT').length,
        conflicts: queue.filter((row) => row.conflict).length,
      },
      queue,
    };
  }

  async getEntry(judge: User, programmeId: string, entryId: string) {
    const assignment = await this.requireAssignment(judge.id, programmeId);
    const entry = await this.findJudgeableEntry(programmeId, entryId);
    if (entry.judgeConflicts.some((conflict) => conflict.judge.judgeId === judge.id)) {
      throw new ForbiddenException({
        code: 'JUDGE_CONFLICT',
        message: 'You declared a conflict with this entry and cannot score it.',
      });
    }
    return projectJudgeEntry(entry, judge.id);
  }

  async saveEvaluation(
    judge: User,
    programmeId: string,
    entryId: string,
    dto: SaveEvaluationDto,
  ) {
    return this.writeEvaluation(judge, programmeId, entryId, dto, 'DRAFT');
  }

  async submitEvaluation(
    judge: User,
    programmeId: string,
    entryId: string,
    dto: SubmitEvaluationDto,
  ) {
    if (dto.declareNoConflict === false) {
      throw new BadRequestException({
        code: 'CONFLICT_DECLARATION_REQUIRED',
        message:
          'Declare a conflict instead of scoring an entry you are connected to.',
      });
    }
    return this.writeEvaluation(judge, programmeId, entryId, dto, 'SUBMITTED');
  }

  async declareConflict(
    judge: User,
    programmeId: string,
    entryId: string,
    dto: DeclareJudgeConflictDto,
  ) {
    const assignment = await this.requireAssignment(judge.id, programmeId);
    await this.findJudgeableEntry(programmeId, entryId);

    const existing = await this.prisma.programmeJudgeConflict.findUnique({
      where: { judgeId_entryId: { judgeId: assignment.id, entryId } },
    });

    if (!existing) {
      await this.prisma.$transaction(async (tx) => {
        await tx.programmeJudgeConflict.create({
          data: { judgeId: assignment.id, entryId, reason: dto.reason.trim() },
        });
        await tx.programmeAuditEvent.create({
          data: {
            programmeId,
            actorId: judge.id,
            action: 'judge.conflict_declared',
            target: entryId,
            after: { reason: dto.reason.trim() },
          },
        });
      });
    }

    return {
      entryId,
      conflict: true,
      reason: dto.reason.trim(),
    };
  }

  private async writeEvaluation(
    judge: User,
    programmeId: string,
    entryId: string,
    dto: SaveEvaluationDto & { declareNoConflict?: boolean },
    status: 'DRAFT' | 'SUBMITTED',
  ) {
    const assignment = await this.requireAssignment(judge.id, programmeId);
    const programme = assignment.programme;
    if (programme.status !== 'JUDGING') {
      throw new ConflictException({
        code: 'JUDGING_NOT_OPEN',
        message: 'This programme is not in the judging phase.',
      });
    }
    if (
      status === 'SUBMITTED' &&
      programme.requireConflictDeclaration &&
      dto.declareNoConflict !== true
    ) {
      throw new BadRequestException({
        code: 'CONFLICT_DECLARATION_REQUIRED',
        message:
          'Confirm that you have no undisclosed conflict with this entry before submitting.',
      });
    }

    const entry = await this.findJudgeableEntry(programmeId, entryId);
    if (entry.judgeConflicts.some((conflict) => conflict.judge.judgeId === judge.id)) {
      throw new ForbiddenException({
        code: 'JUDGE_CONFLICT',
        message: 'You declared a conflict with this entry and cannot score it.',
      });
    }

    const rubric = readRubric(programme.rubric);
    const scores = dto.scores;
    const issues = scoreIssues(scores, rubric);
    if (status === 'SUBMITTED' && issues.length > 0) {
      throw new BadRequestException({
        code: 'EVALUATION_INCOMPLETE',
        message: 'Complete every required criterion before submitting.',
        issues,
      });
    }

    const weighted = weightedJudgeScore(scores, rubric);
    if (status === 'SUBMITTED' && weighted === null) {
      throw new BadRequestException({
        code: 'EVALUATION_INVALID',
        message: 'The scores cannot produce a valid weighted result.',
        issues,
      });
    }

    const existing = await this.prisma.programmeEvaluation.findUnique({
      where: { entryId_judgeId: { entryId, judgeId: judge.id } },
    });

    if (existing?.status === 'SUBMITTED' && !programme.allowEvaluationRevision) {
      throw new ConflictException({
        code: 'EVALUATION_LOCKED',
        message:
          'This evaluation is submitted and revisions are disabled for this programme.',
      });
    }
    if (existing?.status === 'SUBMITTED' && status === 'DRAFT') {
      throw new ConflictException({
        code: 'EVALUATION_LOCKED',
        message:
          'A submitted evaluation cannot be reverted to a draft. Submit a revised evaluation instead.',
      });
    }

    const now = new Date();
    const evaluation = await this.prisma.$transaction(async (tx) => {
      if (existing) {
        if (existing.status === 'SUBMITTED') {
          await tx.programmeEvaluationRevision.create({
            data: {
              evaluationId: existing.id,
              revision: existing.revision,
              scores: existing.scores as Prisma.InputJsonValue,
              weightedScore: existing.weightedScore,
              privateComment: existing.privateComment,
              participantFeedback: existing.participantFeedback,
              submittedAt: existing.submittedAt,
            },
          });
        }

        return tx.programmeEvaluation.update({
          where: { id: existing.id },
          data: {
            status,
            scores: scores as Prisma.InputJsonValue,
            weightedScore: weighted,
            privateComment: dto.privateComment ?? null,
            participantFeedback: dto.participantFeedback ?? null,
            submittedAt: status === 'SUBMITTED' ? now : existing.submittedAt,
            ...(existing.status === 'SUBMITTED'
              ? { revision: { increment: 1 } }
              : {}),
          },
        });
      }

      return tx.programmeEvaluation.create({
        data: {
          programmeId,
          entryId,
          judgeId: judge.id,
          status,
          scores: scores as Prisma.InputJsonValue,
          weightedScore: weighted,
          privateComment: dto.privateComment ?? null,
          participantFeedback: dto.participantFeedback ?? null,
          submittedAt: status === 'SUBMITTED' ? now : null,
        },
      });
    });

    await this.prisma.programmeAuditEvent.create({
      data: {
        programmeId,
        actorId: judge.id,
        action: status === 'SUBMITTED' ? 'evaluation.submitted' : 'evaluation.saved',
        target: entryId,
        after: {
          evaluationId: evaluation.id,
          revision: evaluation.revision,
          weightedScore: weighted,
        },
      },
    });

    return {
      id: evaluation.id,
      entryId,
      status: evaluation.status,
      scores,
      weightedScore: weighted,
      privateComment: evaluation.privateComment,
      participantFeedback: evaluation.participantFeedback,
      revision: evaluation.revision,
      submittedAt: evaluation.submittedAt?.toISOString() ?? null,
    };
  }

  private async requireAssignment(judgeId: string, programmeId: string) {
    const assignment = await this.prisma.programmeJudge.findUnique({
      where: { programmeId_judgeId: { programmeId, judgeId } },
      include: { programme: true },
    });
    if (!assignment) {
      throw new ForbiddenException({
        code: 'NOT_A_JUDGE',
        message: 'You are not assigned to judge this programme.',
      });
    }
    if (assignment.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'JUDGE_INACTIVE',
        message: 'Your judging assignment is not active.',
      });
    }
    return assignment;
  }

  private async findJudgeableEntry(
    programmeId: string,
    entryId: string,
  ): Promise<JudgeEntry> {
    const entry = await this.prisma.programmeEntry.findFirst({
      where: {
        id: entryId,
        programmeId,
        status: { in: [...JUDGEABLE_STATUSES] },
        submittedAt: { not: null },
      },
      include: judgeEntryInclude,
    });
    if (!entry) {
      throw new NotFoundException({
        code: 'ENTRY_NOT_FOUND',
        message: 'That entry is not available for judging.',
      });
    }
    return entry;
  }
}
