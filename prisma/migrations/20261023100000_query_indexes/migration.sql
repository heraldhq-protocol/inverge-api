-- Query-shape indexes for the hot reads, validated with EXPLAIN (ANALYZE, BUFFERS)
-- on a synthetic volume fixture (10k users, 50k ideas, 10k campaigns, 100k
-- signals, 200k contributions/events). See docs/api/query-performance.md.
--
-- The composites start with the equality predicate and end with the keyset
-- order, so Postgres can walk the index in order instead of sorting the filtered
-- set. The single-column indexes replaced by a composite (Idea.creatorId,
-- Contribution.campaignId, MilestoneClaim.milestoneId, OnChainEvent.campaignId)
-- are redundant: a btree on (a, b, ...) also serves predicates on the leading
-- `a`. The old Idea status/category/tier singles are removed separately: the
-- public list uses the partial index below, and the nightly metrics scan reads
-- every matching idea anyway.
--
-- The public discovery lists are partial indexes. Their predicates match the
-- service filter exactly, which lets the planner stop after one page instead of
-- sorting every discoverable row. Prisma cannot express a partial index in the
-- schema, so these four live here and are deliberately invisible to
-- `prisma migrate diff`.

-- DropIndex
DROP INDEX "Contribution_campaignId_idx";

-- DropIndex
DROP INDEX "Idea_category_idx";

-- DropIndex
DROP INDEX "Idea_discoverabilityTier_idx";

-- DropIndex
DROP INDEX "Idea_status_idx";

-- DropIndex
DROP INDEX "Idea_creatorId_idx";

-- DropIndex
DROP INDEX "MilestoneClaim_milestoneId_idx";

-- DropIndex
DROP INDEX "OnChainEvent_campaignId_idx";

-- CreateIndex
CREATE INDEX "Contribution_campaignId_createdAt_idx" ON "Contribution"("campaignId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Idea_creatorId_createdAt_id_idx" ON "Idea"("creatorId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "IdeaSignal_userId_createdAt_idx" ON "IdeaSignal"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MilestoneClaim_milestoneId_submittedAt_idx" ON "MilestoneClaim"("milestoneId", "submittedAt" DESC);

-- CreateIndex
CREATE INDEX "OnChainEvent_campaignId_eventType_blockTime_idx" ON "OnChainEvent"("campaignId", "eventType", "blockTime" DESC);

-- Public idea discovery: status/tier predicate is fixed by IdeasService.list.
CREATE INDEX "Idea_public_discovery_idx"
  ON "Idea" ("createdAt" DESC, "id" DESC)
  WHERE status IN ('VALIDATING', 'THRESHOLD_MET')
    AND "discoverabilityTier" IN ('DISCOVERABLE', 'FEATURED');

-- Public campaign discovery: the default filter excludes DRAFT and IN_REVIEW.
CREATE INDEX "Campaign_public_createdAt_partial_idx"
  ON "Campaign" ("createdAt" DESC, "id" DESC)
  WHERE status IN ('ACTIVE', 'FUNDED', 'FAILED', 'COMPLETED');

CREATE INDEX "Campaign_public_deadline_partial_idx"
  ON "Campaign" (deadline, id)
  WHERE status IN ('ACTIVE', 'FUNDED', 'FAILED', 'COMPLETED');

CREATE INDEX "Campaign_public_totalRaised_partial_idx"
  ON "Campaign" ("totalRaised" DESC, "id" DESC)
  WHERE status IN ('ACTIVE', 'FUNDED', 'FAILED', 'COMPLETED');
