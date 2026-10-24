-- Reconcile schema drift found by applying every committed migration to a fresh
-- database and diffing the result against prisma/schema.prisma.
--
-- These columns existed in the development database (added with `db push`) but
-- no migration created them, so a clean deploy failed at runtime on
-- `CreatorProfile.username`. The SQL below is the exact diff produced by
-- `prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma`.

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "coverImageUrl" TEXT,
ADD COLUMN     "rewardTiers" JSONB,
ADD COLUMN     "videoPosterUrl" TEXT,
ADD COLUMN     "videoUrl" TEXT;

-- AlterTable
ALTER TABLE "CreatorProfile" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "bio" TEXT,
ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "links" JSONB DEFAULT '[]',
ADD COLUMN     "username" TEXT;

-- AlterTable
ALTER TABLE "Idea" ADD COLUMN     "coverImageUrl" TEXT,
ADD COLUMN     "problemDoc" JSONB,
ADD COLUMN     "risks" TEXT,
ADD COLUMN     "solutionDoc" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "CreatorProfile_username_key" ON "CreatorProfile"("username");
