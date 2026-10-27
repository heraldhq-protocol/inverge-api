-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('INDIVIDUAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "VerificationType" AS ENUM ('INDIVIDUAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('NOT_STARTED', 'SESSION_CREATED', 'AWAITING_USER', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'DECLINED', 'ACTION_REQUIRED', 'EXPIRED', 'CANCELLED', 'ERROR');

-- CreateEnum
CREATE TYPE "VerificationProvider" AS ENUM ('DIDIT', 'STUB');

-- CreateEnum
CREATE TYPE "VerificationEventSource" AS ENUM ('PROVIDER_WEBHOOK', 'RECONCILIATION', 'ADMIN_ACTION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "RiskOutcome" AS ENUM ('NOT_ASSESSED', 'CLEAR', 'REVIEW', 'FLAGGED');

-- CreateEnum
CREATE TYPE "ContributionAuthorizationStatus" AS ENUM ('ALLOWED', 'BLOCKED');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'COMPLIANCE_REVIEWER';

-- AlterTable
ALTER TABLE "BusinessProfile" ADD COLUMN     "businessType" TEXT,
ADD COLUMN     "registeredAddress" TEXT,
ADD COLUMN     "representativeName" TEXT,
ADD COLUMN     "representativeRole" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accountType" "AccountType" NOT NULL DEFAULT 'INDIVIDUAL';

-- CreateTable
CREATE TABLE "VerificationCase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessId" TEXT,
    "type" "VerificationType" NOT NULL,
    "provider" "VerificationProvider" NOT NULL,
    "providerSessionId" TEXT NOT NULL,
    "providerWorkflowId" TEXT,
    "providerStatus" TEXT,
    "status" "VerificationStatus" NOT NULL DEFAULT 'SESSION_CREATED',
    "decisionCode" TEXT,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "riskOutcome" "RiskOutcome" NOT NULL DEFAULT 'NOT_ASSESSED',
    "riskReasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiresHumanReview" BOOLEAN NOT NULL DEFAULT false,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "lastProviderSyncAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationEvent" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "previousStatus" "VerificationStatus",
    "newStatus" "VerificationStatus",
    "source" "VerificationEventSource" NOT NULL,
    "providerEventReference" TEXT,
    "actorId" TEXT,
    "reasonCode" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContributionAuthorization" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "amountUsd" DECIMAL(14,2) NOT NULL,
    "thresholdUsd" DECIMAL(14,2) NOT NULL,
    "cumulativeUsd" DECIMAL(14,2) NOT NULL,
    "status" "ContributionAuthorizationStatus" NOT NULL DEFAULT 'ALLOWED',
    "verificationRequired" BOOLEAN NOT NULL DEFAULT false,
    "blockedReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContributionAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VerificationCase_providerSessionId_key" ON "VerificationCase"("providerSessionId");

-- CreateIndex
CREATE INDEX "VerificationCase_userId_type_createdAt_idx" ON "VerificationCase"("userId", "type", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "VerificationCase_businessId_createdAt_idx" ON "VerificationCase"("businessId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "VerificationCase_status_updatedAt_idx" ON "VerificationCase"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "VerificationCase_riskOutcome_updatedAt_idx" ON "VerificationCase"("riskOutcome", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationEvent_providerEventReference_key" ON "VerificationEvent"("providerEventReference");

-- CreateIndex
CREATE INDEX "VerificationEvent_caseId_createdAt_idx" ON "VerificationEvent"("caseId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "VerificationEvent_source_createdAt_idx" ON "VerificationEvent"("source", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "VerificationEvent_actorId_createdAt_idx" ON "VerificationEvent"("actorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ContributionAuthorization_userId_status_expiresAt_idx" ON "ContributionAuthorization"("userId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "ContributionAuthorization_campaignId_createdAt_idx" ON "ContributionAuthorization"("campaignId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "VerificationCase" ADD CONSTRAINT "VerificationCase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationCase" ADD CONSTRAINT "VerificationCase_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "BusinessProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationEvent" ADD CONSTRAINT "VerificationEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "VerificationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionAuthorization" ADD CONSTRAINT "ContributionAuthorization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionAuthorization" ADD CONSTRAINT "ContributionAuthorization_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

