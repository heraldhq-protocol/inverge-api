-- FR-204: conversion creates a campaign draft before the creator has supplied
-- funding terms. Keep the draft honest: an unset target and deadline are NULL,
-- never a fabricated value. Submission readiness and escrow deployment both
-- require them, and the check below prevents a non-draft row from omitting them.
--
-- Idempotent so a retried deploy after a partial failure can converge.
ALTER TABLE "Campaign" ALTER COLUMN "targetAmount" DROP NOT NULL;
ALTER TABLE "Campaign" ALTER COLUMN "deadline" DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE "Campaign"
    ADD CONSTRAINT "Campaign_terms_required_when_not_draft"
    CHECK (
      "status" = 'DRAFT'
      OR ("targetAmount" IS NOT NULL AND "deadline" IS NOT NULL)
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
