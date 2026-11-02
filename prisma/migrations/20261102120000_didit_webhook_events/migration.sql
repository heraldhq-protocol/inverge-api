-- Durable ledger for every verified Didit webhook, including entity, activity and
-- transaction events that have no VerificationCase. The raw body is not stored;
-- payloadHash supports support/debug correlation without retaining identity data.

-- CreateEnum
CREATE TYPE "DiditWebhookResource" AS ENUM ('SESSION', 'USER', 'BUSINESS', 'ACTIVITY', 'TRANSACTION');

-- CreateTable
CREATE TABLE "DiditWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "webhookType" TEXT NOT NULL,
    "resourceType" "DiditWebhookResource" NOT NULL,
    "resourceId" TEXT,
    "status" TEXT,
    "previousStatus" TEXT,
    "vendorData" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "metadata" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiditWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiditWebhookEvent_eventId_key" ON "DiditWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "DiditWebhookEvent_resourceType_resourceId_occurredAt_idx" ON "DiditWebhookEvent"("resourceType", "resourceId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "DiditWebhookEvent_webhookType_occurredAt_idx" ON "DiditWebhookEvent"("webhookType", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "DiditWebhookEvent_occurredAt_idx" ON "DiditWebhookEvent"("occurredAt" DESC);
