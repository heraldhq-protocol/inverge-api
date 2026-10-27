-- CreateEnum
CREATE TYPE "AnalyticsAccessStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AnalyticsAccessSource" AS ENUM ('REQUEST', 'ADMIN', 'PAID');

-- CreateTable
CREATE TABLE "AnalyticsAccessGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "feature" TEXT NOT NULL DEFAULT 'analytics.premium',
    "status" "AnalyticsAccessStatus" NOT NULL DEFAULT 'PENDING',
    "source" "AnalyticsAccessSource" NOT NULL DEFAULT 'REQUEST',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "expiresAt" TIMESTAMP(3),
    "externalReference" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalyticsAccessGrant_status_requestedAt_idx" ON "AnalyticsAccessGrant"("status", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsAccessGrant_userId_feature_key" ON "AnalyticsAccessGrant"("userId", "feature");

-- AddForeignKey
ALTER TABLE "AnalyticsAccessGrant" ADD CONSTRAINT "AnalyticsAccessGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
