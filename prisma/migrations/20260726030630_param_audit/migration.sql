-- CreateTable
CREATE TABLE "PlatformParamAudit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB NOT NULL,
    "changedBy" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformParamAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformParamAudit_key_changedAt_idx" ON "PlatformParamAudit"("key", "changedAt");

-- CreateIndex
CREATE INDEX "PlatformParamAudit_changedAt_idx" ON "PlatformParamAudit"("changedAt");

