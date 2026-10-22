-- CreateEnum
CREATE TYPE "WebhookProvider" AS ENUM ('PAYSTACK', 'DIDIT');

-- CreateEnum
CREATE TYPE "WebhookReceiptStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "provider" "WebhookProvider" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "eventType" TEXT,
    "status" "WebhookReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_provider_dedupeKey_key" ON "WebhookReceipt"("provider", "dedupeKey");

-- CreateIndex
CREATE INDEX "WebhookReceipt_provider_receivedAt_idx" ON "WebhookReceipt"("provider", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookReceipt_status_lockedAt_idx" ON "WebhookReceipt"("status", "lockedAt");
