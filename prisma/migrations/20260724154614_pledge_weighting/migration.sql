-- CreateEnum
CREATE TYPE "VerificationTier" AS ENUM ('EMAIL', 'SOCIAL', 'VERIFIED');

-- AlterTable
ALTER TABLE "Idea" ADD COLUMN     "creatorPrePledgeTarget" DECIMAL(14,2),
ADD COLUMN     "validatingSince" TIMESTAMP(3),
ADD COLUMN     "weightedPrePledgeTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "windowRenewedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "IdeaSignal" ADD COLUMN     "amountUsd" DECIMAL(14,2),
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bannedAt" TIMESTAMP(3),
ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "oauthSubject" TEXT;

-- CreateTable
CREATE TABLE "IdeaMetricSnapshot" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "weightedTotal" DECIMAL(14,2) NOT NULL,
    "supporterCount" INTEGER NOT NULL,

    CONSTRAINT "IdeaMetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdeaMetricSnapshot_ideaId_capturedAt_idx" ON "IdeaMetricSnapshot"("ideaId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_oauthSubject_key" ON "User"("oauthSubject");

-- AddForeignKey
ALTER TABLE "IdeaMetricSnapshot" ADD CONSTRAINT "IdeaMetricSnapshot_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

