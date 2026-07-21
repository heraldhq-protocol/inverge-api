-- CreateEnum
CREATE TYPE "IdeaStatus" AS ENUM ('DRAFT', 'VALIDATING', 'THRESHOLD_MET', 'CONVERTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('SUPPORT', 'PRE_PLEDGE');

-- CreateEnum
CREATE TYPE "BoostTier" AS ENUM ('BASIC', 'FEATURED');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WalletRole" AS ENUM ('FUNDING', 'PAYOUT');

-- CreateEnum
CREATE TYPE "FlatFeeChargePurpose" AS ENUM ('BOOST', 'APPLICATION_FEE');

-- CreateEnum
CREATE TYPE "FlatFeeStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "CreatorTier" AS ENUM ('STARTER', 'TRUSTED', 'ESTABLISHED');

-- CreateEnum
CREATE TYPE "CampaignType" AS ENUM ('ALL_OR_NOTHING', 'FLEXIBLE_FUNDING');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'ACTIVE', 'FUNDED', 'FAILED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('UNDER_REVIEW', 'APPROVED', 'FAILED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "TokenType" AS ENUM ('USDC', 'CNGN');

-- CreateEnum
CREATE TYPE "OnChainEventType" AS ENUM ('FUNDED', 'TRANCHE_RELEASED', 'REFUND_CLAIMED', 'MILESTONE_FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "privyDid" TEXT NOT NULL,
    "email" TEXT,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "kycProviderRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "isEmbedded" BOOLEAN NOT NULL DEFAULT false,
    "role" "WalletRole" NOT NULL DEFAULT 'FUNDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KycStatusEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromStatus" "KycStatus" NOT NULL,
    "toStatus" "KycStatus" NOT NULL,
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KycStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorProfile" (
    "userId" TEXT NOT NULL,
    "tier" "CreatorTier" NOT NULL DEFAULT 'STARTER',
    "activeStrikes" INTEGER NOT NULL DEFAULT 0,
    "completedCampaigns" INTEGER NOT NULL DEFAULT 0,
    "lifetimeRaised" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tenureStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Idea" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "solution" TEXT NOT NULL,
    "roadmap" TEXT NOT NULL,
    "askAmount" DECIMAL(14,2) NOT NULL,
    "status" "IdeaStatus" NOT NULL DEFAULT 'DRAFT',
    "supporterCount" INTEGER NOT NULL DEFAULT 0,
    "prePledgeTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "feedbackScore" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "feedbackCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Idea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdeaSignal" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "SignalType" NOT NULL,
    "amount" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdeaSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdeaFeedback" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdeaFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdeaBoost" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "purchasedByUserId" TEXT NOT NULL,
    "tier" "BoostTier" NOT NULL,
    "flatFeeChargeId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdeaBoost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlatFeeCharge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "FlatFeeChargePurpose" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "processorRef" TEXT NOT NULL,
    "status" "FlatFeeStatus" NOT NULL DEFAULT 'PENDING',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlatFeeCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT,
    "ideaSnapshot" JSONB,
    "creatorId" TEXT NOT NULL,
    "type" "CampaignType" NOT NULL DEFAULT 'ALL_OR_NOTHING',
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "tokenType" "TokenType" NOT NULL,
    "targetAmount" DECIMAL(14,2) NOT NULL,
    "fundingFloorPct" INTEGER,
    "deadline" TIMESTAMP(3) NOT NULL,
    "termsHash" TEXT,
    "workingCapitalPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "workingCapitalReleasedAt" TIMESTAMP(3),
    "escrowPdaAddress" TEXT,
    "totalRaised" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "applicationFeeChargeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "launchedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Milestone" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "deliverable" TEXT NOT NULL DEFAULT '',
    "tranchePct" DECIMAL(5,2) NOT NULL,
    "evidenceDefinition" JSONB NOT NULL,

    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneClaim" (
    "id" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "proofBundle" JSONB NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "objectionWindowEndsAt" TIMESTAMP(3) NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'UNDER_REVIEW',

    CONSTRAINT "MilestoneClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneObjection" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "weightPct" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MilestoneObjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewerRuling" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "txSignature" TEXT,
    "ruledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewerRuling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contribution" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "tokenType" "TokenType" NOT NULL,
    "txSignature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnChainEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "eventType" "OnChainEventType" NOT NULL,
    "amount" DECIMAL(14,2),
    "txSignature" TEXT NOT NULL,
    "blockTime" TIMESTAMP(3) NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnChainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformParam" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "PlatformParam_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_privyDid_key" ON "User"("privyDid");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "WalletAccount_address_idx" ON "WalletAccount"("address");

-- CreateIndex
CREATE UNIQUE INDEX "WalletAccount_userId_address_key" ON "WalletAccount"("userId", "address");

-- CreateIndex
CREATE INDEX "KycStatusEvent_userId_idx" ON "KycStatusEvent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Idea_slug_key" ON "Idea"("slug");

-- CreateIndex
CREATE INDEX "Idea_creatorId_idx" ON "Idea"("creatorId");

-- CreateIndex
CREATE INDEX "Idea_status_idx" ON "Idea"("status");

-- CreateIndex
CREATE INDEX "IdeaSignal_ideaId_idx" ON "IdeaSignal"("ideaId");

-- CreateIndex
CREATE UNIQUE INDEX "IdeaSignal_ideaId_userId_type_key" ON "IdeaSignal"("ideaId", "userId", "type");

-- CreateIndex
CREATE INDEX "IdeaFeedback_ideaId_idx" ON "IdeaFeedback"("ideaId");

-- CreateIndex
CREATE UNIQUE INDEX "IdeaFeedback_ideaId_userId_key" ON "IdeaFeedback"("ideaId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "IdeaBoost_flatFeeChargeId_key" ON "IdeaBoost"("flatFeeChargeId");

-- CreateIndex
CREATE INDEX "IdeaBoost_ideaId_idx" ON "IdeaBoost"("ideaId");

-- CreateIndex
CREATE UNIQUE INDEX "FlatFeeCharge_processorRef_key" ON "FlatFeeCharge"("processorRef");

-- CreateIndex
CREATE INDEX "FlatFeeCharge_userId_idx" ON "FlatFeeCharge"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_ideaId_key" ON "Campaign"("ideaId");

-- CreateIndex
CREATE INDEX "Campaign_creatorId_idx" ON "Campaign"("creatorId");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Milestone_campaignId_index_key" ON "Milestone"("campaignId", "index");

-- CreateIndex
CREATE INDEX "MilestoneClaim_milestoneId_idx" ON "MilestoneClaim"("milestoneId");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneObjection_claimId_userId_key" ON "MilestoneObjection"("claimId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewerRuling_claimId_key" ON "ReviewerRuling"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "Contribution_txSignature_key" ON "Contribution"("txSignature");

-- CreateIndex
CREATE INDEX "Contribution_campaignId_idx" ON "Contribution"("campaignId");

-- CreateIndex
CREATE INDEX "Contribution_userId_idx" ON "Contribution"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OnChainEvent_txSignature_key" ON "OnChainEvent"("txSignature");

-- CreateIndex
CREATE INDEX "OnChainEvent_campaignId_idx" ON "OnChainEvent"("campaignId");

-- AddForeignKey
ALTER TABLE "WalletAccount" ADD CONSTRAINT "WalletAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KycStatusEvent" ADD CONSTRAINT "KycStatusEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorProfile" ADD CONSTRAINT "CreatorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Idea" ADD CONSTRAINT "Idea_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdeaSignal" ADD CONSTRAINT "IdeaSignal_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdeaSignal" ADD CONSTRAINT "IdeaSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdeaFeedback" ADD CONSTRAINT "IdeaFeedback_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdeaFeedback" ADD CONSTRAINT "IdeaFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdeaBoost" ADD CONSTRAINT "IdeaBoost_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdeaBoost" ADD CONSTRAINT "IdeaBoost_purchasedByUserId_fkey" FOREIGN KEY ("purchasedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdeaBoost" ADD CONSTRAINT "IdeaBoost_flatFeeChargeId_fkey" FOREIGN KEY ("flatFeeChargeId") REFERENCES "FlatFeeCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlatFeeCharge" ADD CONSTRAINT "FlatFeeCharge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneClaim" ADD CONSTRAINT "MilestoneClaim_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneObjection" ADD CONSTRAINT "MilestoneObjection_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "MilestoneClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneObjection" ADD CONSTRAINT "MilestoneObjection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewerRuling" ADD CONSTRAINT "ReviewerRuling_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "MilestoneClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnChainEvent" ADD CONSTRAINT "OnChainEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
