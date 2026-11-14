-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'OPERATOR', 'REVIEWER', 'READ_ONLY');

-- CreateEnum
CREATE TYPE "AdminStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AdminAuthEventType" AS ENUM ('LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'MFA_FAILED', 'MFA_REPLAY_REJECTED', 'LOCKED_OUT', 'SESSION_REVOKED', 'PASSWORD_CHANGED', 'ROLE_CHANGED', 'RECOVERY_USED');

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "passwordUpdatedAt" TIMESTAMP(3) NOT NULL,
    "totpSecret" TEXT NOT NULL,
    "totpEnabledAt" TIMESTAMP(3),
    "lastTotpStep" BIGINT,
    "role" "AdminRole" NOT NULL DEFAULT 'READ_ONLY',
    "status" "AdminStatus" NOT NULL DEFAULT 'ACTIVE',
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "ipHash" TEXT,
    "userAgentHash" TEXT,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminRecoveryCode" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "AdminRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuthEvent" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT,
    "type" "AdminAuthEventType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipHash" TEXT,
    "userAgentHash" TEXT,
    "metadata" JSONB,

    CONSTRAINT "AdminAuthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE INDEX "AdminUser_status_idx" ON "AdminUser"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminSession_adminUserId_expiresAt_idx" ON "AdminSession"("adminUserId", "expiresAt");

-- CreateIndex
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminRecoveryCode_codeHash_key" ON "AdminRecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "AdminRecoveryCode_adminUserId_usedAt_idx" ON "AdminRecoveryCode"("adminUserId", "usedAt");

-- CreateIndex
CREATE INDEX "AdminAuthEvent_adminUserId_createdAt_idx" ON "AdminAuthEvent"("adminUserId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdminAuthEvent_type_createdAt_idx" ON "AdminAuthEvent"("type", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminRecoveryCode" ADD CONSTRAINT "AdminRecoveryCode_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuthEvent" ADD CONSTRAINT "AdminAuthEvent_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
