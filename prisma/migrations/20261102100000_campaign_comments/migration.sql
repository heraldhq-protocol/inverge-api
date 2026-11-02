-- AlterTable
ALTER TABLE "ModerationCase" ADD COLUMN     "campaignId" TEXT;

-- CreateTable
CREATE TABLE "CampaignComment" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignComment_campaignId_createdAt_id_idx" ON "CampaignComment"("campaignId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "CampaignComment_userId_idx" ON "CampaignComment"("userId");

-- CreateIndex
CREATE INDEX "ModerationCase_campaignId_idx" ON "ModerationCase"("campaignId");

-- AddForeignKey
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignComment" ADD CONSTRAINT "CampaignComment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignComment" ADD CONSTRAINT "CampaignComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

