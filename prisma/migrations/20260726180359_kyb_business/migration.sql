-- AlterTable
ALTER TABLE "AmlScreening" ADD COLUMN     "businessId" TEXT;

-- AlterTable
ALTER TABLE "KycStatusEvent" ADD COLUMN     "businessId" TEXT;

-- CreateTable
CREATE TABLE "BusinessProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "registrationNumber" TEXT,
    "country" TEXT,
    "kybStatus" "KycStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "amlStatus" "AmlStatus" NOT NULL DEFAULT 'NOT_SCREENED',
    "amlScreenedAt" TIMESTAMP(3),
    "kybProviderRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfile_userId_key" ON "BusinessProfile"("userId");

-- CreateIndex
CREATE INDEX "BusinessProfile_kybProviderRef_idx" ON "BusinessProfile"("kybProviderRef");

-- CreateIndex
CREATE INDEX "AmlScreening_businessId_idx" ON "AmlScreening"("businessId");

-- CreateIndex
CREATE INDEX "KycStatusEvent_businessId_idx" ON "KycStatusEvent"("businessId");

-- AddForeignKey
ALTER TABLE "BusinessProfile" ADD CONSTRAINT "BusinessProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

