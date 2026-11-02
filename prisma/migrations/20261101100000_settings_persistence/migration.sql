-- Settings persistence.
--
-- Adds public profile location, feed scope/promoted preference, notification
-- delivery preferences, and auditable data-export/deletion requests. Email
-- verification and its challenge table already exist on main.

-- CreateEnum
CREATE TYPE "AccountRequestType" AS ENUM ('DATA_EXPORT', 'ACCOUNT_DELETION');

-- CreateEnum
CREATE TYPE "AccountRequestStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "CreatorProfile" ADD COLUMN "location" TEXT;

-- AlterTable
ALTER TABLE "User"
ADD COLUMN     "feedRegion" TEXT NOT NULL DEFAULT 'global',
ADD COLUMN     "feedShowPromoted" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyEmailUpdates" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyMilestoneReviews" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyCreatorUpdates" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyDiscoveryDigest" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "suppressedAt" TIMESTAMP(3);

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

-- CreateIndex
CREATE INDEX "AccountRequest_userId_createdAt_idx" ON "AccountRequest"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AccountRequest_status_createdAt_idx" ON "AccountRequest"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "AccountRequest" ADD CONSTRAINT "AccountRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
