-- CreateEnum
CREATE TYPE "AiAccessStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AiAccessSource" AS ENUM ('REQUEST', 'ADMIN', 'PAID');

-- CreateEnum
CREATE TYPE "AiUsageStatus" AS ENUM ('OK', 'INVALID_OUTPUT', 'TIMEOUT', 'PROVIDER_ERROR');

-- CreateTable
CREATE TABLE "AiAccessGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AiAccessStatus" NOT NULL DEFAULT 'PENDING',
    "source" "AiAccessSource" NOT NULL DEFAULT 'REQUEST',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "expiresAt" TIMESTAMP(3),
    "externalReference" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsageEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "surface" VARCHAR(32) NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "model" VARCHAR(64) NOT NULL,
    "promptVersion" VARCHAR(64) NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "status" "AiUsageStatus" NOT NULL,
    "requestId" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiAccessGrant_userId_key" ON "AiAccessGrant"("userId");

-- CreateIndex
CREATE INDEX "AiAccessGrant_status_requestedAt_idx" ON "AiAccessGrant"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "AiUsageEvent_userId_createdAt_idx" ON "AiUsageEvent"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiAccessGrant" ADD CONSTRAINT "AiAccessGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsageEvent" ADD CONSTRAINT "AiUsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
