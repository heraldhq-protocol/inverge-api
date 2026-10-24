# Caching

Status: **implemented (Stage 3)**. Cache-aside over Redis for public projections;
Postgres remains the source of truth. Code: `src/common/cache/`.

## Keys

Every key carries a namespace generation: `v1:{namespace}:g{n}:{key}`. Invalidation
increments `v1:gen:{namespace}`; keys from older generations are never read again
and expire on their own TTL. There is no `KEYS`/`SCAN` and no wildcard delete.

| Key | Value | TTL | Invalidated by |
|---|---|---|---|
| `v1:idea:g{n}:{idOrSlug}` | public idea + creator projection + gate progress | 30 s ±10 % | idea update, publish, support, pre-pledge, survey response |
| `v1:ideas:g{n}:{filterHash}:{limit}:{cursor}` | one public idea page | 20 s ±10 % | same as above (a new idea appears on the next generation) |
| `v1:campaign:g{n}:{id}` | public campaign detail (anonymous view) | 30 s ±10 % | submission, review decision |
| `v1:campaigns:g{n}:{filterHash}:{limit}:{cursor}` | one public campaign page | 20 s ±10 % | submission, review decision |
| `v1:platform:g{n}:escrow` | escrow aggregates + `asOf` | 60 s | time only |

`filterHash` is the same fingerprint used by the cursor codec, so a cursor from a
different filter can never read another filter's page.

## What is never cached

- `/auth/**`, `/me/**`, `/wallets/**`, `/admin/**`.
- Creator insights and anything containing an email, provider id, KYC/AML state,
  wallet address or balance.
- `mine=true` idea and campaign lists, and any campaign detail requested by an
  authenticated user (it carries `myContribution`).
- Personalised feeds.
- Anything that decides money: refund eligibility, tranche release, contribution
  confirmation. Those read authoritative state every time.

Platform parameters are not in Redis: `PlatformParamsService` keeps a 5-second
in-process snapshot and invalidates it on write. It is a read-amplification fix,
not a shared cache.

## Failure behaviour

- Client: `lazyConnect`, `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`,
  500 ms connect timeout, 250 ms command timeout.
- A failed command opens a 5-second breaker. During the breaker every read is a miss,
  so a dead Redis costs at most one timeout per instance per window.
- Errors are swallowed, logged once at `warn`, and counted (`cache_operations_total{result="read_error"}`).
  A cache outage degrades latency, never correctness.
- Per-instance single-flight collapses concurrent misses for one key, so a cold cache
  cannot stampede Postgres. Single-flight is registered before the Redis read.
- TTLs are jittered by ±10 % so a popular key does not expire everywhere at once.
- `REDIS_ENABLED=false` turns the layer off entirely (tests, a box that must not
  dial Redis). Reads go straight to Postgres.

## Freshness

Cached projections are eventually consistent within their TTL plus the 5-second
generation memo. Only the escrow projection advertises freshness explicitly:

```json
{ "asOf": "2026-10-21T12:00:00.000Z", "heldUsd": "…", "releasedUsd": "…" }
```

Escrow figures are a labelled projection of chain-derived events. They never replace
a chain or provider read before a financial action.

## Verification

`src/common/cache/cache.service.spec.ts` covers hit/miss, single-flight, rejected
loaders, generation bumps, malformed values, TTL jitter, a disabled store and a
Redis outage. The full e2e suite runs with Redis disabled, proving the fallback path.

The opt-in `test/redis.e2e-spec.ts` runs the same cache against a real server:
single-flight on concurrent misses, a generation bump, the Lua token bucket and a
green readiness probe. Start Redis, then:

```powershell
$env:REDIS_E2E = "true"
node ./node_modules/jest/bin/jest.js --config jest-e2e.config.js `
  test/redis.e2e-spec.ts --runInBand --forceExit
```

The suite is skipped without `REDIS_E2E=true`, so CI stays infrastructure-free.
On a cold connection the first command can exceed the 250 ms command timeout and
open the 5 s breaker. That is the intended degradation path; auth, financial and
admin policies fail closed during that window, and readiness reports `degraded`
without failing (Postgres remains the only hard dependency).
