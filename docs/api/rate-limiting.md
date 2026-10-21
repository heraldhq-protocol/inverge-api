# Rate limiting

Status: **target**. No limiter is installed today; every route is unbounded except
for body size. This is the policy the implementation will follow.

## Layers

Limits are chosen by what a single request can cost, not by URL prefix alone. A
request may consume more than one budget.

| Layer | Scope | Budget | On exceed |
|---|---|---|---|
| Edge | `(ip, route)` for unauthenticated traffic | 120 / min | 429, short `Retry-After` |
| Public read | `(ip, route)` for discovery | 300 / min | 429 |
| Authenticated read | `(userId)` | 600 / min | 429 |
| Auth exchange | `(ip, provider)` + `(providerUserId)` | 10 / min, 100 / hour | 429, never reveals whether an account exists |
| Write | `(userId, action)` | 30 / min | 429 |
| Financial | `(userId, action)` for fees, boosts, contributions | 10 / min, 20 / day | 429 |
| Admin | `(userId)` | 120 / min | 429 |
| Provider webhook | `(provider, eventId)` | Duplicate delivery is a no-op | 200 after first application |

A financial action additionally fails **closed**: if the limiter store is
unavailable the request is rejected, not allowed. A discovery read degrades to an
in-process limiter so a Redis outage does not take the catalogue down.

## Identity of the caller

- Authenticated requests are limited by user id, not IP, so a shared office NAT
  does not throttle every user.
- Anonymous requests use the connecting address from the trusted proxy hop only.
  `TRUST_PROXY` must be set correctly; trusting a client-supplied
  `X-Forwarded-For` makes every limit bypassable.
- The IP is used for limiting and discarded. It is never stored with an analytics
  event or a domain record (see [analytics-privacy.md](./analytics-privacy.md)).

## Response contract

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 17
RateLimit-Limit: 30
RateLimit-Remaining: 0
RateLimit-Reset: 17

{ "error": { "code": "TOO_MANY_REQUESTS", "message": "Too many requests. Retry shortly.", "requestId": "..." } }
```

`Retry-After` and the `RateLimit-*` headers are required; a client that cannot see
how long to wait will retry immediately and deepen the problem.

## Store

- Redis, shared across instances. Keys are `rl:{policy}:{subject}` with a TTL equal
  to the window, incremented in one Lua script so the window cannot be read and
  written non-atomically.
- A short connect timeout and `maxRetriesPerRequest: 1`: a limiter that blocks on
  a dead Redis is worse than one that fails open for reads.
- Local fallback is bounded (a fixed-size map) so a Redis outage cannot turn into
  unbounded process memory.
- No `KEYS`/`SCAN`. Windows expire naturally.

## What is not rate limited

The health and readiness probes, so an orchestrator never sees a 429 as an
outage.

## Ordering with authentication

The limiter runs after the session is resolved, so an authenticated caller is
counted against their user budget. The anonymous edge budget still applies first,
which means a burst from one address is capped before token verification work is
done.
