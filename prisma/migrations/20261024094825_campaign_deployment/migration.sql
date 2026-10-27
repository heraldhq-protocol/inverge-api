-- CreateEnum
CREATE TYPE "CampaignDeploymentStatus" AS ENUM ('NOT_STARTED', 'READY', 'AWAITING_SIGNATURE', 'SUBMITTED', 'CONFIRMING', 'CONFIRMED', 'FAILED', 'NEEDS_RECONCILIATION');

-- CreateEnum
CREATE TYPE "CampaignDeploymentFeeStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'NEEDS_RECONCILIATION');

-- CreateEnum
CREATE TYPE "CampaignDeploymentEventType" AS ENUM ('PREPARED', 'SIGNATURE_REQUESTED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'RECONCILE_REQUESTED', 'NEEDS_RECONCILIATION', 'FEE_CONFIRMED', 'FEE_FAILED', 'PUBLISHED');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "draftVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "objectionWindowDays" INTEGER,
ADD COLUMN     "story" JSONB,
ADD COLUMN     "summary" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "title" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Milestone" ADD COLUMN     "expectedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CampaignTermsAcceptance" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "termsHash" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignTermsAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignDeployment" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "CampaignDeploymentStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "cluster" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "creatorWallet" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "campaignIdBytes" TEXT NOT NULL,
    "termsHash" TEXT NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "instructionData" TEXT NOT NULL,
    "expectedAccounts" JSONB NOT NULL,
    "feeBreakdown" JSONB NOT NULL,
    "campaignPda" TEXT,
    "escrowVault" TEXT,
    "txSignature" TEXT,
    "commitment" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "onChainState" JSONB,
    "blockTime" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextReconcileAt" TIMESTAMP(3),
    "feeStatus" "CampaignDeploymentFeeStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "feeMode" TEXT NOT NULL DEFAULT 'not_required',
    "feeAmount" DECIMAL(10,2),
    "feeCurrency" TEXT,
    "feeChargeId" TEXT,
    "feeVerifiedAt" TIMESTAMP(3),
    "preparedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignDeploymentEvent" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "type" "CampaignDeploymentEventType" NOT NULL,
    "fromStatus" "CampaignDeploymentStatus",
    "toStatus" "CampaignDeploymentStatus",
    "actorId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignDeploymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignTermsAcceptance_userId_acceptedAt_idx" ON "CampaignTermsAcceptance"("userId", "acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignTermsAcceptance_campaignId_termsVersion_termsHash_key" ON "CampaignTermsAcceptance"("campaignId", "termsVersion", "termsHash");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDeployment_campaignId_key" ON "CampaignDeployment"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDeployment_txSignature_key" ON "CampaignDeployment"("txSignature");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDeployment_feeChargeId_key" ON "CampaignDeployment"("feeChargeId");

-- CreateIndex
CREATE INDEX "CampaignDeployment_status_nextReconcileAt_idx" ON "CampaignDeployment"("status", "nextReconcileAt");

-- CreateIndex
CREATE INDEX "CampaignDeployment_creatorWallet_idx" ON "CampaignDeployment"("creatorWallet");

-- CreateIndex
CREATE INDEX "CampaignDeploymentEvent_deploymentId_createdAt_idx" ON "CampaignDeploymentEvent"("deploymentId", "createdAt");

-- AddForeignKey
ALTER TABLE "CampaignTermsAcceptance" ADD CONSTRAINT "CampaignTermsAcceptance_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDeployment" ADD CONSTRAINT "CampaignDeployment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDeploymentEvent" ADD CONSTRAINT "CampaignDeploymentEvent_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "CampaignDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

