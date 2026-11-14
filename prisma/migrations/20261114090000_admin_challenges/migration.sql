-- CreateTable
CREATE TABLE "AdminChallenge" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ipHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminChallenge_tokenHash_key" ON "AdminChallenge"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminChallenge_adminUserId_expiresAt_idx" ON "AdminChallenge"("adminUserId", "expiresAt");

-- CreateIndex
CREATE INDEX "AdminChallenge_expiresAt_idx" ON "AdminChallenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "AdminChallenge" ADD CONSTRAINT "AdminChallenge_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
