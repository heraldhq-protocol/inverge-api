# Caching

Status: **target**. There is no cache layer today; the only Redis use is BullMQ.
This document is the contract the implementation will follow.

## What may be cached

| Key | Value | TTL | Invalidation |
|---|---|---|---|
| `v1:idea:public:{id}` | public idea projection + gate progress | 30 s ± 10 % | idea generation bump |
| `v1:campaign:public:{id}` | campaign detail projection | 30 s ± 10 % | campaign generation bump |
| `v1:list:ideas:{filterHash}:{cursor}` | one page | 20 s ± 10 % | ideas generation bump |
| `v1:list:campaigns:{filterHash}:{cursor}` | one page | 20 s ± 10 % | campaigns generation bump |
| `v1:topics` / `v1:categories` | taxonomy | 5 min | taxonomy generation bump |
| `v1:platform:escrow` | aggregates + `asOf` | 60 s | time only |
| `v1:params` | platform parameters | 10 s | delete on `PATCH /admin/params` |

## What is never cached

- `/auth/**`, `/me/**`, `/wallets/**`, `/admin/**`.
- Creator insights and any payload containing an email, provider id, KYC/AML state,
  wallet address or balance.
- Personalised feeds (the anonymous feed may be cached; a per-user feed may not).
- Anything that decides money: refund eligibility, tranche release, contribution
  confirmation. Those read authoritative state every time.

## Invalidation

Keys carry a generation counter (`v1:campaign:gen={n}`). A mutation increments the
counter instead of scanning for keys. `KEYS` and `SCAN` are forbidden on the request
path; wildcard deletion is how a cache becomes an outage.

## Failure behaviour

- Client options: `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`,
  `connectTimeout` short. A cache read has a 50 ms budget.
- Any Redis error is counted, logged at `warn`, and treated as a miss. A cache
  outage degrades latency, never correctness.
- Per-instance single-flight collapses concurrent misses for the same key, so a
  cold cache cannot stampede Postgres.
- TTLs are jittered so a popular key does not expire for every instance at once.

## Freshness is part of the response

Any cached projection that a user could mistake for live data includes:

```json
{ "asOf": "2026-10-21T12:00:00.000Z", "source": "cache" }
```

Escrow figures are a labelled projection of chain-derived events. They never
replace a chain or provider read before a financial action.

## Not a cache

`PlatformParam` values are read 5–17 times per public request today. That is fixed
first by reading them once per request (or caching the set in-process for a few
seconds), not by adding Redis to a database round-trip problem.
