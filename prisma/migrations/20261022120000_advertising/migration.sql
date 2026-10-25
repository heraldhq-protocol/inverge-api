-- Proposed advertising schema. NOT APPLIED in this change.
--
-- Generated shape, hand-written because no Postgres instance was available to
-- run `prisma migrate diff`. Before applying:
--   1. pnpm prisma validate
--   2. pnpm prisma migrate diff --from-config-datasource \
--        --to-schema=prisma/schema.prisma --script > <this file>
-- and reconcile any difference. Rehearse on a scratch database first.

-- CreateEnum
CREATE TYPE "AdCreativeStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "AdCreativeKind" AS ENUM ('FIRST_PARTY', 'THIRD_PARTY');

-- CreateEnum
CREATE TYPE "AdCreativeFormat" AS ENUM ('NATIVE_CARD', 'BANNER', 'SIDEBAR', 'THIRD_PARTY');

-- CreateEnum
CREATE TYPE "AdReviewAction" AS ENUM ('SUBMIT', 'APPROVE', 'REJECT', 'PAUSE', 'RESUME', 'END');

-- CreateEnum
CREATE TYPE "AdEventType" AS ENUM ('AD_IMPRESSION', 'AD_CLICK', 'AD_DISMISS', 'AD_DESTINATION_OPENED');

-- CreateTable
CREATE TABLE "Advertisement" (
    "id" TEXT NOT NULL,
    "advertiser" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ctaLabel" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "format" "AdCreativeFormat" NOT NULL,
    "kind" "AdCreativeKind" NOT NULL DEFAULT 'FIRST_PARTY',
    "status" "AdCreativeStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "regions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Advertisement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvertisementPlacement" (
    "id" TEXT NOT NULL,
    "advertisementId" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,

    CONSTRAINT "AdvertisementPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvertisementReviewEvent" (
    "id" TEXT NOT NULL,
    "advertisementId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" "AdReviewAction" NOT NULL,
    "fromStatus" "AdCreativeStatus" NOT NULL,
    "toStatus" "AdCreativeStatus" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvertisementReviewEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvertisementEvent" (
    "id" TEXT NOT NULL,
    "creativeId" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "type" "AdEventType" NOT NULL,
    "sessionId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvertisementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Advertisement_status_startsAt_endsAt_idx" ON "Advertisement"("status", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "Advertisement_kind_status_idx" ON "Advertisement"("kind", "status");

-- CreateIndex
CREATE INDEX "AdvertisementPlacement_placementId_idx" ON "AdvertisementPlacement"("placementId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvertisementPlacement_advertisementId_placementId_key" ON "AdvertisementPlacement"("advertisementId", "placementId");

-- CreateIndex
CREATE INDEX "AdvertisementReviewEvent_advertisementId_createdAt_idx" ON "AdvertisementReviewEvent"("advertisementId", "createdAt");

-- CreateIndex
CREATE INDEX "AdvertisementReviewEvent_createdAt_idx" ON "AdvertisementReviewEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AdvertisementEvent_creativeId_occurredAt_idx" ON "AdvertisementEvent"("creativeId", "occurredAt");

-- CreateIndex
CREATE INDEX "AdvertisementEvent_placementId_occurredAt_idx" ON "AdvertisementEvent"("placementId", "occurredAt");

-- CreateIndex
CREATE INDEX "AdvertisementEvent_receivedAt_idx" ON "AdvertisementEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdvertisementEvent_dedupeKey_key" ON "AdvertisementEvent"("dedupeKey");

-- AddForeignKey
ALTER TABLE "AdvertisementPlacement" ADD CONSTRAINT "AdvertisementPlacement_advertisementId_fkey" FOREIGN KEY ("advertisementId") REFERENCES "Advertisement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvertisementReviewEvent" ADD CONSTRAINT "AdvertisementReviewEvent_advertisementId_fkey" FOREIGN KEY ("advertisementId") REFERENCES "Advertisement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
