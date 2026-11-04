-- CreateEnum
CREATE TYPE "ProgrammeType" AS ENUM ('MONTHLY_IDEATHON', 'SPONSORED_CHALLENGE', 'SHOWCASE', 'WORKSHOP', 'EXPERT_SESSION', 'OTHER');

-- CreateEnum
CREATE TYPE "ProgrammeStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'REGISTRATION_OPEN', 'SUBMISSION_OPEN', 'JUDGING', 'RESULTS_REVIEW', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProgrammeEntryMode" AS ENUM ('NEW_IDEAS_ONLY', 'EXISTING_IDEAS_ONLY', 'NEW_OR_EXISTING');

-- CreateEnum
CREATE TYPE "ProgrammeEntrySource" AS ENUM ('NEW_IDEA', 'EXISTING_IDEA');

-- CreateEnum
CREATE TYPE "ProgrammeRegistrationStatus" AS ENUM ('PENDING', 'ELIGIBLE', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ProgrammeEntryStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'SHORTLISTED', 'ACCEPTED', 'REJECTED', 'DISQUALIFIED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ProgrammeJudgingMethod" AS ENUM ('COMMUNITY', 'JUDGES', 'HYBRID', 'CURATED');

-- CreateEnum
CREATE TYPE "ProgrammeResultsVisibility" AS ENUM ('HIDDEN', 'PROVISIONAL', 'PUBLIC');

-- CreateEnum
CREATE TYPE "ProgrammeEvaluationStatus" AS ENUM ('DRAFT', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "ProgrammeJudgeStatus" AS ENUM ('INVITED', 'ACTIVE', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "ProgrammePrizeKind" AS ENUM ('CASH', 'NON_CASH', 'MIXED');

-- CreateEnum
CREATE TYPE "ProgrammePrizeFulfilment" AS ENUM ('UNCONFIRMED', 'COMMITTED', 'FUNDED', 'PROCESSING', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "ProgrammeSponsorInvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PENDING', 'PAID', 'OVERDUE', 'CANCELLED');

-- DropIndex
DROP INDEX "MediaAsset_creatorProfileUserId_idx";

-- CreateTable
CREATE TABLE "Programme" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "ProgrammeType" NOT NULL DEFAULT 'MONTHLY_IDEATHON',
    "status" "ProgrammeStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "organiser" TEXT NOT NULL,
    "heroCopy" TEXT NOT NULL DEFAULT '',
    "rules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "faqs" JSONB NOT NULL DEFAULT '[]',
    "assets" JSONB NOT NULL DEFAULT '[]',
    "modules" JSONB NOT NULL DEFAULT '[]',
    "registrationOpensAt" TIMESTAMP(3) NOT NULL,
    "registrationClosesAt" TIMESTAMP(3) NOT NULL,
    "submissionOpensAt" TIMESTAMP(3) NOT NULL,
    "submissionClosesAt" TIMESTAMP(3) NOT NULL,
    "judgingStartsAt" TIMESTAMP(3) NOT NULL,
    "judgingEndsAt" TIMESTAMP(3) NOT NULL,
    "resultsAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "entryMode" "ProgrammeEntryMode" NOT NULL DEFAULT 'NEW_OR_EXISTING',
    "registrationRequired" BOOLEAN NOT NULL DEFAULT true,
    "requireEmailVerified" BOOLEAN NOT NULL DEFAULT true,
    "allowedCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minQualityScore" DECIMAL(5,4),
    "allowMultipleEntries" BOOLEAN NOT NULL DEFAULT false,
    "maxEntriesPerParticipant" INTEGER NOT NULL DEFAULT 1,
    "allowTeams" BOOLEAN NOT NULL DEFAULT false,
    "teamMinSize" INTEGER NOT NULL DEFAULT 1,
    "teamMaxSize" INTEGER NOT NULL DEFAULT 4,
    "requiredFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customQuestions" JSONB NOT NULL DEFAULT '[]',
    "acceptedLinkHosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxAttachments" INTEGER NOT NULL DEFAULT 0,
    "allowDraftEditing" BOOLEAN NOT NULL DEFAULT true,
    "allowWithdrawal" BOOLEAN NOT NULL DEFAULT true,
    "lateEntriesAllowed" BOOLEAN NOT NULL DEFAULT false,
    "judgingMethod" "ProgrammeJudgingMethod" NOT NULL DEFAULT 'JUDGES',
    "communityWeight" INTEGER NOT NULL DEFAULT 0,
    "judgeWeight" INTEGER NOT NULL DEFAULT 100,
    "rubric" JSONB NOT NULL DEFAULT '[]',
    "minimumEvaluations" INTEGER NOT NULL DEFAULT 1,
    "missingEvaluationPolicy" TEXT NOT NULL DEFAULT 'EXCLUDE',
    "tieBreak" JSONB NOT NULL DEFAULT '[]',
    "resultsVisibility" "ProgrammeResultsVisibility" NOT NULL DEFAULT 'HIDDEN',
    "allowEvaluationRevision" BOOLEAN NOT NULL DEFAULT false,
    "requireConflictDeclaration" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Programme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeRegistration" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ProgrammeRegistrationStatus" NOT NULL DEFAULT 'ELIGIBLE',
    "eligibilityNote" TEXT,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgrammeRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeEntry" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "source" "ProgrammeEntrySource" NOT NULL,
    "status" "ProgrammeEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{}',
    "submittedSnapshot" JSONB,
    "submissionVersion" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "curatedRank" INTEGER,
    "moderatorNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgrammeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeEntryTeamMember" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgrammeEntryTeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeJudge" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "judgeId" TEXT NOT NULL,
    "status" "ProgrammeJudgeStatus" NOT NULL DEFAULT 'ACTIVE',
    "conflictDeclaration" TEXT,
    "assignedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgrammeJudge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeJudgeConflict" (
    "id" TEXT NOT NULL,
    "judgeId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgrammeJudgeConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeEvaluation" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "judgeId" TEXT NOT NULL,
    "status" "ProgrammeEvaluationStatus" NOT NULL DEFAULT 'DRAFT',
    "scores" JSONB NOT NULL DEFAULT '{}',
    "weightedScore" DECIMAL(7,2),
    "privateComment" TEXT,
    "participantFeedback" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgrammeEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeEvaluationRevision" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "scores" JSONB NOT NULL,
    "weightedScore" DECIMAL(7,2),
    "privateComment" TEXT,
    "participantFeedback" TEXT,
    "submittedAt" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgrammeEvaluationRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeResultPublication" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "standings" JSONB NOT NULL,
    "methodology" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "publishedBy" TEXT NOT NULL,
    "notes" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgrammeResultPublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammePrize" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "placement" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "ProgrammePrizeKind" NOT NULL DEFAULT 'NON_CASH',
    "amountAtomic" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "decimals" INTEGER NOT NULL DEFAULT 2,
    "awardCriteria" TEXT,
    "eligibility" TEXT,
    "fundingStatus" "ProgrammePrizeFulfilment" NOT NULL DEFAULT 'UNCONFIRMED',
    "fulfilmentStatus" "ProgrammePrizeFulfilment" NOT NULL DEFAULT 'UNCONFIRMED',
    "fulfilmentOwner" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgrammePrize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeSponsor" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'partner',
    "website" TEXT,
    "logoUrl" TEXT,
    "deliverables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "commitmentAtomic" TEXT NOT NULL DEFAULT '0',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "invoiceStatus" "ProgrammeSponsorInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "confirmedByProvider" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgrammeSponsor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeAnnouncement" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgrammeAnnouncement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeAuditEvent" (
    "id" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgrammeAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Programme_slug_key" ON "Programme"("slug");

-- CreateIndex
CREATE INDEX "Programme_status_type_submissionClosesAt_idx" ON "Programme"("status", "type", "submissionClosesAt");

-- CreateIndex
CREATE INDEX "Programme_status_publishedAt_idx" ON "Programme"("status", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "Programme_createdBy_createdAt_idx" ON "Programme"("createdBy", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ProgrammeRegistration_programmeId_status_registeredAt_idx" ON "ProgrammeRegistration"("programmeId", "status", "registeredAt");

-- CreateIndex
CREATE INDEX "ProgrammeRegistration_userId_registeredAt_idx" ON "ProgrammeRegistration"("userId", "registeredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ProgrammeRegistration_programmeId_userId_key" ON "ProgrammeRegistration"("programmeId", "userId");

-- CreateIndex
CREATE INDEX "ProgrammeEntry_programmeId_status_submittedAt_idx" ON "ProgrammeEntry"("programmeId", "status", "submittedAt");

-- CreateIndex
CREATE INDEX "ProgrammeEntry_participantId_updatedAt_idx" ON "ProgrammeEntry"("participantId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "ProgrammeEntry_ideaId_idx" ON "ProgrammeEntry"("ideaId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgrammeEntry_programmeId_participantId_ideaId_key" ON "ProgrammeEntry"("programmeId", "participantId", "ideaId");

-- CreateIndex
CREATE INDEX "ProgrammeEntryTeamMember_entryId_idx" ON "ProgrammeEntryTeamMember"("entryId");

-- CreateIndex
CREATE INDEX "ProgrammeJudge_judgeId_status_idx" ON "ProgrammeJudge"("judgeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProgrammeJudge_programmeId_judgeId_key" ON "ProgrammeJudge"("programmeId", "judgeId");

-- CreateIndex
CREATE INDEX "ProgrammeJudgeConflict_entryId_idx" ON "ProgrammeJudgeConflict"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgrammeJudgeConflict_judgeId_entryId_key" ON "ProgrammeJudgeConflict"("judgeId", "entryId");

-- CreateIndex
CREATE INDEX "ProgrammeEvaluation_programmeId_status_idx" ON "ProgrammeEvaluation"("programmeId", "status");

-- CreateIndex
CREATE INDEX "ProgrammeEvaluation_judgeId_status_idx" ON "ProgrammeEvaluation"("judgeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProgrammeEvaluation_entryId_judgeId_key" ON "ProgrammeEvaluation"("entryId", "judgeId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgrammeEvaluationRevision_evaluationId_revision_key" ON "ProgrammeEvaluationRevision"("evaluationId", "revision");

-- CreateIndex
CREATE INDEX "ProgrammeResultPublication_programmeId_publishedAt_idx" ON "ProgrammeResultPublication"("programmeId", "publishedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ProgrammeResultPublication_programmeId_revision_key" ON "ProgrammeResultPublication"("programmeId", "revision");

-- CreateIndex
CREATE INDEX "ProgrammePrize_programmeId_placement_idx" ON "ProgrammePrize"("programmeId", "placement");

-- CreateIndex
CREATE INDEX "ProgrammeSponsor_programmeId_idx" ON "ProgrammeSponsor"("programmeId");

-- CreateIndex
CREATE INDEX "ProgrammeAnnouncement_programmeId_publishedAt_idx" ON "ProgrammeAnnouncement"("programmeId", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "ProgrammeAuditEvent_programmeId_createdAt_idx" ON "ProgrammeAuditEvent"("programmeId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ProgrammeAuditEvent_actorId_createdAt_idx" ON "ProgrammeAuditEvent"("actorId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Programme" ADD CONSTRAINT "Programme_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeRegistration" ADD CONSTRAINT "ProgrammeRegistration_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeRegistration" ADD CONSTRAINT "ProgrammeRegistration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeEntry" ADD CONSTRAINT "ProgrammeEntry_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeEntry" ADD CONSTRAINT "ProgrammeEntry_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeEntry" ADD CONSTRAINT "ProgrammeEntry_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeEntryTeamMember" ADD CONSTRAINT "ProgrammeEntryTeamMember_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "ProgrammeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeJudge" ADD CONSTRAINT "ProgrammeJudge_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeJudge" ADD CONSTRAINT "ProgrammeJudge_judgeId_fkey" FOREIGN KEY ("judgeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeJudgeConflict" ADD CONSTRAINT "ProgrammeJudgeConflict_judgeId_fkey" FOREIGN KEY ("judgeId") REFERENCES "ProgrammeJudge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeJudgeConflict" ADD CONSTRAINT "ProgrammeJudgeConflict_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "ProgrammeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeEvaluation" ADD CONSTRAINT "ProgrammeEvaluation_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeEvaluation" ADD CONSTRAINT "ProgrammeEvaluation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "ProgrammeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeEvaluation" ADD CONSTRAINT "ProgrammeEvaluation_judgeId_fkey" FOREIGN KEY ("judgeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeEvaluationRevision" ADD CONSTRAINT "ProgrammeEvaluationRevision_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "ProgrammeEvaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeResultPublication" ADD CONSTRAINT "ProgrammeResultPublication_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeResultPublication" ADD CONSTRAINT "ProgrammeResultPublication_publishedBy_fkey" FOREIGN KEY ("publishedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammePrize" ADD CONSTRAINT "ProgrammePrize_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeSponsor" ADD CONSTRAINT "ProgrammeSponsor_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeAnnouncement" ADD CONSTRAINT "ProgrammeAnnouncement_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeAuditEvent" ADD CONSTRAINT "ProgrammeAuditEvent_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgrammeAuditEvent" ADD CONSTRAINT "ProgrammeAuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
