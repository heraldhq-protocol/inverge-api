# Query performance: hot reads and index evidence

Status: **measured on a synthetic fixture**. These are server-side SQL timings,
not production p95 and not end-to-end API latency. The purpose is to justify the
indexes in `prisma/migrations/20261023100000_query_indexes` and to record the
plan shape before and after.

## What was measured

The hot reads that were previously sorting or scanning a whole table:

| Query | Service |
|---|---|
| `IdeaSignal` by `userId`, newest 50 | feed personalisation / public profile |
| `Idea` public discovery page, newest 21 | `GET /api/v1/ideas` |
| `Campaign` public list, newest / closing soon / most backed, 21 | `GET /api/v1/campaigns` |
| `Contribution` timeline for one campaign, newest 50 | campaign detail |
| `MilestoneClaim` latest claim for one milestone | campaign detail |
| `OnChainEvent` by campaign and type, newest 50 | escrow projection |

The feed category candidate query is included as a control: it is a bounded
`LIMIT 500` over a ~25 % category slice and does **not** get a new index.

## Environment and fixture

- PostgreSQL 16 (Docker, local Windows host), single connection.
- `prisma migrate deploy`, then `prisma/volume-fixture.sql`, then `ANALYZE`.
- Fixture: 10k users, 50k ideas, 10k campaigns, 30k milestones and claims,
  100k idea signals, 200k contributions, 200k on-chain events.
- Each query ran 60 times; the first 10 runs were discarded as warm-up. The
  remaining 50 were timed server-side with `clock_timestamp()` inside PL/pgSQL,
  so the numbers exclude network round-trips and client serialization.
- `p50`/`p95`/`p99` are `percentile_cont` over those 50 samples.
- The fixture is synthetic and uniformly distributed. Real category, status and
  creator distributions will differ. Re-run on a production-like snapshot
  before treating these as capacity numbers.

## Before / after

"Before" is the schema before `20261023100000_query_indexes`: `IdeaSignal` had
only `(ideaId)`, `Idea` had single-column `status`/`category`/`discoverabilityTier`
indexes, and campaign discovery had only `(status)`. "After" is the migration in
this repository.

| Query | Before p50 / p95 | After p50 / p95 | p95 change |
|---|---:|---:|---:|
| `IdeaSignal` by user | 11.07 / 18.33 ms | 0.23 / 0.53 ms | ~35× faster |
| Ideas public list | 31.07 / 85.03 ms | 0.10 / 0.29 ms | ~293× faster |
| Campaigns newest | 3.40 / 5.06 ms | 0.30 / 0.62 ms | ~8× faster |
| Campaigns closing soon | 5.07 / 7.38 ms | 0.22 / 0.60 ms | ~12× faster |
| Campaigns most backed | 11.19 / 31.80 ms | 0.14 / 0.32 ms | ~99× faster |
| Contribution timeline | 0.45 / 0.82 ms | 0.17 / 0.25 ms | ~3× faster |
| Milestone latest claim | 0.18 / 0.40 ms | 0.06 / 0.14 ms | ~3× faster |
| On-chain events by type | 0.37 / 0.62 ms | 0.11 / 0.22 ms | ~3× faster |
| Feed category candidates | 2.86 / 3.68 ms | 1.60 / 3.60 ms | unchanged (no new index) |

The largest wins are the two public discovery pages. Both now use a partial
index whose predicate matches the service filter exactly, so Postgres walks the
index in `createdAt DESC, id DESC` order and stops after one page. Before, it
read every matching row and sorted it.

## Indexes

Added in `prisma/schema.prisma` (Prisma-managed):

- `IdeaSignal(userId, createdAt DESC)` — the feed and public profile load the
  newest signals for one user.
- `Idea(creatorId, createdAt DESC, id DESC)` — replaces `Idea(creatorId)`; the
  creator dashboard lists own ideas newest-first.
- `Contribution(campaignId, createdAt DESC)` — replaces
  `Contribution(campaignId)`; campaign timelines are newest-first.
- `MilestoneClaim(milestoneId, submittedAt DESC)` — replaces
  `MilestoneClaim(milestoneId)`; the detail page reads the latest claim.
- `OnChainEvent(campaignId, eventType, blockTime DESC)` — replaces
  `OnChainEvent(campaignId)`; escrow reads one event type per campaign.

Added in the raw migration (Prisma cannot express partial indexes):

- `Idea(createdAt DESC, id DESC) WHERE status IN ('VALIDATING','THRESHOLD_MET')
  AND discoverabilityTier IN ('DISCOVERABLE','FEATURED')`.
- `Campaign(createdAt DESC, id DESC) WHERE status IN ('ACTIVE','FUNDED','FAILED','COMPLETED')`.
- `Campaign(deadline, id) WHERE status IN ('ACTIVE','FUNDED','FAILED','COMPLETED')`.
- `Campaign(totalRaised DESC, id DESC) WHERE status IN ('ACTIVE','FUNDED','FAILED','COMPLETED')`.

Removed: the single-column `Idea(status)`, `Idea(category)`,
`Idea(discoverabilityTier)`, `Contribution(campaignId)`,
`MilestoneClaim(milestoneId)` and `OnChainEvent(campaignId)` indexes. The
composites above serve their leading column; the public idea filter is served by
the partial index, and no other hot read needs the old `Idea` singles.
`Campaign(status)` is kept because admin and single-status queries still use it,
and the partial campaign indexes deliberately do not cover `DRAFT` or
`IN_REVIEW`.

`prisma migrate diff` ignores partial indexes, so the schema-drift gate stays
green; the migration is the source of truth for them.

## Plan notes

- `Idea` public list: `Index Scan using Idea_public_discovery_idx`, 21 rows,
  no sort. Execution time 0.38 ms in `EXPLAIN (ANALYZE, BUFFERS)`.
- `Campaign` public lists: `Index Scan using Campaign_public_*_partial_idx`,
  21 rows, no sort. Execution times 0.19–0.72 ms.
- `IdeaSignal`: `Index Scan using IdeaSignal_userId_createdAt_idx`, 10 rows,
  0.73 ms in `EXPLAIN`; p95 0.53 ms over 50 runs.
- `Contribution` and `OnChainEvent`: the composite index removes most of the
  heap filtering, but the planner still sorts the small per-campaign result.
  That is cheaper than forcing an index-order scan for 20–40 rows.
- `Idea` feed category candidates: sequential scan, 1.6 ms p50 for 500 rows.
  A partial `(category)` index only moved p50 to ~1.75 ms in the EXPLAIN probe,
  which did not justify the write cost.

## What this does not prove

- No concurrency, connection-pool contention or cold-cache run. The fixture is
  warm after `ANALYZE`.
- No API-level p95. Auth guards, DTO serialization, cache lookups and network
  are outside these numbers. The API's `/metrics` histogram is the place to
  measure those.
- No production data distribution. Re-run the same fixture and queries against a
  sanitized production snapshot before a capacity decision.

## Reproduce

```bash
prisma migrate deploy
psql "$DATABASE_URL" -f prisma/volume-fixture.sql
```

Then run each query 60 times in PL/pgSQL, discard the first 10, and compute
`percentile_cont(0.5/0.95/0.99)` over the remaining 50. The "before" numbers
were produced by dropping the new indexes and recreating the old single-column
ones; the "after" numbers by applying the migration. Both runs used the same
script.
