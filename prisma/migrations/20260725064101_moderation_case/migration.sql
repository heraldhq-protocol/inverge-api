-- CreateEnum
CREATE TYPE "ModerationDecision" AS ENUM ('AUTO_CLEAR', 'HELD_FOR_REVIEW');

-- CreateTable
CREATE TABLE "ModerationCase" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ideaId" TEXT,
    "submittedById" TEXT,
    "decision" "ModerationDecision" NOT NULL,
    "maxRisk" DECIMAL(5,4) NOT NULL,
    "categories" JSONB NOT NULL,
    "reasonCodes" TEXT[],
    "internalReason" TEXT NOT NULL,
    "externalReason" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModerationCase_decision_createdAt_idx" ON "ModerationCase"("decision", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationCase_ideaId_idx" ON "ModerationCase"("ideaId");

-- AddForeignKey
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

