-- CreateEnum
CREATE TYPE "AmlStatus" AS ENUM ('NOT_SCREENED', 'CLEAR', 'IN_REVIEW', 'FLAGGED');

-- CreateEnum
CREATE TYPE "AmlScreeningSource" AS ENUM ('KYC_SESSION', 'STANDALONE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "amlScreenedAt" TIMESTAMP(3),
ADD COLUMN     "amlStatus" "AmlStatus" NOT NULL DEFAULT 'NOT_SCREENED';

-- CreateTable
CREATE TABLE "AmlScreening" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "AmlScreeningSource" NOT NULL,
    "status" "AmlStatus" NOT NULL,
    "providerRef" TEXT,
    "totalHits" INTEGER NOT NULL DEFAULT 0,
    "topRiskScore" DOUBLE PRECISION,
    "datasets" TEXT[],
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmlScreening_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AmlScreening_userId_idx" ON "AmlScreening"("userId");

-- CreateIndex
CREATE INDEX "AmlScreening_createdAt_idx" ON "AmlScreening"("createdAt");

-- AddForeignKey
ALTER TABLE "AmlScreening" ADD CONSTRAINT "AmlScreening_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

