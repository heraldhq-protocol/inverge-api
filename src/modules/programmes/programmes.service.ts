import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type { ProgrammeEntryStatus, User } from '../../generated/prisma/client';
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
  CreateProgrammeEntryDto,
  ListProgrammesQueryDto,
  RegisterForProgrammeDto,
  SubmitProgrammeEntryDto,
  UpdateProgrammeEntryDto,
  WithdrawProgrammeEntryDto,
} from './dto/programme.dto';
import { decimalToNumber } from './programme-config';
import {
  evaluateEntry,
  evaluateRegistration,
  evaluateSubmission,
  type EligibilityIssue,
} from './programme-eligibility';
import {
  entryWithIdeaInclude,
  projectParticipantEntry,
  projectPublicEntry,
  projectPublicProgramme,
  publicProgrammeInclude,
  type EntryWithIdea,
  type PublicProgrammeRecord,
} from './programme-projections';

type ProgrammeRow = Prisma.ProgrammeGetPayload<{
  include: typeof publicProgrammeInclude;
}>;

const PUBLIC_STATUSES = [
  'SCHEDULED',
  'REGISTRATION_OPEN',
  'SUBMISSION_OPEN',
  'JUDGING',
  'RESULTS_REVIEW',
  'COMPLETED',
] as const;

const WITHDRAWN = 'WITHDRAWN' satisfies ProgrammeEntryStatus;
const EDITABLE: ProgrammeEntryStatus[] = ['DRAFT', 'CHANGES_REQUESTED'];

function ineligible(issues: EligibilityIssue[]): BadRequestException {
  return new BadRequestException({
    code: 'PROGRAMME_INELIGIBLE',
    message: 'This action does not meet the programme rules.',
    issues,
  });
}

function asContent(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function customQuestionsOf(
  programme: ProgrammeRow,
): Array<{ id: string; required?: boolean; label?: string }> {
  if (!Array.isArray(programme.customQuestions)) return [];
  return programme.customQuestions.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== 'string' || row.id.trim().length === 0) return [];
    return [
      {
        id: row.id,
        required: row.required === true,
        ...(typeof row.label === 'string' ? { label: row.label } : {}),
      },
    ];
  });
}

@Injectable()
export class ProgrammesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async listPublic(query: ListProgrammesQueryDto) {
    const limit = clampPageSize(query.limit);
    const fingerprint = filterFingerprint({
      type: query.type ?? null,
      status: query.status ?? null,
      category: query.category ?? null,
      sort: 'publishedAt_desc',
    });

    const where: Prisma.ProgrammeWhereInput = {
      publishedAt: { not: null },
      status: { in: [...PUBLIC_STATUSES] },
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
    };

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor, fingerprint);
      where.AND = [keysetCondition('publishedAt', 'desc', cursor, asCursorDate)];
    }

    const rows = await this.prisma.programme.findMany({
      where,
      include: publicProgrammeInclude,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const now = new Date();
    const page = buildPage(rows, limit, (row) =>
      encodeCursorValues(
        [(row.publishedAt ?? row.createdAt).toISOString()],
        row.id,
        fingerprint,
      ),
    );

    return {
      data: page.data.map((row) => projectPublicProgramme(row, now)),
      page: page.page,
    };
  }

  async getPublic(idOrSlug: string) {
    const record = await this.findPublicRecord(idOrSlug);
    return projectPublicProgramme(record, new Date());
  }

  async listMine(userId: string) {
    const registrations = await this.prisma.programmeRegistration.findMany({
      where: { userId, status: { not: 'REJECTED' } },
      include: { programme: { include: publicProgrammeInclude } },
      orderBy: { registeredAt: 'desc' },
      take: 50,
    });
    const now = new Date();
    return registrations
      .filter(
        (row) =>
          row.programme.publishedAt !== null &&
          row.programme.status !== 'DRAFT' &&
          row.programme.status !== 'ARCHIVED',
      )
      .map((row) => ({
        registration: {
          id: row.id,
          status: row.status,
          registeredAt: row.registeredAt.toISOString(),
        },
        programme: projectPublicProgramme(row.programme, now),
      }));
  }

  async getPublicStandings(idOrSlug: string) {
    const record = await this.findPublicRecord(idOrSlug);
    if (record.resultsVisibility !== 'PUBLIC') {
      throw new NotFoundException({
        code: 'RESULTS_NOT_PUBLIC',
        message: 'Results for this programme are not public yet.',
      });
    }
    const publication = record.resultPublications[0];
    if (!publication) {
      throw new NotFoundException({
        code: 'RESULTS_NOT_PUBLISHED',
        message: 'No official result has been published for this programme.',
      });
    }
    return {
      programme: {
        id: record.id,
        slug: record.slug,
        title: record.title,
        resultsAt: record.resultsAt.toISOString(),
      },
      revision: publication.revision,
      checksum: publication.checksum,
      publishedAt: publication.publishedAt.toISOString(),
      methodology: publication.methodology,
      standings: publication.standings,
      notes: publication.notes,
    };
  }

  async listPublicEntries(idOrSlug: string) {
    const record = await this.findPublicRecord(idOrSlug);
    const publiclyReadable =
      record.resultsVisibility === 'PUBLIC' ||
      record.status === 'JUDGING' ||
      record.status === 'RESULTS_REVIEW';
    if (!publiclyReadable) {
      throw new NotFoundException({
        code: 'ENTRIES_NOT_PUBLIC',
        message: 'Entries for this programme are not public yet.',
      });
    }

    const statuses: ProgrammeEntryStatus[] = record.resultsVisibility === 'PUBLIC'
      ? ['SHORTLISTED', 'ACCEPTED']
      : ['SHORTLISTED'];

    const entries = await this.prisma.programmeEntry.findMany({
      where: { programmeId: record.id, status: { in: statuses } },
      include: entryWithIdeaInclude,
      orderBy: [{ curatedRank: 'asc' }, { submittedAt: 'asc' }, { id: 'asc' }],
    });

    return {
      data: entries.map(projectPublicEntry),
      resultsPublic: record.resultsVisibility === 'PUBLIC',
    };
  }

  async getMine(userId: string, idOrSlug: string) {
    const record = await this.findPublicRecord(idOrSlug);
    const [registration, entries, publication] = await Promise.all([
      this.prisma.programmeRegistration.findUnique({
        where: { programmeId_userId: { programmeId: record.id, userId } },
      }),
      this.prisma.programmeEntry.findMany({
        where: { programmeId: record.id, participantId: userId },
        include: entryWithIdeaInclude,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      }),
      record.resultsVisibility !== 'HIDDEN'
        ? this.prisma.programmeResultPublication.findFirst({
            where: { programmeId: record.id },
            orderBy: { revision: 'desc' },
          })
        : Promise.resolve(null),
    ]);

    const now = new Date();
    const activeEntries = entries.filter((entry) => entry.status !== WITHDRAWN);
    const limit = record.allowMultipleEntries
      ? Math.max(1, record.maxEntriesPerParticipant)
      : 1;

    const entriesWithFeedback = entries.map((entry) => {
      const projected = projectParticipantEntry(entry);
      if (!publication) return projected;

      const standings = Array.isArray(publication.standings)
        ? (publication.standings as unknown[])
        : [];
      const standing = standings.find(
        (row) =>
          row !== null &&
          typeof row === 'object' &&
          (row as Record<string, unknown>).entryId === entry.id,
      ) as Record<string, unknown> | undefined;

      return {
        ...projected,
        latestFeedback: standing
          ? {
              rank: typeof standing.rank === 'number' ? standing.rank : null,
              officialScore:
                typeof standing.officialScore === 'number'
                  ? standing.officialScore
                  : null,
              feedback: standing.participantFeedback ?? null,
              incompleteReason: standing.incompleteReason ?? null,
            }
          : null,
      };
    });

    return {
      programme: projectPublicProgramme(record, now),
      registration: registration
        ? {
            id: registration.id,
            status: registration.status,
            eligibilityNote: registration.eligibilityNote,
            registeredAt: registration.registeredAt.toISOString(),
          }
        : null,
      entryLimit: limit,
      activeEntryCount: activeEntries.length,
      canAddEntry: activeEntries.length < limit && record.status === 'SUBMISSION_OPEN',
      entries: entriesWithFeedback,
    };
  }

  async register(
    user: User,
    idOrSlug: string,
    dto: RegisterForProgrammeDto,
  ) {
    const programme = await this.findProgrammeRow(idOrSlug);
    const existing = await this.prisma.programmeRegistration.findUnique({
      where: {
        programmeId_userId: { programmeId: programme.id, userId: user.id },
      },
    });

    const evaluation = evaluateRegistration({
      now: new Date(),
      programme,
      participant: user,
      existingRegistration: existing,
    });
    if (!evaluation.eligible) throw ineligible(evaluation.issues);

    if (existing && existing.status === 'ELIGIBLE') {
      return {
        id: existing.id,
        status: existing.status,
        registeredAt: existing.registeredAt.toISOString(),
        alreadyRegistered: true,
      };
    }

    const registration = await this.prisma.programmeRegistration.upsert({
      where: {
        programmeId_userId: { programmeId: programme.id, userId: user.id },
      },
      create: {
        programmeId: programme.id,
        userId: user.id,
        status: 'ELIGIBLE',
        eligibilityNote: dto.note ?? null,
      },
      update: {
        status: 'ELIGIBLE',
        eligibilityNote: dto.note ?? existing?.eligibilityNote ?? null,
        registeredAt: new Date(),
      },
    });

    await this.recordAudit(programme.id, user.id, 'registration.created', {
      registrationId: registration.id,
    });

    await this.notifications.notify({
      toUserId: user.id,
      template: 'PROGRAMME_REGISTERED',
      data: {
        programmeTitle: programme.title,
        programmeSlug: programme.slug,
        submissionClosesAt: programme.submissionClosesAt.toISOString(),
      },
      dedupeKey: `programme:${programme.id}:registered:${user.id}`,
    });

    return {
      id: registration.id,
      status: registration.status,
      registeredAt: registration.registeredAt.toISOString(),
      alreadyRegistered: false,
    };
  }

  async createEntry(
    user: User,
    idOrSlug: string,
    dto: CreateProgrammeEntryDto,
  ) {
    const programme = await this.findProgrammeRow(idOrSlug);
    const idea = await this.prisma.idea.findUnique({
      where: { id: dto.ideaId },
      select: {
        id: true,
        creatorId: true,
        title: true,
        category: true,
        status: true,
        qualityScore: true,
      },
    });

    if (!idea) {
      throw new NotFoundException({
        code: 'IDEA_NOT_FOUND',
        message: 'The idea you selected does not exist.',
      });
    }

    const category =
      str(dto.category) ||
      str(idea.category) ||
      programme.allowedCategories[0] ||
      programme.category;

    let entry: EntryWithIdea;
    try {
      entry = await this.prisma.$transaction(async (tx) => {
        // Serialise concurrent entry creation for one participant in one
        // programme. A count followed by a create is otherwise a TOCTOU race
        // that can exceed maxEntriesPerParticipant.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`programme-entry:${programme.id}:${user.id}`}))`;

        const [registration, activeEntryCount] = await Promise.all([
          tx.programmeRegistration.findUnique({
            where: {
              programmeId_userId: {
                programmeId: programme.id,
                userId: user.id,
              },
            },
          }),
          tx.programmeEntry.count({
            where: {
              programmeId: programme.id,
              participantId: user.id,
              status: { not: WITHDRAWN },
            },
          }),
        ]);

        const evaluation = evaluateEntry({
          now: new Date(),
          programme: {
            ...programme,
            minQualityScore: decimalToNumber(programme.minQualityScore),
          },
          participant: user,
          registration,
          activeEntryCount,
          entry: { source: dto.source, category },
          idea: {
            id: idea.id,
            ownerId: idea.creatorId,
            status: idea.status,
            qualityScore: decimalToNumber(idea.qualityScore),
            category: idea.category,
          },
        });
        if (!evaluation.eligible) throw ineligible(evaluation.issues);

        return tx.programmeEntry.create({
          data: {
            programmeId: programme.id,
            participantId: user.id,
            ideaId: idea.id,
            source: dto.source,
            title: str(dto.title) || idea.title,
            category,
            content: (dto.content ?? {}) as Prisma.InputJsonValue,
            teamMembers: dto.teamMembers
              ? { create: dto.teamMembers.map((member) => ({ ...member })) }
              : undefined,
          },
          include: entryWithIdeaInclude,
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.programmeEntry.findUnique({
          where: {
            programmeId_participantId_ideaId: {
              programmeId: programme.id,
              participantId: user.id,
              ideaId: idea.id,
            },
          },
          include: entryWithIdeaInclude,
        });
        if (existing?.status === 'WITHDRAWN') {
          const revived = await this.prisma.programmeEntry.update({
            where: { id: existing.id },
            data: {
              status: 'DRAFT',
              title: str(dto.title) || existing.title,
              category,
              content: (dto.content ?? {}) as Prisma.InputJsonValue,
              withdrawnAt: null,
              submittedSnapshot: Prisma.DbNull,
              submissionVersion: 0,
              submittedAt: null,
            },
            include: entryWithIdeaInclude,
          });
          await this.recordAudit(programme.id, user.id, 'entry.reopened', {
            entryId: revived.id,
          });
          return projectParticipantEntry(revived);
        }
        throw new ConflictException({
          code: 'ENTRY_ALREADY_EXISTS',
          message:
            'You already entered this idea into this programme. Edit that entry instead.',
        });
      }
      throw error;
    }

    await this.recordAudit(programme.id, user.id, 'entry.created', {
      entryId: entry.id,
      ideaId: idea.id,
      source: dto.source,
    });

    return projectParticipantEntry(entry);
  }

  async updateEntry(
    user: User,
    idOrSlug: string,
    entryId: string,
    dto: UpdateProgrammeEntryDto,
  ) {
    const programme = await this.findProgrammeRow(idOrSlug);
    const entry = await this.prisma.programmeEntry.findFirst({
      where: {
        id: entryId,
        programmeId: programme.id,
        participantId: user.id,
      },
      include: entryWithIdeaInclude,
    });
    if (!entry) {
      throw new NotFoundException({
        code: 'ENTRY_NOT_FOUND',
        message: 'That entry does not exist.',
      });
    }
    if (!EDITABLE.includes(entry.status)) {
      throw new ConflictException({
        code: 'ENTRY_NOT_EDITABLE',
        message:
          entry.status === 'SUBMITTED'
            ? 'This entry has been submitted. Its judging snapshot cannot be edited.'
            : 'This entry can no longer be edited.',
      });
    }
    if (entry.status === 'DRAFT' && !programme.allowDraftEditing) {
      throw new ConflictException({
        code: 'DRAFT_EDITING_DISABLED',
        message: 'This programme does not allow draft editing.',
      });
    }

    const content = dto.content
      ? { ...asContent(entry.content), ...dto.content }
      : asContent(entry.content);

    this.assertContentLinks(programme, content);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.teamMembers !== undefined) {
        await tx.programmeEntryTeamMember.deleteMany({ where: { entryId } });
      }
      return tx.programmeEntry.update({
        where: { id: entryId },
        data: {
          ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
          ...(dto.category !== undefined ? { category: dto.category.trim() } : {}),
          ...(dto.content !== undefined
            ? { content: content as Prisma.InputJsonValue }
            : {}),
          ...(dto.teamMembers !== undefined
            ? {
                teamMembers: {
                  create: dto.teamMembers.map((member) => ({ ...member })),
                },
              }
            : {}),
        },
        include: entryWithIdeaInclude,
      });
    });

    await this.recordAudit(programme.id, user.id, 'entry.updated', {
      entryId,
      fields: Object.keys(dto).filter((key) => key !== 'teamMembers'),
      teamMembersChanged: dto.teamMembers !== undefined,
    });

    return projectParticipantEntry(updated);
  }

  async submitEntry(
    user: User,
    idOrSlug: string,
    entryId: string,
    dto: SubmitProgrammeEntryDto,
  ) {
    const programme = await this.findProgrammeRow(idOrSlug);
    const entry = await this.prisma.programmeEntry.findFirst({
      where: {
        id: entryId,
        programmeId: programme.id,
        participantId: user.id,
      },
      include: entryWithIdeaInclude,
    });
    if (!entry) {
      throw new NotFoundException({
        code: 'ENTRY_NOT_FOUND',
        message: 'That entry does not exist.',
      });
    }

    // Submitting twice is idempotent: the caller gets the snapshot already on
    // record, never a second version or a second notification. A rejected,
    // disqualified or withdrawn entry is not a successful resubmission.
    if (entry.status !== 'DRAFT' && entry.status !== 'CHANGES_REQUESTED') {
      const alreadySubmitted =
        ['SUBMITTED', 'UNDER_REVIEW', 'SHORTLISTED', 'ACCEPTED'].includes(
          entry.status,
        ) &&
        entry.submittedAt !== null &&
        entry.submittedSnapshot !== null;
      if (alreadySubmitted) {
        return projectParticipantEntry(entry);
      }
      throw new ConflictException({
        code: 'ENTRY_NOT_SUBMITTABLE',
        message: 'This entry cannot be submitted from its current state.',
      });
    }

    if (dto.confirmOriginalWork === false) {
      throw new BadRequestException({
        code: 'ORIGINAL_WORK_NOT_CONFIRMED',
        message: 'Confirm that the submission is your own work before submitting.',
      });
    }

    const registration = programme.registrationRequired
      ? await this.prisma.programmeRegistration.findUnique({
          where: {
            programmeId_userId: { programmeId: programme.id, userId: user.id },
          },
        })
      : null;

    if (programme.registrationRequired && registration?.status !== 'ELIGIBLE') {
      throw ineligible([
        {
          code: 'REGISTRATION_REQUIRED',
          message: 'Register for this programme before submitting an entry.',
        },
      ]);
    }

    if (programme.requireEmailVerified && !user.emailVerified) {
      throw ineligible([
        {
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Verify your email address before submitting.',
          field: 'email',
        },
      ]);
    }

    const content = asContent(entry.content);
    this.assertContentLinks(programme, content);

    const evaluation = evaluateSubmission({
      now: new Date(),
      programme: {
        ...programme,
        customQuestions: customQuestionsOf(programme),
      },
      entry: {
        status: entry.status,
        title: entry.title,
        category: entry.category,
        content,
        submittedAt: entry.submittedAt,
      },
      attachmentsCount: Array.isArray(content.attachments)
        ? content.attachments.length
        : 0,
      teamSize: entry.teamMembers.length,
    });
    if (!evaluation.eligible) throw ineligible(evaluation.issues);

    const now = new Date();
    const version = entry.submissionVersion + 1;
    const snapshot = this.buildSnapshot(entry, content, version, now);

    const updated = await this.prisma.$transaction(async (tx) => {
      // Compare-and-set: two concurrent submits must produce one version, not
      // two increments of the same entry. The loser reads the winner's result
      // and returns it as the idempotent response.
      const claimed = await tx.programmeEntry.updateMany({
        where: {
          id: entry.id,
          submissionVersion: entry.submissionVersion,
          status: { in: ['DRAFT', 'CHANGES_REQUESTED'] },
        },
        data: {
          status: 'SUBMITTED',
          submittedSnapshot: snapshot as Prisma.InputJsonValue,
          submissionVersion: version,
          submittedAt: now,
          withdrawnAt: null,
        },
      });

      if (claimed.count === 0) {
        return {
          raced: true as const,
          entry: await tx.programmeEntry.findUniqueOrThrow({
            where: { id: entry.id },
            include: entryWithIdeaInclude,
          }),
        };
      }

      await tx.programmeAuditEvent.create({
        data: {
          programmeId: programme.id,
          actorId: user.id,
          action: 'entry.submitted',
          target: entry.id,
          after: {
            version,
            title: entry.title,
            category: entry.category,
          },
        },
      });

      return {
        raced: false as const,
        entry: await tx.programmeEntry.findUniqueOrThrow({
          where: { id: entry.id },
          include: entryWithIdeaInclude,
        }),
      };
    });

    if (updated.raced) {
      if (
        ['SUBMITTED', 'UNDER_REVIEW', 'SHORTLISTED', 'ACCEPTED'].includes(
          updated.entry.status,
        ) &&
        updated.entry.submittedSnapshot !== null
      ) {
        return projectParticipantEntry(updated.entry);
      }
      throw new ConflictException({
        code: 'ENTRY_NOT_SUBMITTABLE',
        message: 'This entry changed while it was being submitted. Reload and try again.',
      });
    }

    await this.notifications.notify({
      toUserId: user.id,
      template: 'PROGRAMME_ENTRY_SUBMITTED',
      data: {
        programmeTitle: programme.title,
        programmeSlug: programme.slug,
        entryTitle: entry.title,
        version,
        judgingEndsAt: programme.judgingEndsAt.toISOString(),
      },
      dedupeKey: `programme:${programme.id}:entry:${entry.id}:submitted:${version}`,
    });

    return projectParticipantEntry(updated.entry);
  }

  async withdrawEntry(
    user: User,
    idOrSlug: string,
    entryId: string,
    dto: WithdrawProgrammeEntryDto,
  ) {
    const programme = await this.findProgrammeRow(idOrSlug);
    if (!programme.allowWithdrawal) {
      throw new ConflictException({
        code: 'WITHDRAWAL_DISABLED',
        message: 'This programme does not allow entries to be withdrawn.',
      });
    }
    if (new Date() >= programme.judgingStartsAt) {
      throw new ConflictException({
        code: 'WITHDRAWAL_CLOSED',
        message: 'Judging has started, so the entry can no longer be withdrawn.',
      });
    }

    const entry = await this.prisma.programmeEntry.findFirst({
      where: {
        id: entryId,
        programmeId: programme.id,
        participantId: user.id,
      },
      include: entryWithIdeaInclude,
    });
    if (!entry) {
      throw new NotFoundException({
        code: 'ENTRY_NOT_FOUND',
        message: 'That entry does not exist.',
      });
    }
    if (entry.status === WITHDRAWN) {
      return projectParticipantEntry(entry);
    }
    if (entry.status === 'REJECTED' || entry.status === 'DISQUALIFIED') {
      throw new ConflictException({
        code: 'ENTRY_NOT_WITHDRAWABLE',
        message: 'This entry can no longer be withdrawn.',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.programmeEntry.update({
        where: { id: entry.id },
        data: { status: WITHDRAWN, withdrawnAt: new Date() },
        include: entryWithIdeaInclude,
      });
      await tx.programmeAuditEvent.create({
        data: {
          programmeId: programme.id,
          actorId: user.id,
          action: 'entry.withdrawn',
          target: entry.id,
          after: { reason: dto.reason ?? null },
        },
      });
      return result;
    });

    return projectParticipantEntry(updated);
  }

  async getMyEntry(userId: string, idOrSlug: string, entryId: string) {
    const programme = await this.findProgrammeRow(idOrSlug);
    const entry = await this.prisma.programmeEntry.findFirst({
      where: {
        id: entryId,
        programmeId: programme.id,
        participantId: userId,
      },
      include: entryWithIdeaInclude,
    });
    if (!entry) {
      throw new NotFoundException({
        code: 'ENTRY_NOT_FOUND',
        message: 'That entry does not exist.',
      });
    }
    return projectParticipantEntry(entry);
  }

  /**
   * The judging snapshot is built from the entry and the idea at submission
   * time. Later edits to the idea never reach an already-submitted entry.
   */
  private buildSnapshot(
    entry: EntryWithIdea,
    content: Record<string, unknown>,
    version: number,
    now: Date,
  ): Record<string, unknown> {
    const idea = entry.idea as EntryWithIdea['idea'] & {
      problem?: string;
      solution?: string;
      targetUser?: string | null;
      currentAlternative?: string | null;
      taxonomyCategorySlug?: string | null;
      region?: string | null;
      demoUrl?: string | null;
      risks?: string | null;
      roadmapSteps?: Prisma.JsonValue | null;
      askAmount?: Prisma.Decimal;
    };

    return {
      version,
      submittedAt: now.toISOString(),
      title: entry.title,
      category: entry.category,
      source: entry.source,
      content,
      team: entry.teamMembers.map((member) => ({
        name: member.name,
        role: member.role ?? null,
      })),
      idea: {
        id: idea.id,
        slug: idea.slug,
        title: idea.title,
        problem: idea.problem ?? null,
        solution: idea.solution ?? null,
        targetUser: idea.targetUser ?? null,
        currentAlternative: idea.currentAlternative ?? null,
        category: idea.category,
        taxonomyCategorySlug: idea.taxonomyCategorySlug ?? null,
        region: idea.region ?? null,
        coverImageUrl: idea.coverImageUrl,
        demoUrl: idea.demoUrl ?? null,
        risks: idea.risks ?? null,
        roadmapSteps: idea.roadmapSteps ?? null,
        askAmount: idea.askAmount ? idea.askAmount.toString() : null,
        qualityScore: decimalToNumber(idea.qualityScore),
        supporterCount: idea.supporterCount,
      },
    };
  }

  private assertContentLinks(
    programme: ProgrammeRow,
    content: Record<string, unknown>,
  ): void {
    const attachments = content.attachments;
    if (attachments === undefined) return;
    if (!Array.isArray(attachments)) {
      throw new BadRequestException({
        code: 'INVALID_ATTACHMENTS',
        message: 'attachments must be an array of links.',
        issues: [{ code: 'INVALID_ATTACHMENTS', message: 'Expected an array.', field: 'attachments' }],
      });
    }
    if (attachments.length > programme.maxAttachments) {
      throw new BadRequestException({
        code: 'PROGRAMME_INELIGIBLE',
        message: 'This action does not meet the programme rules.',
        issues: [
          {
            code: 'TOO_MANY_ATTACHMENTS',
            message: `At most ${programme.maxAttachments} attachments are allowed.`,
            field: 'attachments',
          },
        ],
      });
    }

    const acceptedHosts = programme.acceptedLinkHosts.map((host) =>
      host.toLowerCase(),
    );
    if (acceptedHosts.length === 0) return;

    for (const [index, attachment] of attachments.entries()) {
      const url =
        typeof attachment === 'string'
          ? attachment
          : attachment !== null && typeof attachment === 'object'
            ? str((attachment as Record<string, unknown>).url)
            : '';
      let host: string;
      let protocol: string;
      try {
        const parsed = new URL(url);
        host = parsed.hostname.toLowerCase();
        protocol = parsed.protocol;
      } catch {
        throw new BadRequestException({
          code: 'INVALID_ATTACHMENT_URL',
          message: 'Every attachment must be a valid https link.',
          issues: [
            {
              code: 'INVALID_ATTACHMENT_URL',
              message: 'Expected a valid https link.',
              field: `attachments.${index}`,
            },
          ],
        });
      }
      if (protocol !== 'https:') {
        throw new BadRequestException({
          code: 'INVALID_ATTACHMENT_URL',
          message: 'Every attachment must use https.',
          issues: [
            {
              code: 'INVALID_ATTACHMENT_URL',
              message: 'Expected an https link.',
              field: `attachments.${index}`,
            },
          ],
        });
      }
      const allowed = acceptedHosts.some(
        (accepted) => host === accepted || host.endsWith(`.${accepted}`),
      );
      if (!allowed) {
        throw new BadRequestException({
          code: 'ATTACHMENT_HOST_NOT_ALLOWED',
          message: `Attachments must use one of: ${acceptedHosts.join(', ')}.`,
          issues: [
            {
              code: 'ATTACHMENT_HOST_NOT_ALLOWED',
              message: `The host ${host} is not accepted by this programme.`,
              field: `attachments.${index}`,
            },
          ],
        });
      }
    }
  }

  private async findProgrammeRow(idOrSlug: string): Promise<ProgrammeRow> {
    const programme = await this.prisma.programme.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: publicProgrammeInclude,
    });
    if (!programme) {
      throw new NotFoundException({
        code: 'PROGRAMME_NOT_FOUND',
        message: 'That programme does not exist.',
      });
    }
    return programme;
  }

  private async findPublicRecord(idOrSlug: string): Promise<PublicProgrammeRecord> {
    const programme = await this.findProgrammeRow(idOrSlug);
    if (programme.publishedAt === null || programme.status === 'DRAFT') {
      throw new NotFoundException({
        code: 'PROGRAMME_NOT_FOUND',
        message: 'That programme does not exist.',
      });
    }
    if (programme.status === 'ARCHIVED') {
      throw new NotFoundException({
        code: 'PROGRAMME_NOT_FOUND',
        message: 'That programme does not exist.',
      });
    }
    return programme;
  }

  private async recordAudit(
    programmeId: string,
    actorId: string,
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
