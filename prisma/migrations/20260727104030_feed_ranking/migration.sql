-- AlterTable
ALTER TABLE "Idea" ADD COLUMN     "feedImpressions" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "region" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "institutionalCosign" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "preferredCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "preferredRegions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "Idea_category_idx" ON "Idea"("category");

