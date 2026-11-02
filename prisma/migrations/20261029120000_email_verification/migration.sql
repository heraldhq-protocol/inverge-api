-- Email verification for account emails.
--
-- The existing "User_email_key" unique index is case-sensitive. Emails are
-- therefore stored lower-case and a CHECK constraint makes that a database
-- invariant, so the same unique index also prevents case-insensitive duplicates
-- without storing a second normalised copy of the address.
--
-- The UPDATE below intentionally fails if legacy rows collide after normalising
-- (for example "A@x.com" and "a@x.com"). Accounts are never merged automatically;
-- resolve the conflicts listed in docs/email-verification.md and re-run.

-- CreateEnum
CREATE TYPE "EmailVerificationPurpose" AS ENUM ('SIGNUP', 'CHANGE');

-- AlterTable
ALTER TABLE "User"
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "pendingEmail" TEXT,
ADD COLUMN     "pendingEmailRequestedAt" TIMESTAMP(3);

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

-- Normalise existing addresses before the CHECK constraint is added. This will
-- abort on a case-insensitive duplicate; that is deliberate (no silent merges).
UPDATE "User"
SET "email" = lower(btrim("email"))
WHERE "email" IS NOT NULL;

-- The legacy boolean was a manual assertion, never written by application code.
-- Preserve it as a timestamp at the last update, which is the only evidence the
-- row carries. New writes set both fields in one transaction.
UPDATE "User"
SET "emailVerifiedAt" = "updatedAt"
WHERE "emailVerified" = true AND "email" IS NOT NULL;

-- Database-level normalisation invariant: every stored address is lower-case and
-- trimmed, so the existing unique index is effectively case-insensitive.
ALTER TABLE "User"
ADD CONSTRAINT "User_email_normalized_check"
CHECK ("email" IS NULL OR "email" = lower(btrim("email")));

ALTER TABLE "User"
ADD CONSTRAINT "User_pending_email_normalized_check"
CHECK ("pendingEmail" IS NULL OR "pendingEmail" = lower(btrim("pendingEmail")));

-- CreateIndex
CREATE INDEX "EmailVerificationChallenge_userId_purpose_createdAt_idx"
ON "EmailVerificationChallenge"("userId", "purpose", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "EmailVerificationChallenge_email_createdAt_idx"
ON "EmailVerificationChallenge"("email", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "EmailVerificationChallenge"
ADD CONSTRAINT "EmailVerificationChallenge_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
