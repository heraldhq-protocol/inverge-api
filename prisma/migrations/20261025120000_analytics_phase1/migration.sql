-- CreateEnum
CREATE TYPE "AnalyticsResourceType" AS ENUM ('IDEA', 'CAMPAIGN', 'PAGE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ProductAnalyticsEventName" ADD VALUE 'PAGE_VIEWED';
ALTER TYPE "ProductAnalyticsEventName" ADD VALUE 'FEEDBACK_SUBMITTED';

-- AlterTable
-- eventKey is added nullable, backfilled from the existing primary key, then made
-- required. Adding it as NOT NULL directly would fail on a non-empty table.
ALTER TABLE "ProductAnalyticsEvent" ADD COLUMN     "eventKey" TEXT,
ADD COLUMN     "resourceId" TEXT,
ADD COLUMN     "resourceType" "AnalyticsResourceType",
ADD COLUMN     "schemaVersion" INTEGER NOT NULL DEFAULT 1;

UPDATE "ProductAnalyticsEvent" SET "eventKey" = "id" WHERE "eventKey" IS NULL;
ALTER TABLE "ProductAnalyticsEvent" ALTER COLUMN "eventKey" SET NOT NULL;

-- Backfill the generic resource pair from the legacy typed columns. The idea is
-- preferred when both are present; the raw event keeps both original ids.
UPDATE "ProductAnalyticsEvent"
SET "resourceType" = 'IDEA', "resourceId" = "ideaId"
WHERE "ideaId" IS NOT NULL AND "resourceType" IS NULL;

UPDATE "ProductAnalyticsEvent"
SET "resourceType" = 'CAMPAIGN', "resourceId" = "campaignId"
WHERE "ideaId" IS NULL AND "campaignId" IS NOT NULL AND "resourceType" IS NULL;

-- CreateTable
CREATE TABLE "ResourceReachDailyMetric" (
    "id" TEXT NOT NULL,
    "resourceType" "AnalyticsResourceType" NOT NULL,
    "resourceId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "uniqueSessions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceReachDailyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceAcquisitionDailyMetric" (
    "id" TEXT NOT NULL,
    "resourceType" "AnalyticsResourceType" NOT NULL,
    "resourceId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "uniqueSessions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceAcquisitionDailyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceCountryDailyMetric" (
    "id" TEXT NOT NULL,
    "resourceType" "AnalyticsResourceType" NOT NULL,
    "resourceId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "uniqueSessions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceCountryDailyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignFunnelDailyMetric" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "stepStarted" INTEGER NOT NULL DEFAULT 0,
    "stepCompleted" INTEGER NOT NULL DEFAULT 0,
    "contributionStarted" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignFunnelDailyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResourceReachDailyMetric_day_idx" ON "ResourceReachDailyMetric"("day");

-- CreateIndex
CREATE INDEX "ResourceReachDailyMetric_resourceType_day_idx" ON "ResourceReachDailyMetric"("resourceType", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceReachDailyMetric_resourceType_resourceId_day_key" ON "ResourceReachDailyMetric"("resourceType", "resourceId", "day");

-- CreateIndex
CREATE INDEX "ResourceAcquisitionDailyMetric_day_idx" ON "ResourceAcquisitionDailyMetric"("day");

-- CreateIndex
CREATE INDEX "ResourceAcquisitionDailyMetric_resourceType_day_idx" ON "ResourceAcquisitionDailyMetric"("resourceType", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceAcquisitionDailyMetric_resourceType_resourceId_day__key" ON "ResourceAcquisitionDailyMetric"("resourceType", "resourceId", "day", "source");

-- CreateIndex
CREATE INDEX "ResourceCountryDailyMetric_day_idx" ON "ResourceCountryDailyMetric"("day");

-- CreateIndex
CREATE INDEX "ResourceCountryDailyMetric_resourceType_day_idx" ON "ResourceCountryDailyMetric"("resourceType", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceCountryDailyMetric_resourceType_resourceId_day_coun_key" ON "ResourceCountryDailyMetric"("resourceType", "resourceId", "day", "countryCode");

-- CreateIndex
CREATE INDEX "CampaignFunnelDailyMetric_day_idx" ON "CampaignFunnelDailyMetric"("day");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignFunnelDailyMetric_campaignId_day_key" ON "CampaignFunnelDailyMetric"("campaignId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAnalyticsEvent_eventKey_key" ON "ProductAnalyticsEvent"("eventKey");

-- CreateIndex
CREATE INDEX "ProductAnalyticsEvent_resourceType_resourceId_name_occurred_idx" ON "ProductAnalyticsEvent"("resourceType", "resourceId", "name", "occurredAt");

-- CreateIndex
CREATE INDEX "ProductAnalyticsEvent_resourceType_resourceId_source_occurr_idx" ON "ProductAnalyticsEvent"("resourceType", "resourceId", "source", "occurredAt");
