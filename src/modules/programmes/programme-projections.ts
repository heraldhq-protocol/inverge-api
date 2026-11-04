import { Prisma } from '../../generated/prisma/client';
import { isPrizeAdvertisable } from './programme-config';
import { deriveProgrammePhase } from './programme-eligibility';

/**
 * Public and role-specific projections.
 *
 * Every field a caller can see is chosen here, explicitly. A new column on the
 * Prisma model never leaks by accident: the controller returns one of these
 * shapes, not a spread of the row. Draft entries, moderator notes, private judge
 * comments and unpublished results are absent by construction.
 */

export const publicProgrammeInclude = {
  prizes: { orderBy: { placement: 'asc' } },
  sponsors: { orderBy: { createdAt: 'asc' } },
  announcements: {
    where: { publishedAt: { not: null } },
    orderBy: { publishedAt: 'desc' },
  },
  resultPublications: {
    orderBy: { revision: 'desc' },
    take: 1,
  },
  _count: { select: { entries: { where: { status: { not: 'DRAFT' } } } } },
} satisfies Prisma.ProgrammeInclude;

export type PublicProgrammeRecord = Prisma.ProgrammeGetPayload<{
  include: typeof publicProgrammeInclude;
}>;

export const adminProgrammeInclude = {
  prizes: { orderBy: { placement: 'asc' } },
  sponsors: { orderBy: { createdAt: 'asc' } },
  announcements: { orderBy: { createdAt: 'desc' } },
  resultPublications: { orderBy: { revision: 'desc' }, take: 1 },
  judges: {
    include: { judge: { select: { id: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  },
  _count: {
    select: {
      entries: true,
      registrations: true,
      evaluations: true,
    },
  },
} satisfies Prisma.ProgrammeInclude;

export type AdminProgrammeRecord = Prisma.ProgrammeGetPayload<{
  include: typeof adminProgrammeInclude;
}>;

export const entryWithIdeaInclude = {
  idea: {
    select: {
      id: true,
      title: true,
      slug: true,
      problem: true,
      solution: true,
      targetUser: true,
      currentAlternative: true,
      category: true,
      taxonomyCategorySlug: true,
      region: true,
      demoUrl: true,
      risks: true,
      roadmapSteps: true,
      askAmount: true,
      status: true,
      coverImageUrl: true,
      qualityScore: true,
      supporterCount: true,
      creatorId: true,
    },
  },
  teamMembers: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.ProgrammeEntryInclude;

export type EntryWithIdea = Prisma.ProgrammeEntryGetPayload<{
  include: typeof entryWithIdeaInclude;
}>;

export const judgeEntryInclude = {
  ...entryWithIdeaInclude,
  evaluations: {
    select: {
      id: true,
      judgeId: true,
      status: true,
      scores: true,
      weightedScore: true,
      privateComment: true,
      participantFeedback: true,
      revision: true,
      submittedAt: true,
    },
  },
  judgeConflicts: {
    select: {
      reason: true,
      declaredAt: true,
      judge: { select: { judgeId: true } },
    },
  },
} satisfies Prisma.ProgrammeEntryInclude;

export type JudgeEntry = Prisma.ProgrammeEntryGetPayload<{
  include: typeof judgeEntryInclude;
}>;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function decimal(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value.toNumber();
}

function asRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: Prisma.JsonValue | null | undefined): unknown[] {
  return Array.isArray(value) ? value : [];
}

export type PublicProgramme = ReturnType<typeof projectPublicProgramme>;
export type PublicProgrammeEntry = ReturnType<typeof projectPublicEntry>;
export type ParticipantEntry = ReturnType<typeof projectParticipantEntry>;
export type JudgeEntryProjection = ReturnType<typeof projectJudgeEntry>;

export function projectPublicProgramme(
  record: PublicProgrammeRecord,
  now: Date,
) {
  const phase = deriveProgrammePhase(record, now);
  const publication =
    record.resultsVisibility === 'PUBLIC'
      ? (record.resultPublications[0] ?? null)
      : null;

  return {
    id: record.id,
    slug: record.slug,
    type: record.type,
    status: record.status,
    phase,
    title: record.title,
    tagline: record.tagline,
    description: record.description,
    category: record.category,
    organiser: record.organiser,
    heroCopy: record.heroCopy,
    timezone: record.timezone,
    timeline: {
      registrationOpensAt: record.registrationOpensAt.toISOString(),
      registrationClosesAt: record.registrationClosesAt.toISOString(),
      submissionOpensAt: record.submissionOpensAt.toISOString(),
      submissionClosesAt: record.submissionClosesAt.toISOString(),
      judgingStartsAt: record.judgingStartsAt.toISOString(),
      judgingEndsAt: record.judgingEndsAt.toISOString(),
      resultsAt: record.resultsAt.toISOString(),
    },
    rules: record.rules,
    faqs: asArray(record.faqs),
    assets: asArray(record.assets),
    modules: asArray(record.modules),
    entryPolicy: {
      entryMode: record.entryMode,
      registrationRequired: record.registrationRequired,
      allowedCategories: record.allowedCategories,
      minQualityScore: decimal(record.minQualityScore),
      allowMultipleEntries: record.allowMultipleEntries,
      maxEntriesPerParticipant: record.maxEntriesPerParticipant,
      allowTeams: record.allowTeams,
      teamMinSize: record.teamMinSize,
      teamMaxSize: record.teamMaxSize,
      requiredFields: record.requiredFields,
      customQuestions: asArray(record.customQuestions),
      maxAttachments: record.maxAttachments,
      allowWithdrawal: record.allowWithdrawal,
      lateEntriesAllowed: record.lateEntriesAllowed,
    },
    judging: {
      method: record.judgingMethod,
      communityWeight: record.communityWeight,
      judgeWeight: record.judgeWeight,
      rubric: record.judgingMethod === 'COMMUNITY' ? [] : asArray(record.rubric),
      minimumEvaluations: record.minimumEvaluations,
      missingEvaluationPolicy: record.missingEvaluationPolicy,
      tieBreak: asArray(record.tieBreak),
    },
    prizes: record.prizes
      .filter(isPrizeAdvertisable)
      .map((prize) => ({
        id: prize.id,
        placement: prize.placement,
        title: prize.title,
        description: prize.description,
        kind: prize.kind,
        amountAtomic: prize.kind === 'NON_CASH' ? null : prize.amountAtomic,
        currency: prize.currency,
        decimals: prize.decimals,
        awardCriteria: prize.awardCriteria,
        eligibility: prize.eligibility,
      })),
    sponsors: record.sponsors.map((sponsor) => ({
      id: sponsor.id,
      name: sponsor.name,
      tier: sponsor.tier,
      website: sponsor.website,
      logoUrl: sponsor.logoUrl,
    })),
    announcements: record.announcements.map((announcement) => ({
      id: announcement.id,
      title: announcement.title,
      body: announcement.body,
      publishedAt: announcement.publishedAt?.toISOString() ?? null,
    })),
    entryCount: record._count.entries,
    results: publication
      ? {
          revision: publication.revision,
          checksum: publication.checksum,
          publishedAt: publication.publishedAt.toISOString(),
          standings: publication.standings,
          methodology: publication.methodology,
          notes: publication.notes,
        }
      : null,
  };
}

export function projectPublicEntry(entry: EntryWithIdea) {
  const snapshot = entry.submittedSnapshot;
  return {
    id: entry.id,
    title: entry.title,
    category: entry.category,
    source: entry.source,
    submittedAt: iso(entry.submittedAt),
    snapshot,
    idea: {
      id: entry.idea.id,
      title: entry.idea.title,
      slug: entry.idea.slug,
      coverImageUrl: entry.idea.coverImageUrl,
    },
    team: entry.teamMembers.map((member) => ({
      name: member.name,
      role: member.role,
    })),
  };
}

export function projectParticipantEntry(entry: EntryWithIdea) {
  return {
    id: entry.id,
    programmeId: entry.programmeId,
    status: entry.status,
    title: entry.title,
    category: entry.category,
    source: entry.source,
    content: asRecord(entry.content),
    submittedSnapshot: entry.submittedSnapshot,
    submissionVersion: entry.submissionVersion,
    submittedAt: iso(entry.submittedAt),
    withdrawnAt: iso(entry.withdrawnAt),
    curatedRank: entry.curatedRank,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    teamMembers: entry.teamMembers.map((member) => ({
      id: member.id,
      name: member.name,
      email: member.email,
      role: member.role,
    })),
    idea: {
      id: entry.idea.id,
      title: entry.idea.title,
      slug: entry.idea.slug,
      status: entry.idea.status,
      coverImageUrl: entry.idea.coverImageUrl,
    },
    // A draft never exposes judging material, even to its author. Published
    // feedback is added by the results projection instead.
    latestFeedback: null,
  };
}

export function projectJudgeEntry(
  entry: JudgeEntry,
  judgeId: string,
) {
  const evaluation = entry.evaluations.find((row) => row.judgeId === judgeId);
  const conflict = entry.judgeConflicts.find(
    (row) => row.judge.judgeId === judgeId,
  );

  return {
    id: entry.id,
    title: entry.title,
    category: entry.category,
    source: entry.source,
    submittedAt: iso(entry.submittedAt),
    submissionVersion: entry.submissionVersion,
    snapshot: entry.submittedSnapshot,
    idea: {
      id: entry.idea.id,
      title: entry.idea.title,
      slug: entry.idea.slug,
      coverImageUrl: entry.idea.coverImageUrl,
    },
    team: entry.teamMembers.map((member) => ({
      name: member.name,
      role: member.role,
    })),
    conflict: conflict
      ? { declared: true, reason: conflict.reason, declaredAt: conflict.declaredAt.toISOString() }
      : { declared: false },
    evaluation: evaluation
      ? {
          id: evaluation.id,
          status: evaluation.status,
          scores: asRecord(evaluation.scores),
          weightedScore: decimal(evaluation.weightedScore),
          privateComment: evaluation.privateComment,
          participantFeedback: evaluation.participantFeedback,
          revision: evaluation.revision,
          submittedAt: iso(evaluation.submittedAt),
        }
      : null,
  };
}

export function projectAdminProgramme(record: AdminProgrammeRecord) {
  return {
    id: record.id,
    slug: record.slug,
    type: record.type,
    status: record.status,
    title: record.title,
    tagline: record.tagline,
    description: record.description,
    category: record.category,
    organiser: record.organiser,
    heroCopy: record.heroCopy,
    timezone: record.timezone,
    rules: record.rules,
    faqs: asArray(record.faqs),
    assets: asArray(record.assets),
    modules: asArray(record.modules),
    timeline: {
      registrationOpensAt: record.registrationOpensAt.toISOString(),
      registrationClosesAt: record.registrationClosesAt.toISOString(),
      submissionOpensAt: record.submissionOpensAt.toISOString(),
      submissionClosesAt: record.submissionClosesAt.toISOString(),
      judgingStartsAt: record.judgingStartsAt.toISOString(),
      judgingEndsAt: record.judgingEndsAt.toISOString(),
      resultsAt: record.resultsAt.toISOString(),
    },
    entryPolicy: {
      entryMode: record.entryMode,
      registrationRequired: record.registrationRequired,
      requireEmailVerified: record.requireEmailVerified,
      allowedCategories: record.allowedCategories,
      minQualityScore: decimal(record.minQualityScore),
      allowMultipleEntries: record.allowMultipleEntries,
      maxEntriesPerParticipant: record.maxEntriesPerParticipant,
      allowTeams: record.allowTeams,
      teamMinSize: record.teamMinSize,
      teamMaxSize: record.teamMaxSize,
      requiredFields: record.requiredFields,
      customQuestions: asArray(record.customQuestions),
      acceptedLinkHosts: record.acceptedLinkHosts,
      maxAttachments: record.maxAttachments,
      allowDraftEditing: record.allowDraftEditing,
      allowWithdrawal: record.allowWithdrawal,
      lateEntriesAllowed: record.lateEntriesAllowed,
    },
    judging: {
      method: record.judgingMethod,
      communityWeight: record.communityWeight,
      judgeWeight: record.judgeWeight,
      rubric: asArray(record.rubric),
      minimumEvaluations: record.minimumEvaluations,
      missingEvaluationPolicy: record.missingEvaluationPolicy,
      tieBreak: asArray(record.tieBreak),
      allowEvaluationRevision: record.allowEvaluationRevision,
      requireConflictDeclaration: record.requireConflictDeclaration,
    },
    resultsVisibility: record.resultsVisibility,
    prizes: record.prizes.map((prize) => ({
      id: prize.id,
      placement: prize.placement,
      title: prize.title,
      description: prize.description,
      kind: prize.kind,
      amountAtomic: prize.amountAtomic,
      currency: prize.currency,
      decimals: prize.decimals,
      awardCriteria: prize.awardCriteria,
      eligibility: prize.eligibility,
      fundingStatus: prize.fundingStatus,
      fulfilmentStatus: prize.fulfilmentStatus,
      fulfilmentOwner: prize.fulfilmentOwner,
    })),
    sponsors: record.sponsors.map((sponsor) => ({
      id: sponsor.id,
      name: sponsor.name,
      tier: sponsor.tier,
      website: sponsor.website,
      logoUrl: sponsor.logoUrl,
      deliverables: sponsor.deliverables,
      commitmentAtomic: sponsor.commitmentAtomic,
      currency: sponsor.currency,
      invoiceStatus: sponsor.invoiceStatus,
      confirmedByProvider: sponsor.confirmedByProvider,
    })),
    judges: record.judges.map((assignment) => ({
      id: assignment.id,
      judgeId: assignment.judgeId,
      email: assignment.judge.email,
      status: assignment.status,
      conflictDeclaration: assignment.conflictDeclaration,
      assignedAt: assignment.createdAt.toISOString(),
    })),
    announcements: record.announcements.map((announcement) => ({
      id: announcement.id,
      title: announcement.title,
      body: announcement.body,
      publishedAt: iso(announcement.publishedAt),
      createdAt: announcement.createdAt.toISOString(),
    })),
    counts: {
      entries: record._count.entries,
      registrations: record._count.registrations,
      evaluations: record._count.evaluations,
    },
    latestPublication: record.resultPublications[0]
      ? {
          revision: record.resultPublications[0].revision,
          checksum: record.resultPublications[0].checksum,
          publishedAt: record.resultPublications[0].publishedAt.toISOString(),
        }
      : null,
    version: record.version,
    publishedAt: iso(record.publishedAt),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function projectAdminEntry(entry: EntryWithIdea) {
  return {
    ...projectParticipantEntry(entry),
    participantId: entry.participantId,
    moderatorNote: entry.moderatorNote,
    ideaQualityScore: decimal(entry.idea.qualityScore),
    ideaSupporterCount: entry.idea.supporterCount,
  };
}
