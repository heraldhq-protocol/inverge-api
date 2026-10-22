# Rate limiting

Status: **implemented (Stage 3)**. Code: `src/common/rate-limit/`. Policies live in
`rate-limit.policies.ts`; controllers do not carry numbers.

## Semantics

Each policy is a token bucket:

- `limit` tokens refill per `windowSeconds`.
- `burst` is the bucket capacity, i.e. the most requests accepted back-to-back.
- A request costs one token. Rejections return `429` with `Retry-After`.

This layer is abuse control, not DDoS mitigation; the CDN/WAF owns volumetric
traffic. Limits are per policy, not a global quota.

## Policies

| Policy | Routes | Key | Limit | Burst | Redis unavailable |
|---|---|---|---|---|---|
| `discovery` | public GETs (default) | IP | 120/min | 30 | bounded local bucket |
| `search` | `/ideas`, `/campaigns`, `/feed` with filter/sort query | IP | 30/min | 10 | bounded local bucket |
| `auth` | `POST /auth/session` | IP | 10/5 min | 3 | **fail closed (503)** |
| `username` | `GET /auth/check-username` | IP | 20/min | 5 | local bucket |
| `signals` | support, pre-pledge, likes, interests, other writes | user id | 30/min | 10 | local bucket |
| `comments` | comments and survey responses | user id | 10/min | 3 | local bucket |
| `dashboard` | `/ideas/:id/insights`, `/auth/me`, `mine=true` | user id | 60/min | 20 | local bucket |
| `financial` | `POST /ideas/:id/boosts` | user id | 5/min | 2 | **fail closed (503)** |
| `webhook` | `/flat-fee/webhook`, `/kyc/webhook` | IP | 300/min | 60 | process (signature is authoritative) |
| `admin` | every `/admin/**` route | user id | 60/min | 10 | **fail closed (503)** |

A user-scoped policy falls back to the IP key when no user is resolved. The limiter
is a Nest interceptor, so it runs after guards and sees the authenticated user.

`auth` is keyed by IP today, not IP + provider subject: the subject is only known
after the token is verified, and the limiter must run before that work. The 10/5 min
bucket still caps credential-stuffing per address; a per-subject limiter inside
`AuthService` is a remaining gap.

## Headers

Every limited response (allowed or rejected) carries:

```http
RateLimit-Limit: 30
RateLimit-Remaining: 17
RateLimit-Reset: 9
```

`RateLimit-Reset` is seconds until the bucket is full again when allowed, or until
the next token when rejected. A rejection also carries `Retry-After`:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 9

{ "error": { "code": "TOO_MANY_REQUESTS", "message": "Too many requests.", "requestId": "…",
  "details": { "policy": "search", "retryAfterSeconds": 9 } } }
```

A fail-closed outage returns `503` with code `RATE_LIMIT_UNAVAILABLE` and
`Retry-After: 1`.

## Identity

- Authenticated requests use the user id, so a shared office NAT does not throttle
  every user.
- Anonymous requests use Express `req.ip` after `trust proxy` is set to
  `TRUST_PROXY_HOPS`. A raw `X-Forwarded-For` is never read.
- The identifier is SHA-256 hashed before it becomes a Redis key. The IP is used for
  limiting and discarded; it is never written to analytics or domain tables.

## Store

- Redis Lua token bucket: one atomic read-modify-write per request. A split
  GET/SET would let concurrent requests spend the same token.
- Key: `v1:rl:{policy}:{sha256(identifier)}` with a TTL of the policy window
  (minimum 60 s).
- The local fallback is a token bucket in a map capped at 10,000 keys, pruned by
  idle time and then insertion order. It enforces per instance only; with N replicas
  an attacker can spend N buckets. That approximation is why financial, auth and
  admin requests fail closed instead.
- `RATE_LIMIT_ENABLED=false` disables the limiter (used by e2e). It is on by default.

## Verification

`src/common/rate-limit/rate-limit.service.spec.ts` covers the Redis path, the
denied/retry-after calculation, fail-closed policies, the local refill, key hashing
and the route resolver. `rate_limit_rejections_total{policy,reason}` is exported on
`/metrics`; `http_requests_total` still counts every 429.
