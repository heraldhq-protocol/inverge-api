-- Settings persistence and email verification.
--
-- Adds public profile location, feed scope/promoted preference, notification
-- delivery preferences, account data/deletion requests, and the one-time email
-- ownership challenge used by the Resend-backed verification flow.
--
-- Existing rows get safe defaults. Email addresses are normalised to lower-case
-- so the existing unique index becomes effectively case-insensitive; the UPDATE
-- intentionally fails on a legacy case-variant duplicate rather than merging
-- accounts automatically.

-- CreateEnum
CREATE TYPE "AccountRequestType" AS ENUM ('DATA_EXPORT', 'ACCOUNT_DELETION');

-- CreateEnum
CREATE TYPE "AccountRequestStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EmailVerificationPurpose" AS ENUM ('SIGNUP', 'CHANGE');

-- AlterTable
ALTER TABLE "CreatorProfile" ADD COLUMN "location" TEXT;

-- AlterTable
ALTER TABLE "User"
ADD COLUMN     "feedRegion" TEXT NOT NULL DEFAULT 'global',
ADD COLUMN     "feedShowPromoted" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyEmailUpdates" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyMilestoneReviews" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyCreatorUpdates" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyDiscoveryDigest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "pendingEmail" TEXT,
ADD COLUMN     "pendingEmailRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "suppressedAt" TIMESTAMP(3);

-- Normalise existing addresses before the CHECK constraint is added.
UPDATE "User"
SET "email" = lower(btrim("email"))
WHERE "email" IS NOT NULL;

-- The legacy boolean was a manual assertion. Preserve it as a timestamp; new
-- writes set both fields in one transaction.
UPDATE "User"
SET "emailVerifiedAt" = "updatedAt"
WHERE "emailVerified" = true AND "email" IS NOT NULL;

ALTER TABLE "User"
ADD CONSTRAINT "User_email_normalized_check"
CHECK ("email" IS NULL OR "email" = lower(btrim("email")));

ALTER TABLE "User"
ADD CONSTRAINT "User_pending_email_normalized_check"
CHECK ("pendingEmail" IS NULL OR "pendingEmail" = lower(btrim("pendingEmail")));

-- CreateTable
CREATE TABLE "AccountRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "AccountRequestType" NOT NULL,
    "status" "AccountRequestStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailVerificationChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "EmailVerificationPurpose" NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "deliveryFailedAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountRequest_userId_createdAt_idx" ON "AccountRequest"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AccountRequest_status_createdAt_idx" ON "AccountRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EmailVerificationChallenge_userId_purpose_createdAt_idx"
ON "EmailVerificationChallenge"("userId", "purpose", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "EmailVerificationChallenge_email_createdAt_idx"
ON "EmailVerificationChallenge"("email", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AccountRequest" ADD CONSTRAINT "AccountRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailVerificationChallenge"
ADD CONSTRAINT "EmailVerificationChallenge_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
