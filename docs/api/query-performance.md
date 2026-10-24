# Query performance: hot reads and index evidence

Status: **measured on a synthetic fixture**. There are two layers:

1. Server-side SQL plan and timing evidence for the indexes.
2. A closed-loop probe of the public read routes
   (`scripts/load-public-reads.mjs`).

The API probe is the production-relevant layer. The SQL numbers explain the
plan shape, but they do not include Prisma, serialization, cache or concurrency.

## Correction: the partial discovery indexes were not used by the API

The first index migration, `20261023100000_query_indexes`, added partial indexes
whose predicates matched the service filters as literals:

```sql
WHERE status IN ('VALIDATING', 'THRESHOLD_MET')
  AND "discoverabilityTier" IN ('DISCOVERABLE', 'FEATURED')
```

Measured with literal SQL, those plans were excellent (0.10 ms p50 for the idea
list). The application does not send literals. Prisma parameterises the filter,
and Postgres renders it as:

```sql
WHERE status = ANY (ARRAY[$1, $2])
  AND "discoverabilityTier" = ANY (ARRAY[$3, $4])
```

The planner cannot prove that a parameterised `= ANY` predicate implies the
literal partial-index predicate. `EXPLAIN` showed a sequential scan both with
`plan_cache_mode = force_generic_plan` and with `force_custom_plan`. The partial
indexes were therefore dead weight for the API.

`20261023110000_list_sort_indexes` drops them and adds full sort-key indexes:

- `Idea(createdAt DESC, id DESC)`
- `Campaign(createdAt DESC, id DESC)`
- `Campaign(deadline, id)`
- `Campaign(totalRaised DESC, id DESC)`

The planner walks these in the requested order and applies the status/tier
filter as a heap filter, stopping after one page. They work with both generic and
custom plans. The trade-off is a slightly larger index and a filter over the
first ~1.5 pages of entries (two thirds of ideas and all campaign statuses match
the default filter in the fixture).

## Also fixed: creator counts

Prisma's relation `_count` compiles to a grouped aggregate over the whole `Idea`
table. Every ideas list and detail request paid for a 50k-row scan just to fill
`creator.ideasPublished`. The service now:

- removes `_count` from the creator include;
- counts only the creators on the page with
  `idea.groupBy({ by: ['creatorId'], where: { creatorId: { in: ids } } })`;
- uses `idea.count({ where: { creatorId } })` on detail.

Both count shapes use `Idea(creatorId, createdAt DESC, id DESC)`.

## Environment and fixture

- PostgreSQL 16 (Docker, local Windows host).
- `prisma migrate deploy`, then `prisma/volume-fixture.sql`, then `ANALYZE`.
- Fixture: 10k users, 50k ideas, 10k campaigns, 30k milestones and claims,
  100k idea signals, 200k contributions, 200k on-chain events.
- The API probe ran one Nest process on the same host, no TLS, no auth, no rate
  limiter. Redis 7 was enabled for the cache-on run and disabled for the origin
  run.
- The probe is closed-loop: `--concurrency 1` measures per-request latency,
  `--concurrency 20` measures a saturated single process. It is not a capacity
  test.

## API-level results

The table uses the first clean run after the index and creator-count fixes. The
origin path (`REDIS_ENABLED=false`) is the database path. The cache path used a
disposable Redis 7 container.

| Route | Before fixes, c20 p50/p95 | Origin, c20 p50/p95 | Cache, c20 p50/p95 | Cache, c1 p50/p95 |
|---|---:|---:|---:|---:|
| `GET /ideas` | 741 / 2262 ms | 202 / 282 ms | 47 / 96 ms | 4.1 / 6.7 ms |
| `GET /campaigns?sort=newest` | 257 / 582 ms | 223 / 276 ms | 53 / 114 ms | 4.3 / 7.1 ms |
| `GET /campaigns?sort=closing-soon` | 334 / 1464 ms | 200 / 288 ms | 47 / 128 ms | 4.3 / 7.9 ms |
| `GET /campaigns?sort=most-backed` | 249 / 460 ms | 196 / 276 ms | 49 / 132 ms | 4.5 / 8.4 ms |
| `GET /ideas/idea-0` | 69 / 110 ms | 79 / 111 ms | 16 / 39 ms | 3.1 / 9.2 ms |
| `GET /platform/escrow` | 3496 / 5971 ms | 1239 / 2765 ms | 14 / 26 ms | 4.2 / 12.2 ms |

Throughput at concurrency 20:

| Route | Before fixes | Origin | Cache |
|---|---:|---:|---:|
| `GET /ideas` | 22 rps | 91 rps | 387 rps |
| `GET /campaigns?sort=newest` | 69 rps | 88 rps | 320 rps |
| `GET /campaigns?sort=closing-soon` | 41 rps | 95 rps | 345 rps |
| `GET /campaigns?sort=most-backed` | 73 rps | 95 rps | 326 rps |
| `GET /ideas/idea-0` | 182 rps | 243 rps | 1016 rps |
| `GET /platform/escrow` | 5 rps | 15 rps | 1203 rps |

The origin path is CPU-bound in the single Node process, not in Postgres. A
repeat origin run on the same host measured 334 / 557 / 444 / 376 / 148 / 1221 ms
p50 and 50 / 30 / 31 / 50 / 111 / 15 rps. The spread is host and process
variance; the plan did not change. The cache-on run was stable across two runs
(46–53 ms p50 for the lists, 16 ms for detail, 14 ms for escrow). The cache is
the production mitigation for the single-process ceiling.

The escrow projection is a platform-wide `groupBy` over 200k on-chain events. Its
origin latency is real, but it is a cached public projection with a 60 s TTL, not
a per-user read. The cache turns it from the slowest route into one of the
fastest.

## SQL plan evidence for the remaining composites

These queries filter on an equality column and do not depend on a partial-index
predicate. The numbers are server-side p50/p95 over 50 runs after 10 warm-ups,
with the first 10 discarded.

| Query | Before p50 / p95 | After p50 / p95 |
|---|---:|---:|
| `IdeaSignal` by user | 11.07 / 18.33 ms | 0.23 / 0.53 ms |
| Contribution timeline | 0.45 / 0.82 ms | 0.17 / 0.25 ms |
| Milestone latest claim | 0.18 / 0.40 ms | 0.06 / 0.14 ms |
| On-chain events by campaign and type | 0.37 / 0.62 ms | 0.11 / 0.22 ms |
| Feed category candidates | 2.86 / 3.68 ms | 1.60 / 3.60 ms |

The feed category candidate query is a bounded `LIMIT 500` over a ~25 % category
slice and deliberately has no new index. A partial `(category)` index moved p50
from 2.86 ms to ~1.60 ms, which did not justify the write cost.

The parameterised idea list plan is now:

```text
Limit
  -> Index Scan using "Idea_createdAt_id_idx"
       Filter: status = ANY (...) AND "discoverabilityTier" = ANY (...)
       Rows Removed by Filter: 10
```

Execution time was 0.25 ms in `EXPLAIN (ANALYZE, BUFFERS)` on the warm fixture.
The API's 4 ms cache-hit and 16–23 ms origin p50 are dominated by Prisma,
serialization and HTTP, not by the index scan.

## What this does not prove

- No production data distribution. Re-run the fixture and queries against a
  sanitized production snapshot before a capacity decision.
- No multi-replica, multi-process or connection-pool test. The API probe is one
  process; the c20 numbers are a saturation point, not a capacity target.
- No auth, rate limiting, TLS or network latency. Those are outside the probe.
- The SQL timings are warm-cache and single-connection. They explain plans, not
  end-to-end latency.
- The cache-on numbers depend on Redis being reachable. When Redis is down, the
  API falls back to Postgres and the origin numbers apply; the cache service
  still coalesces concurrent misses, which is a separate effect.

## Reproduce

```bash
prisma migrate deploy
psql "$DATABASE_URL" -f prisma/volume-fixture.sql
```

Start the API with a disposable database and Redis, then:

```bash
node scripts/load-public-reads.mjs \
  --base http://127.0.0.1:3100 \
  --duration 10 \
  --concurrency 20 \
  --warmup 20
```

Use `--concurrency 1` for per-request latency. Set `REDIS_ENABLED=false` for the
origin path and `REDIS_ENABLED=true` with a reachable `REDIS_URL` for the cache
path. The probe is a smoke-level baseline, not a load-testing framework.
