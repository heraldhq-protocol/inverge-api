import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type { ProgrammeEntryStatus } from '../../generated/prisma/client';
import {
  asCursorDate,
  buildPage,
  clampPageSize,
  decodeCursor,
  encodeCursorValues,
  filterFingerprint,
  keysetCondition,
} from '../../common/http/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AdminEntryDecisionDto,
  AssignJudgeDto,
  CreateProgrammeDto,
  CuratedRankDto,
  ListAdminProgrammesQueryDto,
  ProgrammeAnnouncementDto,
  ProgrammeEntryListQueryDto,
  ProgrammePrizeDto,
  ProgrammeSponsorDto,
  UpdateProgrammeDto,
  UpdateProgrammePrizeDto,
  UpdateProgrammeSponsorDto,
  UpdateProgrammeStatusDto,
} from './dto/programme.dto';
import {
  canTransitionProgramme,
  scoringConfigurationFrom,
  validatePrizeFunding,
  validateProgrammeSetup,
  type ProgrammeSetupInput,
} from './programme-config';
import { validateScoringConfiguration } from './programme-scoring';
import {
  adminProgrammeInclude,
  entryWithIdeaInclude,
  projectAdminEntry,
  projectAdminProgramme,
  type AdminProgrammeRecord,
} from './programme-projections';

const OPTIMISTIC_CONFLICT = new ConflictException({
  code: 'VERSION_CONFLICT',
  message:
    'This programme changed since you loaded it. Refresh and apply your change again.',
});

const JUDGING_LOCKED_STATUSES = new Set([
  'JUDGING',
  'RESULTS_REVIEW',
  'COMPLETED',
  'ARCHIVED',
]);

const SCORING_FIELDS = [
  'judgingMethod',
  'communityWeight',
  'judgeWeight',
  'rubric',
  'minimumEvaluations',
  'missingEvaluationPolicy',
  'tieBreak',
] as const;

function setupFrom(
  programme: AdminProgrammeRecord,
): ProgrammeSetupInput {
  return {
    status: programme.status,
    type: programme.type,
    title: programme.title,
    tagline: programme.tagline,
    slug: programme.slug,
    registrationOpensAt: programme.registrationOpensAt,
    registrationClosesAt: programme.registrationClosesAt,
    submissionOpensAt: programme.submissionOpensAt,
    submissionClosesAt: programme.submissionClosesAt,
    judgingStartsAt: programme.judgingStartsAt,
    judgingEndsAt: programme.judgingEndsAt,
    resultsAt: programme.resultsAt,
    entryMode: programme.entryMode,
    allowedCategories: programme.allowedCategories,
    allowMultipleEntries: programme.allowMultipleEntries,
    maxEntriesPerParticipant: programme.maxEntriesPerParticipant,
    allowTeams: programme.allowTeams,
    teamMinSize: programme.teamMinSize,
    teamMaxSize: programme.teamMaxSize,
    minQualityScore: programme.minQualityScore,
    judgingMethod: programme.judgingMethod,
    communityWeight: programme.communityWeight,
    judgeWeight: programme.judgeWeight,
    rubric: programme.rubric,
    minimumEvaluations: programme.minimumEvaluations,
    missingEvaluationPolicy: programme.missingEvaluationPolicy,
    tieBreak: programme.tieBreak,
    prizes: programme.prizes.map((prize) => ({
      kind: prize.kind,
      amountAtomic: prize.amountAtomic,
      fundingStatus: prize.fundingStatus,
    })),
  };
}

function assertSetup(issues: ReturnType<typeof validateProgrammeSetup>): void {
  if (issues.length > 0) {
    throw new BadRequestException({
      code: 'PROGRAMME_INVALID',
      message: 'Fix the programme rules before saving.',
      issues,
    });
  }
}

function datesFromDto(dto: {
  registrationOpensAt: string;
  registrationClosesAt: string;
  submissionOpensAt: string;
  submissionClosesAt: string;
  judgingStartsAt: string;
  judgingEndsAt: string;
  resultsAt: string;
}) {
  return {
    registrationOpensAt: new Date(dto.registrationOpensAt),
    registrationClosesAt: new Date(dto.registrationClosesAt),
    submissionOpensAt: new Date(dto.submissionOpensAt),
    submissionClosesAt: new Date(dto.submissionClosesAt),
    judgingStartsAt: new Date(dto.judgingStartsAt),
    judgingEndsAt: new Date(dto.judgingEndsAt),
    resultsAt: new Date(dto.resultsAt),
  };
}

@Injectable()
export class AdminProgrammesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(query: ListAdminProgrammesQueryDto) {
    const limit = clampPageSize(query.limit);
    const fingerprint = filterFingerprint({
      type: query.type ?? null,
      status: query.status ?? null,
      category: query.category ?? null,
      includeUnpublished: query.includeUnpublished ?? false,
      sort: 'createdAt_desc',
    });

    const where: Prisma.ProgrammeWhereInput = {
      ...(query.includeUnpublished ? {} : { status: { not: 'DRAFT' } }),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
    };

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor, fingerprint);
      where.AND = [keysetCondition('createdAt', 'desc', cursor, asCursorDate)];
    }

    const rows = await this.prisma.programme.findMany({
      where,
      include: adminProgrammeInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = buildPage(rows, limit, (row) =>
      encodeCursorValues([row.createdAt.toISOString()], row.id, fingerprint),
    );

    return {
      data: page.data.map(projectAdminProgramme),
      page: page.page,
    };
  }

  async get(id: string) {
    const programme = await this.find(id);
    return projectAdminProgramme(programme);
  }

  async create(adminId: string, dto: CreateProgrammeDto) {
    const dates = datesFromDto(dto);
    const setup: ProgrammeSetupInput = {
      status: 'DRAFT',
      type: dto.type,
      title: dto.title,
      tagline: dto.tagline,
      slug: dto.slug,
      ...dates,
      entryMode: dto.entryMode ?? 'NEW_OR_EXISTING',
      allowedCategories: dto.allowedCategories ?? [],
      allowMultipleEntries: dto.allowMultipleEntries ?? false,
      maxEntriesPerParticipant: dto.maxEntriesPerParticipant ?? 1,
      allowTeams: dto.allowTeams ?? false,
      teamMinSize: dto.teamMinSize ?? 1,
      teamMaxSize: dto.teamMaxSize ?? 4,
      minQualityScore: dto.minQualityScore ?? null,
      judgingMethod: dto.judgingMethod ?? 'JUDGES',
      communityWeight: dto.communityWeight ?? 0,
      judgeWeight: dto.judgeWeight ?? 100,
      rubric: dto.rubric ?? [],
      minimumEvaluations: dto.minimumEvaluations ?? 1,
      missingEvaluationPolicy: dto.missingEvaluationPolicy ?? 'EXCLUDE',
      tieBreak: dto.tieBreak ?? [{ type: 'SUBMITTED_AT' }],
      prizes: [],
    };
    assertSetup(validateProgrammeSetup(setup));

    const existing = await this.prisma.programme.findUnique({
      where: { slug: dto.slug },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        code: 'SLUG_TAKEN',
        message: 'That programme slug is already in use.',
      });
    }

    const programme = await this.prisma.programme.create({
      data: {
        slug: dto.slug,
        type: dto.type,
        status: 'DRAFT',
        title: dto.title,
        tagline: dto.tagline,
        description: dto.description,
        category: dto.category,
        organiser: dto.organiser,
        heroCopy: dto.heroCopy ?? '',
        rules: dto.rules ?? [],
        faqs: (dto.faqs ?? []) as unknown as Prisma.InputJsonValue,
        assets: (dto.assets ?? []) as unknown as Prisma.InputJsonValue,
        modules: (dto.modules ?? []) as unknown as Prisma.InputJsonValue,
        ...dates,
        timezone: dto.timezone ?? 'UTC',
        entryMode: dto.entryMode ?? 'NEW_OR_EXISTING',
        registrationRequired: dto.registrationRequired ?? true,
        requireEmailVerified: dto.requireEmailVerified ?? true,
        allowedCategories: dto.allowedCategories ?? [],
        minQualityScore:
          dto.minQualityScore === undefined || dto.minQualityScore === null
            ? null
            : new Prisma.Decimal(dto.minQualityScore),
        allowMultipleEntries: dto.allowMultipleEntries ?? false,
        maxEntriesPerParticipant: dto.maxEntriesPerParticipant ?? 1,
        allowTeams: dto.allowTeams ?? false,
        teamMinSize: dto.teamMinSize ?? 1,
        teamMaxSize: dto.teamMaxSize ?? 4,
        requiredFields: dto.requiredFields ?? [],
        customQuestions: (dto.customQuestions ?? []) as unknown as Prisma.InputJsonValue,
        acceptedLinkHosts: dto.acceptedLinkHosts ?? [],
        maxAttachments: dto.maxAttachments ?? 0,
        allowDraftEditing: dto.allowDraftEditing ?? true,
        allowWithdrawal: dto.allowWithdrawal ?? true,
        lateEntriesAllowed: dto.lateEntriesAllowed ?? false,
        judgingMethod: dto.judgingMethod ?? 'JUDGES',
        communityWeight: dto.communityWeight ?? 0,
        judgeWeight: dto.judgeWeight ?? 100,
        rubric: (dto.rubric ?? []) as unknown as Prisma.InputJsonValue,
        minimumEvaluations: dto.minimumEvaluations ?? 1,
        missingEvaluationPolicy: dto.missingEvaluationPolicy ?? 'EXCLUDE',
        tieBreak: (dto.tieBreak ?? [{ type: 'SUBMITTED_AT' }]) as unknown as Prisma.InputJsonValue,
        allowEvaluationRevision: dto.allowEvaluationRevision ?? false,
        requireConflictDeclaration: dto.requireConflictDeclaration ?? true,
        createdBy: adminId,
      },
      include: adminProgrammeInclude,
    });

    await this.audit(adminId, programme.id, 'programme.created', {
      slug: programme.slug,
      title: programme.title,
    });

    return projectAdminProgramme(programme);
  }

  async update(adminId: string, id: string, dto: UpdateProgrammeDto) {
    const programme = await this.find(id);
    if (programme.version !== dto.version) throw OPTIMISTIC_CONFLICT;

    const dates = {
      registrationOpensAt: dto.registrationOpensAt
        ? new Date(dto.registrationOpensAt)
        : programme.registrationOpensAt,
      registrationClosesAt: dto.registrationClosesAt
        ? new Date(dto.registrationClosesAt)
        : programme.registrationClosesAt,
      submissionOpensAt: dto.submissionOpensAt
        ? new Date(dto.submissionOpensAt)
        : programme.submissionOpensAt,
      submissionClosesAt: dto.submissionClosesAt
        ? new Date(dto.submissionClosesAt)
        : programme.submissionClosesAt,
      judgingStartsAt: dto.judgingStartsAt
        ? new Date(dto.judgingStartsAt)
        : programme.judgingStartsAt,
      judgingEndsAt: dto.judgingEndsAt
        ? new Date(dto.judgingEndsAt)
        : programme.judgingEndsAt,
      resultsAt: dto.resultsAt ? new Date(dto.resultsAt) : programme.resultsAt,
    };

    if (JUDGING_LOCKED_STATUSES.has(programme.status)) {
      const changedScoring = SCORING_FIELDS.some(
        (field) => dto[field] !== undefined,
      );
      if (changedScoring) {
        throw new ConflictException({
          code: 'JUDGING_RULES_LOCKED',
          message:
            'The rubric and weighting cannot change after judging starts. Publish a new edition instead.',
        });
      }
    }

    const merged: ProgrammeSetupInput = {
      ...setupFrom(programme),
      ...dates,
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.tagline !== undefined ? { tagline: dto.tagline } : {}),
      ...(dto.entryMode !== undefined ? { entryMode: dto.entryMode } : {}),
      ...(dto.allowedCategories !== undefined
        ? { allowedCategories: dto.allowedCategories }
        : {}),
      ...(dto.allowMultipleEntries !== undefined
        ? { allowMultipleEntries: dto.allowMultipleEntries }
        : {}),
      ...(dto.maxEntriesPerParticipant !== undefined
        ? { maxEntriesPerParticipant: dto.maxEntriesPerParticipant }
        : {}),
      ...(dto.allowTeams !== undefined ? { allowTeams: dto.allowTeams } : {}),
      ...(dto.teamMinSize !== undefined ? { teamMinSize: dto.teamMinSize } : {}),
      ...(dto.teamMaxSize !== undefined ? { teamMaxSize: dto.teamMaxSize } : {}),
      ...(dto.minQualityScore !== undefined
        ? { minQualityScore: dto.minQualityScore }
        : {}),
      ...(dto.judgingMethod !== undefined
        ? { judgingMethod: dto.judgingMethod }
        : {}),
      ...(dto.communityWeight !== undefined
        ? { communityWeight: dto.communityWeight }
        : {}),
      ...(dto.judgeWeight !== undefined ? { judgeWeight: dto.judgeWeight } : {}),
      ...(dto.rubric !== undefined ? { rubric: dto.rubric } : {}),
      ...(dto.minimumEvaluations !== undefined
        ? { minimumEvaluations: dto.minimumEvaluations }
        : {}),
      ...(dto.missingEvaluationPolicy !== undefined
        ? { missingEvaluationPolicy: dto.missingEvaluationPolicy }
        : {}),
      ...(dto.tieBreak !== undefined ? { tieBreak: dto.tieBreak } : {}),
    };
    assertSetup(validateProgrammeSetup(merged));

    if (dto.slug !== undefined && dto.slug !== programme.slug) {
      const taken = await this.prisma.programme.findUnique({
        where: { slug: dto.slug },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException({
          code: 'SLUG_TAKEN',
          message: 'That programme slug is already in use.',
        });
      }
    }

    const updated = await this.prisma.programme.update({
      where: { id },
      data: {
        ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.tagline !== undefined ? { tagline: dto.tagline } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.organiser !== undefined ? { organiser: dto.organiser } : {}),
        ...(dto.heroCopy !== undefined ? { heroCopy: dto.heroCopy } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
        ...(dto.rules !== undefined ? { rules: dto.rules } : {}),
        ...(dto.faqs !== undefined
          ? { faqs: dto.faqs as unknown as Prisma.InputJsonValue }
          : {}),
        ...(dto.assets !== undefined
          ? { assets: dto.assets as unknown as Prisma.InputJsonValue }
          : {}),
        ...(dto.modules !== undefined
          ? { modules: dto.modules as unknown as Prisma.InputJsonValue }
          : {}),
        ...dates,
        ...(dto.entryMode !== undefined ? { entryMode: dto.entryMode } : {}),
        ...(dto.registrationRequired !== undefined
          ? { registrationRequired: dto.registrationRequired }
          : {}),
        ...(dto.requireEmailVerified !== undefined
          ? { requireEmailVerified: dto.requireEmailVerified }
          : {}),
        ...(dto.allowedCategories !== undefined
          ? { allowedCategories: dto.allowedCategories }
          : {}),
        ...(dto.minQualityScore !== undefined
          ? {
              minQualityScore:
                dto.minQualityScore === null
                  ? null
                  : new Prisma.Decimal(dto.minQualityScore),
            }
          : {}),
        ...(dto.allowMultipleEntries !== undefined
          ? { allowMultipleEntries: dto.allowMultipleEntries }
          : {}),
        ...(dto.maxEntriesPerParticipant !== undefined
          ? { maxEntriesPerParticipant: dto.maxEntriesPerParticipant }
          : {}),
        ...(dto.allowTeams !== undefined ? { allowTeams: dto.allowTeams } : {}),
        ...(dto.teamMinSize !== undefined ? { teamMinSize: dto.teamMinSize } : {}),
        ...(dto.teamMaxSize !== undefined ? { teamMaxSize: dto.teamMaxSize } : {}),
        ...(dto.requiredFields !== undefined
          ? { requiredFields: dto.requiredFields }
          : {}),
        ...(dto.customQuestions !== undefined
          ? {
              customQuestions:
                dto.customQuestions as unknown as Prisma.InputJsonValue,
            }
          : {}),
        ...(dto.acceptedLinkHosts !== undefined
          ? { acceptedLinkHosts: dto.acceptedLinkHosts }
          : {}),
        ...(dto.maxAttachments !== undefined
          ? { maxAttachments: dto.maxAttachments }
          : {}),
        ...(dto.allowDraftEditing !== undefined
          ? { allowDraftEditing: dto.allowDraftEditing }
          : {}),
        ...(dto.allowWithdrawal !== undefined
          ? { allowWithdrawal: dto.allowWithdrawal }
          : {}),
        ...(dto.lateEntriesAllowed !== undefined
          ? { lateEntriesAllowed: dto.lateEntriesAllowed }
          : {}),
        ...(dto.judgingMethod !== undefined
          ? { judgingMethod: dto.judgingMethod }
          : {}),
        ...(dto.communityWeight !== undefined
          ? { communityWeight: dto.communityWeight }
          : {}),
        ...(dto.judgeWeight !== undefined ? { judgeWeight: dto.judgeWeight } : {}),
        ...(dto.rubric !== undefined
          ? { rubric: dto.rubric as unknown as Prisma.InputJsonValue }
          : {}),
        ...(dto.minimumEvaluations !== undefined
          ? { minimumEvaluations: dto.minimumEvaluations }
          : {}),
        ...(dto.missingEvaluationPolicy !== undefined
          ? { missingEvaluationPolicy: dto.missingEvaluationPolicy }
          : {}),
        ...(dto.tieBreak !== undefined
          ? { tieBreak: dto.tieBreak as unknown as Prisma.InputJsonValue }
          : {}),
        ...(dto.requireConflictDeclaration !== undefined
          ? { requireConflictDeclaration: dto.requireConflictDeclaration }
          : {}),
        ...(dto.allowEvaluationRevision !== undefined
          ? { allowEvaluationRevision: dto.allowEvaluationRevision }
          : {}),
        version: { increment: 1 },
      },
      include: adminProgrammeInclude,
    });

    await this.audit(adminId, id, 'programme.updated', {
      fields: Object.keys(dto).filter((key) => key !== 'version'),
      version: updated.version,
    });

    return projectAdminProgramme(updated);
  }

  async transition(adminId: string, id: string, dto: UpdateProgrammeStatusDto) {
    const programme = await this.find(id);
    if (!canTransitionProgramme(programme.status, dto.status)) {
      throw new ConflictException({
        code: 'INVALID_STATUS_TRANSITION',
        message: `A programme cannot move from ${programme.status} to ${dto.status}.`,
      });
    }

    if (dto.status === 'REGISTRATION_OPEN') {
      assertSetup(validateProgrammeSetup(setupFrom(programme)));
      const funding = validatePrizeFunding(setupFrom(programme).prizes);
      if (funding.length > 0) {
        throw new BadRequestException({
          code: 'PRIZES_NOT_FUNDED',
          message:
            'Record and confirm prize funding before opening the programme (FR-1207).',
          issues: funding,
        });
      }
    }

    if (dto.status === 'SUBMISSION_OPEN') {
      assertSetup(validateProgrammeSetup(setupFrom(programme)));
    }

    if (dto.status === 'JUDGING') {
      const scoring = scoringConfigurationFrom(programme);
      const issues = validateScoringConfiguration(scoring);
      if (issues.length > 0) {
        throw new BadRequestException({
          code: 'JUDGING_NOT_READY',
          message: 'The judging rules are incomplete.',
          issues,
        });
      }
      if (
        (programme.judgingMethod === 'JUDGES' ||
          programme.judgingMethod === 'HYBRID') &&
        programme.judges.filter((judge) => judge.status === 'ACTIVE').length === 0
      ) {
        throw new ConflictException({
          code: 'NO_JUDGES',
          message: 'Assign at least one active judge before judging starts.',
        });
      }
    }

    if (dto.status === 'COMPLETED' && programme.resultPublications.length === 0) {
      throw new ConflictException({
        code: 'RESULTS_NOT_PUBLISHED',
        message: 'Publish results before marking the programme complete.',
      });
    }

    const updated = await this.prisma.programme.update({
      where: { id },
      data: {
        status: dto.status,
        ...(dto.status === 'REGISTRATION_OPEN' && programme.publishedAt === null
          ? { publishedAt: new Date() }
          : {}),
        version: { increment: 1 },
      },
      include: adminProgrammeInclude,
    });

    await this.audit(adminId, id, 'programme.status_changed', {
      from: programme.status,
      to: dto.status,
      reason: dto.reason ?? null,
    });

    return projectAdminProgramme(updated);
  }

  async assignJudge(adminId: string, id: string, dto: AssignJudgeDto) {
    await this.find(id);
    const judge = dto.judgeId
      ? await this.prisma.user.findUnique({
          where: { id: dto.judgeId },
          select: { id: true, email: true, bannedAt: true },
        })
      : dto.email
        ? await this.prisma.user.findFirst({
            where: { email: dto.email.trim().toLowerCase() },
            select: { id: true, email: true, bannedAt: true },
          })
        : null;

    if (!judge) {
      throw new NotFoundException({
        code: 'JUDGE_ACCOUNT_NOT_FOUND',
        message:
          'No account matches that judge. The judge must sign in before being assigned.',
      });
    }
    if (judge.bannedAt) {
      throw new BadRequestException({
        code: 'JUDGE_ACCOUNT_BANNED',
        message: 'That account cannot be assigned as a judge.',
      });
    }

    const assignment = await this.prisma.programmeJudge.upsert({
      where: { programmeId_judgeId: { programmeId: id, judgeId: judge.id } },
      create: {
        programmeId: id,
        judgeId: judge.id,
        status: 'ACTIVE',
        conflictDeclaration: dto.conflictDeclaration ?? null,
        assignedBy: adminId,
      },
      update: {
        status: 'ACTIVE',
        conflictDeclaration: dto.conflictDeclaration ?? null,
        assignedBy: adminId,
      },
    });

    await this.audit(adminId, id, 'judge.assigned', {
      judgeId: judge.id,
      assignmentId: assignment.id,
    });

    return {
      id: assignment.id,
      judgeId: judge.id,
      email: judge.email,
      status: assignment.status,
    };
  }

  async removeJudge(adminId: string, id: string, assignmentId: string) {
    const assignment = await this.prisma.programmeJudge.findFirst({
      where: { id: assignmentId, programmeId: id },
    });
    if (!assignment) {
      throw new NotFoundException({
        code: 'JUDGE_ASSIGNMENT_NOT_FOUND',
        message: 'That judge assignment does not exist.',
      });
    }

    const updated = await this.prisma.programmeJudge.update({
      where: { id: assignmentId },
      data: { status: 'EXCLUDED' },
    });
    await this.audit(adminId, id, 'judge.excluded', {
      judgeId: assignment.judgeId,
      assignmentId,
    });

    return { id: updated.id, status: updated.status };
  }

  async listEntries(id: string, query: ProgrammeEntryListQueryDto) {
    await this.find(id);
    const limit = clampPageSize(query.limit);
    const fingerprint = filterFingerprint({
      programmeId: id,
      status: query.status ?? null,
      sort: 'submittedAt_desc',
    });
    const where: Prisma.ProgrammeEntryWhereInput = {
      programmeId: id,
      ...(query.status
        ? { status: query.status as ProgrammeEntryStatus }
        : {}),
    };
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor, fingerprint);
      where.AND = [keysetCondition('createdAt', 'desc', cursor, asCursorDate)];
    }

    const rows = await this.prisma.programmeEntry.findMany({
      where,
      include: entryWithIdeaInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = buildPage(rows, limit, (row) =>
      encodeCursorValues([row.createdAt.toISOString()], row.id, fingerprint),
    );

    return {
      data: page.data.map(projectAdminEntry),
      page: page.page,
    };
  }

  async decideEntry(
    adminId: string,
    programmeId: string,
    entryId: string,
    dto: AdminEntryDecisionDto,
  ) {
    const [programme, entry] = await Promise.all([
      this.find(programmeId),
      this.prisma.programmeEntry.findFirst({
        where: { id: entryId, programmeId },
        include: entryWithIdeaInclude,
      }),
    ]);
    if (!entry) {
      throw new NotFoundException({
        code: 'ENTRY_NOT_FOUND',
        message: 'That entry does not exist.',
      });
    }
    if (entry.status === 'DRAFT' || entry.status === 'WITHDRAWN') {
      throw new ConflictException({
        code: 'ENTRY_NOT_REVIEWABLE',
        message: 'Only submitted entries can be reviewed.',
      });
    }

    const updated = await this.prisma.programmeEntry.update({
      where: { id: entryId },
      data: {
        status: dto.status,
        ...(dto.note !== undefined ? { moderatorNote: dto.note } : {}),
      },
      include: entryWithIdeaInclude,
    });

    await this.audit(adminId, programmeId, 'entry.decided', {
      entryId,
      from: entry.status,
      to: dto.status,
      noteRecorded: dto.note !== undefined,
    });

    await this.notifications
      .notify({
        toUserId: entry.participantId,
        template: 'PROGRAMME_ENTRY_DECISION',
        data: {
          programmeTitle: programme.title,
          programmeSlug: programme.slug,
          entryTitle: entry.title,
          status: dto.status,
          // The moderator's internal note is never copied into a notification.
        },
        dedupeKey: `programme:${programmeId}:entry:${entryId}:decision:${dto.status}`,
      })
      .catch(() => undefined);

    return projectAdminEntry(updated);
  }

  async setCuratedRank(
    adminId: string,
    programmeId: string,
    entryId: string,
    dto: CuratedRankDto,
  ) {
    const programme = await this.find(programmeId);
    if (programme.judgingMethod !== 'CURATED') {
      throw new ConflictException({
        code: 'NOT_CURATED',
        message: 'Curated ranks can only be set on a CURATED programme.',
      });
    }
    const entry = await this.prisma.programmeEntry.findFirst({
      where: { id: entryId, programmeId },
      include: entryWithIdeaInclude,
    });
    if (!entry) {
      throw new NotFoundException({
        code: 'ENTRY_NOT_FOUND',
        message: 'That entry does not exist.',
      });
    }

    const updated = await this.prisma.programmeEntry.update({
      where: { id: entryId },
      data: { curatedRank: dto.curatedRank ?? null },
      include: entryWithIdeaInclude,
    });
    await this.audit(adminId, programmeId, 'entry.curated_rank', {
      entryId,
      from: entry.curatedRank,
      to: dto.curatedRank ?? null,
    });
    return projectAdminEntry(updated);
  }

  async addPrize(adminId: string, programmeId: string, dto: ProgrammePrizeDto) {
    const programme = await this.find(programmeId);
    if (JUDGING_LOCKED_STATUSES.has(programme.status)) {
      throw new ConflictException({
        code: 'PRIZES_LOCKED',
        message: 'Prizes cannot change after judging starts.',
      });
    }
    const prize = await this.prisma.programmePrize.create({
      data: {
        programmeId,
        placement: dto.placement ?? 1,
        title: dto.title,
        description: dto.description,
        kind: dto.kind,
        amountAtomic: dto.amountAtomic ?? null,
        currency: dto.currency ?? 'USD',
        decimals: dto.decimals ?? 2,
        awardCriteria: dto.awardCriteria ?? null,
        eligibility: dto.eligibility ?? null,
        fundingStatus: dto.fundingStatus ?? 'UNCONFIRMED',
        fulfilmentStatus: dto.fulfilmentStatus ?? 'UNCONFIRMED',
        fulfilmentOwner: dto.fulfilmentOwner ?? null,
      },
    });
    await this.audit(adminId, programmeId, 'prize.added', {
      prizeId: prize.id,
      placement: prize.placement,
    });
    return prize;
  }

  async updatePrize(
    adminId: string,
    programmeId: string,
    prizeId: string,
    dto: UpdateProgrammePrizeDto,
  ) {
    const programme = await this.find(programmeId);
    if (JUDGING_LOCKED_STATUSES.has(programme.status)) {
      throw new ConflictException({
        code: 'PRIZES_LOCKED',
        message: 'Prizes cannot change after judging starts.',
      });
    }
    const existing = await this.prisma.programmePrize.findFirst({
      where: { id: prizeId, programmeId },
    });
    if (!existing) {
      throw new NotFoundException({
        code: 'PRIZE_NOT_FOUND',
        message: 'That prize does not exist.',
      });
    }
    const prize = await this.prisma.programmePrize.update({
      where: { id: prizeId },
      data: {
        ...(dto.placement !== undefined ? { placement: dto.placement } : {}),
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
        ...(dto.amountAtomic !== undefined
          ? { amountAtomic: dto.amountAtomic }
          : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        ...(dto.decimals !== undefined ? { decimals: dto.decimals } : {}),
        ...(dto.awardCriteria !== undefined
          ? { awardCriteria: dto.awardCriteria }
          : {}),
        ...(dto.eligibility !== undefined ? { eligibility: dto.eligibility } : {}),
        ...(dto.fundingStatus !== undefined
          ? { fundingStatus: dto.fundingStatus }
          : {}),
        ...(dto.fulfilmentStatus !== undefined
          ? { fulfilmentStatus: dto.fulfilmentStatus }
          : {}),
        ...(dto.fulfilmentOwner !== undefined
          ? { fulfilmentOwner: dto.fulfilmentOwner }
          : {}),
      },
    });
    await this.audit(adminId, programmeId, 'prize.updated', {
      prizeId,
      fundingStatus: prize.fundingStatus,
    });
    return prize;
  }

  async removePrize(adminId: string, programmeId: string, prizeId: string) {
    const programme = await this.find(programmeId);
    if (JUDGING_LOCKED_STATUSES.has(programme.status)) {
      throw new ConflictException({
        code: 'PRIZES_LOCKED',
        message: 'Prizes cannot change after judging starts.',
      });
    }
    const deleted = await this.prisma.programmePrize.deleteMany({
      where: { id: prizeId, programmeId },
    });
    if (deleted.count === 0) {
      throw new NotFoundException({
        code: 'PRIZE_NOT_FOUND',
        message: 'That prize does not exist.',
      });
    }
    await this.audit(adminId, programmeId, 'prize.removed', { prizeId });
    return { removed: true };
  }

  async addSponsor(
    adminId: string,
    programmeId: string,
    dto: ProgrammeSponsorDto,
  ) {
    await this.find(programmeId);
    const sponsor = await this.prisma.programmeSponsor.create({
      data: {
        programmeId,
        name: dto.name,
        tier: dto.tier ?? 'partner',
        website: dto.website ?? null,
        logoUrl: dto.logoUrl ?? null,
        deliverables: dto.deliverables ?? [],
        commitmentAtomic: dto.commitmentAtomic ?? '0',
        currency: dto.currency ?? 'USD',
        invoiceStatus: dto.invoiceStatus ?? 'DRAFT',
        confirmedByProvider: dto.confirmedByProvider ?? false,
      },
    });
    await this.audit(adminId, programmeId, 'sponsor.added', {
      sponsorId: sponsor.id,
      tier: sponsor.tier,
    });
    return sponsor;
  }

  async updateSponsor(
    adminId: string,
    programmeId: string,
    sponsorId: string,
    dto: UpdateProgrammeSponsorDto,
  ) {
    await this.find(programmeId);
    const existing = await this.prisma.programmeSponsor.findFirst({
      where: { id: sponsorId, programmeId },
    });
    if (!existing) {
      throw new NotFoundException({
        code: 'SPONSOR_NOT_FOUND',
        message: 'That sponsor does not exist.',
      });
    }
    const sponsor = await this.prisma.programmeSponsor.update({
      where: { id: sponsorId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.tier !== undefined ? { tier: dto.tier } : {}),
        ...(dto.website !== undefined ? { website: dto.website } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.deliverables !== undefined
          ? { deliverables: dto.deliverables }
          : {}),
        ...(dto.commitmentAtomic !== undefined
          ? { commitmentAtomic: dto.commitmentAtomic }
          : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        ...(dto.invoiceStatus !== undefined
          ? { invoiceStatus: dto.invoiceStatus }
          : {}),
        ...(dto.confirmedByProvider !== undefined
          ? { confirmedByProvider: dto.confirmedByProvider }
          : {}),
      },
    });
    await this.audit(adminId, programmeId, 'sponsor.updated', {
      sponsorId,
      invoiceStatus: sponsor.invoiceStatus,
    });
    return sponsor;
  }

  async removeSponsor(adminId: string, programmeId: string, sponsorId: string) {
    await this.find(programmeId);
    const deleted = await this.prisma.programmeSponsor.deleteMany({
      where: { id: sponsorId, programmeId },
    });
    if (deleted.count === 0) {
      throw new NotFoundException({
        code: 'SPONSOR_NOT_FOUND',
        message: 'That sponsor does not exist.',
      });
    }
    await this.audit(adminId, programmeId, 'sponsor.removed', { sponsorId });
    return { removed: true };
  }

  async addAnnouncement(
    adminId: string,
    programmeId: string,
    dto: ProgrammeAnnouncementDto,
  ) {
    await this.find(programmeId);
    const announcement = await this.prisma.programmeAnnouncement.create({
      data: {
        programmeId,
        title: dto.title,
        body: dto.body,
        publishedAt: dto.publishedAt ? new Date(dto.publishedAt) : null,
        createdBy: adminId,
      },
    });
    await this.audit(adminId, programmeId, 'announcement.added', {
      announcementId: announcement.id,
      published: announcement.publishedAt !== null,
    });
    return announcement;
  }

  async updateAnnouncement(
    adminId: string,
    programmeId: string,
    announcementId: string,
    dto: ProgrammeAnnouncementDto,
  ) {
    await this.find(programmeId);
    const existing = await this.prisma.programmeAnnouncement.findFirst({
      where: { id: announcementId, programmeId },
    });
    if (!existing) {
      throw new NotFoundException({
        code: 'ANNOUNCEMENT_NOT_FOUND',
        message: 'That announcement does not exist.',
      });
    }
    const announcement = await this.prisma.programmeAnnouncement.update({
      where: { id: announcementId },
      data: {
        title: dto.title,
        body: dto.body,
        publishedAt: dto.publishedAt ? new Date(dto.publishedAt) : null,
      },
    });
    await this.audit(adminId, programmeId, 'announcement.updated', {
      announcementId,
      published: announcement.publishedAt !== null,
    });
    return announcement;
  }

  async analytics(programmeId: string) {
    const programme = await this.find(programmeId);
    const [entriesByStatus, registrations, evaluations, activeJudges] =
      await Promise.all([
        this.prisma.programmeEntry.groupBy({
          by: ['status'],
          where: { programmeId },
          _count: { _all: true },
        }),
        this.prisma.programmeRegistration.count({ where: { programmeId } }),
        this.prisma.programmeEvaluation.groupBy({
          by: ['status'],
          where: { programmeId },
          _count: { _all: true },
        }),
        this.prisma.programmeJudge.count({
          where: { programmeId, status: 'ACTIVE' },
        }),
      ]);

    const totalEntries = entriesByStatus.reduce(
      (sum, row) => sum + row._count._all,
      0,
    );
    const submitted = entriesByStatus
      .filter((row) =>
        ['SUBMITTED', 'UNDER_REVIEW', 'SHORTLISTED', 'ACCEPTED'].includes(row.status),
      )
      .reduce((sum, row) => sum + row._count._all, 0);

    return {
      programmeId,
      status: programme.status,
      resultsVisibility: programme.resultsVisibility,
      registrations,
      activeJudges,
      totalEntries,
      submittedEntries: submitted,
      completionRate:
        totalEntries === 0 ? 0 : Math.round((submitted / totalEntries) * 10000) / 100,
      entriesByStatus: Object.fromEntries(
        entriesByStatus.map((row) => [row.status, row._count._all]),
      ),
      evaluationsByStatus: Object.fromEntries(
        evaluations.map((row) => [row.status, row._count._all]),
      ),
      prizes: programme.prizes.map((prize) => ({
        placement: prize.placement,
        kind: prize.kind,
        fundingStatus: prize.fundingStatus,
        fulfilmentStatus: prize.fulfilmentStatus,
      })),
      latestPublication: programme.resultPublications[0]
        ? {
            revision: programme.resultPublications[0].revision,
            checksum: programme.resultPublications[0].checksum,
            publishedAt: programme.resultPublications[0].publishedAt.toISOString(),
          }
        : null,
    };
  }

  async auditLog(programmeId: string, limit = 50) {
    await this.find(programmeId);
    const events = await this.prisma.programmeAuditEvent.findMany({
      where: { programmeId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: {
        id: true,
        action: true,
        target: true,
        actorId: true,
        before: true,
        after: true,
        createdAt: true,
      },
    });
    return events.map((event) => ({
      ...event,
      createdAt: event.createdAt.toISOString(),
    }));
  }

  private async find(id: string): Promise<AdminProgrammeRecord> {
    const programme = await this.prisma.programme.findUnique({
      where: { id },
      include: adminProgrammeInclude,
    });
    if (!programme) {
      throw new NotFoundException({
        code: 'PROGRAMME_NOT_FOUND',
        message: 'That programme does not exist.',
      });
    }
    return programme;
  }

  private async audit(
    actorId: string,
    programmeId: string,
    action: string,
    after?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.programmeAuditEvent.create({
      data: {
        programmeId,
        actorId,
        action,
        after: after ? (after as Prisma.InputJsonValue) : undefined,
      },
    });
  }
}
