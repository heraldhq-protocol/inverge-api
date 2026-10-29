# Inverge API

Versioned REST API for Inverge: idea validation, campaigns, identity, and the
off-chain projections of a milestone-escrowed crowdfunding system.

**Base URL:** `/api/v1`
**Contract:** [`openapi.json`](./openapi.json) - generated from the running decorators, committed, and drift-checked by `pnpm openapi:check`.
**Human reference:** `/docs` (Swagger UI), served by the same process. It exposes the
same surface as the committed document.

## Contents

| Document | Covers | Status |
|---|---|---|
| [authentication.md](./authentication.md) | Session exchange, bearer token, roles, boundaries | Implemented |
| [email-verification.md](./email-verification.md) | Email capture, OTP lifecycle, gates, provider trust | Implemented; delivery setup outstanding |
| [errors.md](./errors.md) | Error envelope, stable codes, status mapping | Implemented |
| [campaign-deployment.md](../campaign-deployment.md) | Draft persistence, escrow deployment, on-chain verification, reconciliation, fee policy, blockers | Implemented against programme source; not yet verified against a deployed binary |
| [pagination-filtering.md](./pagination-filtering.md) | Cursors, filters, sort, limits | Implemented for ideas, campaigns, comments |
| [taxonomy.md](./taxonomy.md) | Canonical categories/subcategories, assignments, browse counts | Implemented |
| [caching.md](./caching.md) | Keys, TTLs, invalidation, failure behaviour | Implemented |
| [rate-limiting.md](./rate-limiting.md) | Policies, headers, proxy trust | Implemented |
| [analytics.md](./analytics.md) | Ingest contract, owner/admin reports, premium access, frontend rules | Implemented (Phase 1) |
| [product-analytics.md](./product-analytics.md) | Pipeline, taxonomy, aggregation, retention | Implemented (Phase 1) |
| [analytics-privacy.md](./analytics-privacy.md) | Event taxonomy, IP policy, retention, consent boundary | Implemented for server-side views and signals; Phase 2 target |
| [notifications.md](./notifications.md) | Read model, dispatch queue, retries, dedupe | Implemented |
| [advertising.md](./advertising.md) | Placement registry, creative lifecycle, serving, event intake, cache keys | Proposed - no routes, schema not applied |
| [realtime.md](./realtime.md) | Polling decisions and when SSE would be justified | Target — polling only, later |
| [webhooks.md](./webhooks.md) | Providers, signatures, idempotency | Partly implemented |
| [gaps.md](./gaps.md) | Route-by-route coverage against the product | Living |

## Environments

| Environment | Origin | Notes |
|---|---|---|
| Local | `http://localhost:3000/api/v1` | `docker compose up -d` for Postgres and Redis, then `pnpm prisma:deploy` |
| Staging | Deployment-specific | Must set `SESSION_JWT_SECRET`, `DATABASE_URL`, `REDIS_URL` and the credentials for any non-stub provider |
| Production | Deployment-specific | Same, plus provider credentials. `NODE_ENV=production`. CORS is an explicit allowlist; set `CORS_ORIGINS` |

`INVERGE_API_URL` in the web repository is the origin only; it must **not** include
`/api/v1`. The web app appends the version prefix.

## Versioning and compatibility

- The path carries the major version. Additive fields and new endpoints do not
  bump it.
- Breaking changes ship under `/api/v2`, with `Deprecation` and `Sunset` headers on
  the old route and a minimum two-release overlap.
- A route is only `implemented` when it appears in `openapi.json` and its service
  behaviour is covered by a test. Route-level e2e coverage is still partial; the
  gap matrix is a status report, not a certificate.
- Everything else is `partial`, `missing`, `blocked` or `deferred` in
  [gaps.md](./gaps.md).
- There is no endpoint for a state the system cannot verify. Chain-owned state
  (escrow balance, tranche release, refund) is never synthesised off-chain.

## Conventions

- JSON only; UTF-8. Timestamps are ISO 8601 UTC (`2026-10-21T12:00:00.000Z`).
- Money is an object with an explicit currency and integer atomic units or an
  exact decimal string. A monetary value is never a JSON float.
- Machine-readable identifiers are `cuid` strings unless documented otherwise.
- Every response carries `x-request-id`. Send a UUID `x-request-id` to correlate
  your own traces; anything else is replaced.
- `Authorization: Bearer <session token>` for authenticated routes. The browser
  never holds this token directly; the Next.js BFF stores it in an HttpOnly cookie.

## Generating the contract

```bash
pnpm openapi:emit     # rewrite docs/api/openapi.json
pnpm openapi:check    # fail when the committed document is stale (CI)
```

The emitter instantiates the real application module, so decorators are the only
source of truth. It does not query Postgres or Redis.

## Status of the underlying system

Campaign reads and review exist (`GET /campaigns`, `GET /campaigns/{idOrSlug}`,
`POST /campaigns/{id}/submit`, the admin review queue). Campaign drafts, their
escrow deployment attempt and publication exist too: `POST /campaigns`,
`PATCH /campaigns/:id`, `GET /campaigns/:id/draft` and
`/campaigns/:id/deployment/{prepare,submit,reconcile}`. See
[campaign-deployment.md](../campaign-deployment.md); the escrow programme has no
committed IDL, so verification against a deployed binary is still an open blocker.

Contribution, refund, milestone-claim and transparency endpoints do **not** exist.
They depend on an event indexer that is not in either repository, and chain-owned
state is never synthesised off-chain. Do not stub them; see [gaps.md](./gaps.md).
Public marketing pages therefore show campaign totals as the API's indexed record
and never as a live escrow balance.
