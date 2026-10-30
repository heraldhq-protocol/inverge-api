-- Media assets: one row owns one stored object (docs/media/phase-1-audit.md 4).
-- Additive and safe for staging: two new types and one new table, no existing
-- column or row is touched.

-- CreateEnum
CREATE TYPE "MediaAssetStatus" AS ENUM ('PENDING', 'READY', 'REJECTED', 'DELETED');

-- CreateEnum
CREATE TYPE "MediaAssetCategory" AS ENUM ('AVATAR', 'IDEA_COVER', 'IDEA_GALLERY', 'CAMPAIGN_COVER', 'CAMPAIGN_HERO', 'CAMPAIGN_STORY', 'REWARD', 'OTHER');

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "category" "MediaAssetCategory" NOT NULL DEFAULT 'OTHER',
    "status" "MediaAssetStatus" NOT NULL DEFAULT 'PENDING',
    "provider" VARCHAR(24) NOT NULL,
    "bucket" VARCHAR(63) NOT NULL,
    "objectKey" VARCHAR(512) NOT NULL,
    "mimeType" VARCHAR(64) NOT NULL,
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" DECIMAL(8,3),
    "displayName" VARCHAR(255) NOT NULL,
    "altText" VARCHAR(280),
    "caption" VARCHAR(280),
    "ideaId" TEXT,
    "campaignId" TEXT,
    "creatorProfileUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_objectKey_key" ON "MediaAsset"("objectKey");

-- CreateIndex
CREATE INDEX "MediaAsset_ownerId_createdAt_idx" ON "MediaAsset"("ownerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MediaAsset_status_createdAt_idx" ON "MediaAsset"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAsset_ideaId_idx" ON "MediaAsset"("ideaId");

-- CreateIndex
CREATE INDEX "MediaAsset_campaignId_idx" ON "MediaAsset"("campaignId");

-- CreateIndex
CREATE INDEX "MediaAsset_creatorProfileUserId_idx" ON "MediaAsset"("creatorProfileUserId");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_creatorProfileUserId_fkey" FOREIGN KEY ("creatorProfileUserId") REFERENCES "CreatorProfile"("userId") ON DELETE SET NULL ON UPDATE CASCADE;
