-- CreateEnum
CREATE TYPE "DiscoverabilityTier" AS ENUM ('LINK_ONLY', 'DISCOVERABLE', 'FEATURED');

-- AlterTable
ALTER TABLE "Idea" ADD COLUMN     "askBreakdown" JSONB,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "currentAlternative" TEXT,
ADD COLUMN     "discoverabilityTier" "DiscoverabilityTier" NOT NULL DEFAULT 'LINK_ONLY',
ADD COLUMN     "qualityScore" DECIMAL(5,4),
ADD COLUMN     "qualityScoredAt" TIMESTAMP(3),
ADD COLUMN     "roadmapSteps" JSONB,
ADD COLUMN     "targetUser" TEXT;

-- CreateTable
CREATE TABLE "IdeaQualityReport" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "score" DECIMAL(5,4) NOT NULL,
    "checks" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdeaQualityReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdeaQualityReport_ideaId_computedAt_idx" ON "IdeaQualityReport"("ideaId", "computedAt");

-- CreateIndex
CREATE INDEX "Idea_discoverabilityTier_idx" ON "Idea"("discoverabilityTier");

-- AddForeignKey
ALTER TABLE "IdeaQualityReport" ADD CONSTRAINT "IdeaQualityReport_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

