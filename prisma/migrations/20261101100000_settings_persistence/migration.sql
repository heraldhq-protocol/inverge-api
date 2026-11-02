-- Settings persistence.
--
-- Adds public profile location, feed scope/promoted preference, notification
-- delivery preferences, and auditable data-export/deletion requests. Email
-- verification and its challenge table already exist on main.
--
-- Idempotent on purpose: a staging database that already received these
-- objects from the earlier duplicate migration must be able to converge
-- without a manual resolve step.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AccountRequestType" AS ENUM ('DATA_EXPORT', 'ACCOUNT_DELETION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AccountRequestStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "CreatorProfile" ADD COLUMN IF NOT EXISTS "location" TEXT;

-- AlterTable
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "feedRegion" TEXT NOT NULL DEFAULT 'global',
ADD COLUMN IF NOT EXISTS "feedShowPromoted" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "notifyEmailUpdates" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "notifyMilestoneReviews" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "notifyCreatorUpdates" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "notifyDiscoveryDigest" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "suppressedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AccountRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "AccountRequestType" NOT NULL,
    "status" "AccountRequestStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AccountRequest_userId_createdAt_idx" ON "AccountRequest"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AccountRequest_status_createdAt_idx" ON "AccountRequest"("status", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "AccountRequest" ADD CONSTRAINT "AccountRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
