-- CreateEnum
CREATE TYPE "CampaignReviewStatus" AS ENUM ('NOT_SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CampaignReviewAction" AS ENUM ('APPROVE', 'REQUEST_CHANGES', 'REJECT');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "reviewReason" TEXT,
ADD COLUMN     "reviewStatus" "CampaignReviewStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CampaignReviewEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" "CampaignReviewAction" NOT NULL,
    "fromStatus" "CampaignReviewStatus" NOT NULL,
    "toStatus" "CampaignReviewStatus" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignReviewEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignReviewEvent_campaignId_createdAt_idx" ON "CampaignReviewEvent"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignReviewEvent_createdAt_idx" ON "CampaignReviewEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_applicationFeeChargeId_key" ON "Campaign"("applicationFeeChargeId");

-- CreateIndex
CREATE INDEX "Campaign_reviewStatus_submittedAt_idx" ON "Campaign"("reviewStatus", "submittedAt");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignReviewEvent" ADD CONSTRAINT "CampaignReviewEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignReviewEvent" ADD CONSTRAINT "CampaignReviewEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
