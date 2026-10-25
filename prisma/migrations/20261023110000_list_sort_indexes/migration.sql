-- Prisma sends list filters as parameters (`status IN ($1, $2, ...)`), which
-- Postgres renders as `status = ANY (ARRAY[$1, $2])`. The planner cannot prove
-- that predicate implies a partial index whose WHERE clause is a literal
-- `status IN ('A', 'B')`, so it falls back to a sequential scan even when the
-- plan is custom. The partial discovery indexes added in
-- 20261023100000_query_indexes were therefore never used by the API.
--
-- Replace them with full sort-key indexes. The planner can walk these in the
-- requested order and apply the status/tier filter as a heap filter, stopping
-- after one page. They are slightly larger than the partial indexes but work
-- with parameterised queries, which is what the application actually sends.

DROP INDEX "Idea_public_discovery_idx";

DROP INDEX "Campaign_public_createdAt_partial_idx";
DROP INDEX "Campaign_public_deadline_partial_idx";
DROP INDEX "Campaign_public_totalRaised_partial_idx";

CREATE INDEX "Idea_createdAt_id_idx" ON "Idea" ("createdAt" DESC, "id" DESC);

CREATE INDEX "Campaign_createdAt_id_idx" ON "Campaign" ("createdAt" DESC, "id" DESC);
CREATE INDEX "Campaign_deadline_id_idx" ON "Campaign" ("deadline", "id");
CREATE INDEX "Campaign_totalRaised_id_idx" ON "Campaign" ("totalRaised" DESC, "id" DESC);
