-- CreateEnum
CREATE TYPE "ProductAnalyticsEventName" AS ENUM ('IDEA_VIEWED', 'IDEA_SIGNAL', 'CAMPAIGN_VIEWED', 'CAMPAIGN_STEP_STARTED', 'CAMPAIGN_STEP_COMPLETED', 'CONTRIBUTION_STARTED', 'CONTRIBUTION_CONFIRMED', 'SEARCH_PERFORMED');

-- CreateEnum
CREATE TYPE "AnalyticsSignalType" AS ENUM ('SUPPORT', 'PRE_PLEDGE');

-- CreateTable
CREATE TABLE "ProductAnalyticsEvent" (
    "id" TEXT NOT NULL,
    "name" "ProductAnalyticsEventName" NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "ideaId" TEXT,
    "campaignId" TEXT,
    "signalType" "AnalyticsSignalType",
    "source" TEXT,
    "position" INTEGER,
    "step" TEXT,
    "durationMs" INTEGER,
    "queryLength" INTEGER,
    "resultCount" INTEGER,
    "filterKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "amountMinor" BIGINT,
    "currency" TEXT,
    "countryCode" CHAR(2),
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductAnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdeaSignalDailyMetric" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "supportCount" INTEGER NOT NULL DEFAULT 0,
    "prePledgeCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueActors" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdeaSignalDailyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductAnalyticsEvent_name_occurredAt_idx" ON "ProductAnalyticsEvent"("name", "occurredAt");

-- CreateIndex
CREATE INDEX "ProductAnalyticsEvent_ideaId_name_occurredAt_idx" ON "ProductAnalyticsEvent"("ideaId", "name", "occurredAt");

-- CreateIndex
CREATE INDEX "ProductAnalyticsEvent_campaignId_name_occurredAt_idx" ON "ProductAnalyticsEvent"("campaignId", "name", "occurredAt");

-- CreateIndex
CREATE INDEX "ProductAnalyticsEvent_userId_occurredAt_idx" ON "ProductAnalyticsEvent"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "ProductAnalyticsEvent_receivedAt_idx" ON "ProductAnalyticsEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "IdeaSignalDailyMetric_day_idx" ON "IdeaSignalDailyMetric"("day");

-- CreateIndex
CREATE UNIQUE INDEX "IdeaSignalDailyMetric_ideaId_day_key" ON "IdeaSignalDailyMetric"("ideaId", "day");

-- AddForeignKey
ALTER TABLE "ProductAnalyticsEvent" ADD CONSTRAINT "ProductAnalyticsEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

