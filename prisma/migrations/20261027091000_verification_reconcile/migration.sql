-- AlterTable
ALTER TABLE "VerificationCase" ADD COLUMN     "nextReconcileAt" TIMESTAMP(3),
ADD COLUMN     "purpose" TEXT,
ADD COLUMN     "reconcileAttempts" INTEGER NOT NULL DEFAULT 0;

