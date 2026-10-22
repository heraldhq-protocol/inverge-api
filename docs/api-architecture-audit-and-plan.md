# API architecture, performance, security and documentation — audit and plan

Status: **Planning. No production code changed by this document.**
Date: 2026-10-21
Scope: `inverge-api` (contract owner) and `inverge-web` (consumer)
Authorities: `docs/Inverge_PRD_SRS_v1.2.md`, `inverge-web/docs/PROJECT_BRIEF.md`,
`inverge-web/docs/ARCHITECTURE.md`, `inverge-web/docs/ENGINEERING_STANDARDS.md`,
`inverge-web/docs/DECISIONS.md`, `inverge-api/docs/web-ui-api-gaps.md`

This document is the Phase A deliverable: what the repository actually contains, what is
wrong with it, and the sequence that fixes it. Every claim below was read from source.
Where something does not exist, it says so rather than describing an intended design.

---

## 1. Verified inventory

| Area | What exists today | Evidence | What is absent |
|---|---|---|---|
| Web framework | Next.js **16.3.5**, React 19.3.0, App Router under `src/app`, Server Components by default | `inverge-web/package.json`, `src/app/**` | No `middleware.ts` / `proxy.ts` |
| Web data access | **Preview fixtures**. Every product surface reads `src/features/*/content/preview-*` through a `server/` seam | `src/features/campaigns/server/campaigns.ts:23`, `src/features/ideas/server/idea-workspace.ts:6` | No API client, no generated types, no TanStack Query, no `openapi-typescript` |
| Web → API integration | **Only auth.** Four Route Handlers call the API | `src/app/api/auth/{session,profile,username-available,sign-out}/route.ts`, `src/features/auth/server/session-user.ts:135` | Every product read/write is local or mocked |
| Web session | HttpOnly `inverge_session` cookie, 1 h, `SameSite=Lax`, `Secure` in production; BFF exchanges the Web3Auth `id_token` | `src/features/auth/server/session.ts:18-44`, `src/app/api/auth/session/route.ts:83-145` | Token refresh, revocation, server route gate for `/d/*` |
| Web admin | `getProgrammeAdminAccess()` denies in production, allows a labelled preview in dev | `src/features/programmes/server/access.ts:29-54` | No live admin session, no role projection from the API |
| Web dashboard gate | `getDashboardViewer()` **falls back to a preview identity when unauthenticated** | `src/features/app-shell/server/viewer.ts:33-45` | A real server-side gate; `/d/*` is not protected today |
| API framework | NestJS 11, Express 5, CommonJS | `inverge-api/package.json` | — |
| API surface | 16 controllers, **63 route handlers**, **no version prefix** | `src/modules/**/*.controller.ts`, `src/main.ts:14` | `api/v1` |
| API documentation | Swagger UI at `/docs`, JSON at `/docs-json`, generated at boot | `src/main.ts:29-36` | Committed spec, response schemas, generated client, drift check |
| Database | PostgreSQL 16, Prisma **v7** driver adapter, 27 models, 22 enums, 14 migrations | `prisma/schema.prisma`, `prisma/migrations/`, `src/prisma/prisma.service.ts` | `IdeaSignal(userId)`, campaign sort indexes, partial indexes |
| Connection management | `node-pg` pool `max: 25`, 15 s connect timeout, 10 s idle | `src/prisma/prisma.service.ts:10-18` | Pool metrics, saturation alarm, environment-specific sizing |
| Redis | BullMQ root only; one repeatable queue (`metrics-snapshot`) | `src/modules/queue/queue.module.ts`, `src/modules/metrics/snapshot.{scheduler,processor}.ts` | Cache, rate-limit store, locks, pub/sub |
| Cache | **None** | no `cache-manager`, no cache module | Cache keys, TTLs, invalidation |
| Rate limiting | **None** | no `@nestjs/throttler` in `package.json`; no guard | Route policies, headers, 429s, proxy trust |
| Request identity | **None** | no middleware, no filter, no interceptor | `x-request-id`, correlation across jobs |
| Error contract | Nest defaults (`{statusCode,message,error}`); raw `HttpException` messages | no `APP_FILTER` anywhere | Stable error codes, validation detail shape, redaction |
| Auth model | Web3Auth/Privy token → HS256 session JWT, 1 h, `sub` only | `src/modules/auth/session.service.ts`, `ports/wallet/web3auth-wallet.adapter.ts` | Issuer/audience claims, refresh, revocation, production secret guard |
| Authorization | `PrivyAuthGuard` (session), `OptionalPrivyAuthGuard`, `AdminGuard`, `KycVerifiedGuard` | `src/modules/auth/guards/*` | `AdminGuard` on the moderation controller; persisted admin audit |
| Queues / jobs | 1 BullMQ queue + daily repeatable | `metrics.module.ts:12` | Notification dispatch, webhook follow-up, analytics aggregation |
| Webhooks | Paystack flat-fee (raw-body HMAC), Didit KYC/AML/KYB (HMAC + re-fetch) | `flat-fee.controller.ts`, `kyc.controller.ts:20`, `ports/kyc/didit-kyc.adapter.ts:140-180` | Event-id inbox, replay tooling, out-of-order tests |
| Analytics | **None** | no event table, no ingestion route | Taxonomy, storage, aggregation, retention, privacy policy |
| Real-time | **None** | no WS/SSE/polling infrastructure | Justified only where a use case exists |
| Observability | `Logger` to stdout, no metrics endpoint, no health check | grep across `src` | Structured logs, request IDs, metrics, alerts, tracing |
| CI | **None** | no `.github/`, no GitLab CI | Lint/type/test/build, contract drift, dependency audit |
| Tests | 284 unit tests (268 pass / 16 fail in one pre-existing suite), 7 e2e suites requiring live Postgres + Redis | `src/**/*.spec.ts`, `test/*.e2e-spec.ts` | Contract tests, cache/rate-limit tests, performance baselines |
| Solana escrow program | **Does not exist in either repository** | no `Anchor.toml`, no `programs/`; port comment says "deferred to Phase 2" | On-chain escrow, indexer, chain-derived totals |
| Payments / contributions | Flat-fee charges only (boost, application fee) | `modules/flat-fee`, `modules/boosts` | Contributions, receipts, refunds, milestones |

### 1.1 What the product screens depend on

`inverge-api/docs/web-ui-api-gaps.md` is the existing, accurate backlog of web-driven API
asks. It is **stale in three places** and this plan corrects them rather than duplicating the
document:

1. It refers to `inverge-web/src/lib/campaigns/campaigns-api.ts` and a `USE_FIXTURES` flag.
   That file does not exist; the real seam is `src/features/campaigns/server/campaigns.ts`
   with `campaignsDataSource: "preview"`.
2. It refers to `docs/campaign-data-contract.md` and `docs/ideas-campaigns-brief.md`. Neither
   exists in `inverge-web/docs/`.
3. It assumes the web stack is "TanStack Query + `openapi-typescript`". Neither dependency is
   installed. The web currently fetches on the server and uses `useState` locally.

---

## 2. Journey traces

Each trace follows the request to the storage and back. "Contract" means the shape the web
would receive, not a documented schema (none is documented).

### 2.1 Public campaign discovery

| Step | Today |
|---|---|
| Frontend request | `/campaigns` → `getCampaignDiscoveryView()` reads `previewCampaigns`; no HTTP |
| Backend handler | `GET /campaigns` in `CampaignsController.list` |
| Service | `CampaignsService.list` (`campaigns.service.ts:18`) |
| Storage | `campaign.findMany` with `include creator + creatorProfile + idea + milestones.claims`; `skip/take` |
| Cache | none |
| Authz | `OptionalPrivyAuthGuard`; `mine=true` requires a user |
| Contract | Bare array, no total, no cursor; `most-delivered` is sorted **after** pagination |
| Issues | Deep include returns full `Idea` bodies and every milestone/claim for a list card; offset pagination; in-memory resort breaks page semantics |

### 2.2 Campaign / idea detail

| Step | Today |
|---|---|
| Frontend request | Fixture lookup by slug; `notFound()` locally |
| Backend handler | `GET /campaigns/:id`, `GET /ideas/:id` (id **or** slug) |
| Service | `CampaignsService.get`, `IdeasService.get` |
| Storage | Campaign: full `idea`, milestones + latest claim, caller's contribution. Idea: full row + creator + 5 parameter reads |
| Cache | none |
| Authz | Public; `myContribution` scoped to caller |
| Contract | Raw Prisma row plus a public creator projection; no view-model boundary |
| Issues | Five extra `PlatformParam` queries per idea read; campaign detail has no slug; `myContribution` is the only per-user field |

### 2.3 Authenticated support / vote / feedback

| Step | Today |
|---|---|
| Frontend request | Local component state only (`idea-actions`, `feedback-dialog`); drafts in `localStorage` / `sessionStorage` |
| Backend handler | `POST /ideas/:id/support`, `POST /ideas/:id/pre-pledge`, `POST /ideas/:id/survey/responses`, `POST /ideas/:id/comments` |
| Service | `IdeasService.support/prePledge`, `SurveyService.respond`, `CommentsService.create` |
| Storage | Transaction: signal upsert + synchronous full metric recompute (`MetricsService.recompute`) |
| Cache | none |
| Authz | `PrivyAuthGuard`, `assertSignalable` restricts to published/validating ideas |
| Contract | Recompute result object; idempotent by unique `(ideaId,userId,type)` |
| Issues | No idempotency key for HTTP retries (safe today because of the unique constraints, but the response differs on repeat); no rate limit; no abuse control on comments/feedback |

### 2.4 Creator dashboard and analytics

| Step | Today |
|---|---|
| Frontend request | Preview fixtures per route; `insights` pages read `previewAnalytics` |
| Backend handler | `GET /ideas/:id/insights` |
| Service | `InsightsService.getInsights` |
| Storage | Idea row, **all** snapshots for the idea, all pre-pledges (with user fields), survey questions/responses, top comments, 5 parameter reads |
| Cache | none |
| Authz | `creatorId === userId` else 403 |
| Contract | One large JSON object; no period filter; no freshness marker |
| Issues | Unbounded history per request; full pre-pledge scan in application memory; no aggregate projection |

### 2.5 Authentication and account-scoped access

| Step | Today |
|---|---|
| Frontend request | `POST /api/auth/session` with the Web3Auth `id_token` |
| Backend handler | BFF route → `POST /auth/session` |
| Service | `AuthService.authenticate` → provider JWKS verify → user upsert → `SessionService.sign` |
| Storage | `User`, `CreatorProfile`, `WalletAccount` |
| Cache | none |
| Authz | Every later call: `PrivyAuthGuard` verifies HS256 and loads the user by `sub` |
| Contract | `{ user, creator, sessionToken, requiresOnboarding }`; the BFF strips the token into a cookie |
| Issues | No issuer/audience on the session JWT; default secret accepted in production; `GET /auth/me` returns the whole user row; dashboard routes are not gated when the session is missing |

### 2.6 Financially sensitive action (where it exists)

The only money-adjacent implementation is the flat-fee rail (boost purchase and campaign
application fee). **No contribution, escrow, milestone, refund or withdrawal endpoint exists.**
There is no Solana program and no indexer in either repository.

| Step | Today |
|---|---|
| Backend handler | `POST /flat-fee/webhook`, `POST /ideas/:id/boosts` |
| Provider | Paystack adapter or offline stub behind `FLATFEE_PROVIDER` |
| Idempotency | `processorRef` unique lookup; a non-`PENDING` charge returns `{ idempotent: true }` |
| Authority | Provider status, not client input |
| Issues | No webhook event-id inbox, no replay tooling, no provider reconciliation job, synchronous processing in the request |

### 2.7 Administrative operation

| Step | Today |
|---|---|
| Frontend | `/admin/*` gated by `getProgrammeAdminAccess()`; no API calls; local preview store |
| Backend | `GET/PATCH /admin/params`, `GET /admin/params/audit`, `GET/PATCH /admin/boost-prices`, `GET /admin/users`, `PATCH /admin/users/:id/role`, campaign review routes |
| Authz | `PrivyAuthGuard` + `AdminGuard` (DB role or `ADMIN_ALLOWLIST`) |
| Audit | Parameter changes audited; **role changes logged to the console only** |
| Issues | `POST /admin/moderation/screen` is **not** behind `AdminGuard` (any signed-in user can invoke it); no general audit trail; no admin read model for ideas/moderation |

---

## 3. Findings

Priority: **P0** blocks a safe integration; **P1** material correctness/performance/security
risk; **P2** hygiene or scale.

| # | Current state | Evidence | Issue | Recommended change | Risk of change | Pri |
|---|---|---|---|---|---|---|
| 1 | No version prefix | `src/main.ts:14` | Every route is unversioned; any contract change is breaking | `app.setGlobalPrefix('api/v1')`; update the four web auth calls in the same change; document deprecation | Breaking for unknown consumers | P0 |
| 2 | No error envelope | no global filter | Clients cannot branch on errors; Nest leaks messages; Prisma errors surface as 500s | `AllExceptionsFilter` + `AppError` codes + request ID + validation details | Touches every response | P0 |
| 3 | No request ID | grep: none | Cannot correlate web → API → job → provider | Middleware: validate inbound `x-request-id` (UUID) or generate; echo header; include in logs and errors | Low | P1 |
| 4 | `POST /admin/moderation/screen` has only `PrivyAuthGuard` | `moderation.controller.ts:16` | Any signed-in user can run the moderation harness (AI cost, case spam) | Add `AdminGuard`; keep a separate submission-time internal call | Low | P0 |
| 5 | Role changes only logged to stdout | `admin.controller.ts:145-149` | FR-901 expects an auditable record of privileged actions | General append-only `AdminAuditEvent` (actor, action, target, before/after); reuse for moderation decisions | Schema addition | P1 |
| 6 | Public profile scans all users | `auth.service.ts:188-204` | O(N) full-table read + application-side matching on **every** profile request | `creatorProfile.findUnique({username})` then `user.findUnique({id})`; cursor-paginate published ideas | Low | P0 |
| 7 | Offset pagination + post-page sort | `ideas.service.ts:129-174`, `campaigns.service.ts:53-98` | Page 2 can repeat/skip items; `most-delivered` sorts only the current page | Keyset cursor on `(sortKey, id)`; remove in-memory resort; expose `nextCursor`/`hasMore` | Response shape change | P1 |
| 8 | `@Type(() => Boolean)` on `mine` | `dto/idea.dto.ts:162`, `dto/campaign.dto.ts:59` | `?mine=false` becomes `true`; anonymous callers get 403 | Explicit `@Transform` accepting `"true"|"false"|true|false` | Low | P0 |
| 9 | Parameter lookups per request | `platform-params.service.ts:15-23`; `feed.service.ts:516-570` (17 reads), `ideas.service.ts:188-195` (5) | 5–17 DB round trips per public request for data that changes rarely | One `getAll()` read cached in process for 5–10 s, invalidated on `set()`; Redis version bump for multi-instance later | Slight staleness after admin edit | P1 |
| 10 | Escrow stats loads every event | `campaigns.service.ts:321-360` | Unbounded memory + CPU per public request; `heldUsd` mixes off-chain `totalRaised` with chain releases | SQL `aggregate`/`groupBy`; cache 60 s with `asOf`; keep `OnChainEvent` as the released/refunded authority | Correctness review needed | P1 |
| 11 | Feed writes on every read | `feed.service.ts:444-451` | `updateMany` increment on each feed request = hot row churn | Buffer impressions in Redis and flush via the queue | Slightly delayed exposure accounting | P2 |
| 12 | Deep includes on list endpoints | `campaigns.service.ts:53-68` | Full idea bodies, all milestones and claims for masonry cards | Explicit `select` for the list projection; a dedicated detail query | Low | P1 |
| 13 | Missing indexes | `schema.prisma`: `IdeaSignal` has `@@index([ideaId])` only | `ideaSignal.findMany({ where: { userId } })` (feed personalisation, public profile) scans the table | Add `@@index([userId])`, campaign sort indexes, `Contribution(campaignId, createdAt)`, `OnChainEvent(eventType)` | Write cost | P1 |
| 14 | No cache layer | package.json | Every read hits Postgres; no stampede protection | Redis cache-aside with versioned keys, jittered TTL, single-flight, 50 ms read budget | Stale reads | P1 |
| 15 | No rate limiting | package.json | Auth, feedback, AI moderation and webhooks are unbounded | Layered policies per route class; Redis store; local bounded fallback | Availability tuning | P0 |
| 16 | 10 MB JSON body | `main.ts:16-17` | Trivial memory amplification | 1 MB default; explicit override only where justified | Low | P1 |
| 17 | Wildcard CORS | `main.ts:19` | Any origin may call the API with a bearer token | Explicit `WEB_ORIGINS` allowlist; no credentials | Deployment config | P1 |
| 18 | Swagger public | `main.ts:36` | Full surface enumerated in production | Serve `/docs` only outside production or behind admin auth; keep `/openapi.json` for tooling | Low | P2 |
| 19 | Session secret default | `env.validation.ts:63` | `change-me-in-production` boots successfully in production | Refuse to start in production when unset/equal to the default; add `iss`/`aud` | Ops must set a secret | P0 |
| 20 | `/auth/me` returns the user row | `auth.service.ts:95-99` | Over-broad projection (provider id, flags) for a UI bootstrap call | Explicit `select` + `creator` + `requiresOnboarding` | Web field check | P1 |
| 21 | Dashboard is not gated | `app-shell/server/viewer.ts:33-45` | `/d/*` renders a preview identity to anonymous visitors | Redirect anonymous users to `/auth?next=`; preview only when `NEXT_PUBLIC_PREVIEW_AUTH` is explicitly on | UX change | P0 (before data is live) |
| 22 | No analytics, no privacy policy | no event model | Creator metrics would otherwise be invented or collect raw IPs | Event table **without** IP; edge-derived country; documented retention | None yet | P1 |
| 23 | No health/readiness | grep: none | Deployment cannot distinguish "process up" from "DB/Redis ready" | `GET /health/live`, `GET /health/ready` (DB ping, queue ping) | Low | P1 |
| 24 | No CI | no `.github/` | No automated lint/type/test/build/contract checks | GitHub Actions matrix for both repos | Infrastructure | P1 |
| 25 | Broken unit suite | `ideas.service.spec.ts` mock lacks `idea.findFirst` | 16 tests fail before any change; hides regressions | Add the missing mock method (test-only) | None | P0 (prereq) |

### 3.1 Corrections to the existing backlog

`web-ui-api-gaps.md` remains the single index of web-driven asks. This plan adds what it does
not cover (contract, errors, rate limits, caching, analytics, operations) and does not restate
its item-by-item shapes.

---

## 4. Target architecture and conventions

### 4.1 API contract

- **Versioned REST under `/api/v1`**, OpenAPI 3.1 as the authoritative schema.
- Resource names plural, kebab-case; state transitions as sub-resources
  (`POST /ideas/:id/publish`, `POST /campaigns/:id/review`), never `?action=`.
- Collections return:

  ```json
  {
    "data": [ ... ],
    "page": { "limit": 24, "nextCursor": "eyJ2Ijox...", "hasMore": true, "total": null, "totalKind": "omitted" }
  }
  ```

  `total` is `null` unless a cheap, cached count exists; when present it is labelled
  `exact | estimated` and carries `asOf`.
- Single resources return the object directly (no wrapper). 201 for creation, 204 for a
  deletion with no body, 202 for accepted asynchronous work.
- Every response carries `x-request-id`; every error body is:

  ```json
  {
    "error": {
      "code": "CAMPAIGN_NOT_FOUND",
      "message": "Campaign not found.",
      "requestId": "5c1f...",
      "details": [{ "field": "take", "code": "MAX", "message": "take must be <= 100" }]
    }
  }
  ```

- Status codes: 400 validation, 401 unauthenticated, 403 authorized-but-forbidden, 404,
  409 state conflict, 422 semantic rejection, 429 with `Retry-After`, 503 dependency
  unavailable. No 200 with `{ ok: false }`.
- Dates: ISO 8601 UTC with `Z`. Money: `{ "amount": "1250.00", "currency": "USDC",
  "decimals": 6 }` strings or integer atomic units; **never** a JSON number for a monetary
  value in new/changed endpoints. Legacy numeric fields stay until their endpoint is revised.
- Deprecation: `Deprecation` + `Sunset` headers, a minimum two-release overlap, and an entry in
  the API changelog. Breaking changes only at a version boundary.
- Idempotency: `Idempotency-Key` (UUID) accepted on retryable mutations (boost purchase,
  flat-fee initiation, campaign submit, future contributions/refunds). Stored in Postgres
  (`IdempotencyRecord`, unique `(key, userId)`), replay returns the original status/body, a
  body mismatch returns `409 IDEMPOTENCY_KEY_REUSED`.

### 4.2 Validation and types

- Keep `class-validator` + `class-transformer` + the global `ValidationPipe`
  (`whitelist`, `forbidNonWhitelisted`, `transform`). It already blocks mass assignment.
- Add `enableImplicitConversion: false` (explicit `@Type`), and explicit boolean transforms.
- Validate path IDs with a `ParseCuidPipe` (or `@IsString @Length`), not raw `@Param`.
- Enable the `@nestjs/swagger` CLI plugin in `nest-cli.json` and annotate responses with DTOs
  so the emitted spec describes what is actually returned.
- Generate web types from the committed spec with `openapi-typescript`; wrap them in a thin
  `src/lib/api/` fetcher with runtime `zod` validation for money, authorization and settlement
  fields. Generated files are never hand-edited.
- Contract drift: `pnpm openapi:check` regenerates and diffs; CI fails on drift.

### 4.3 Pagination

- Keyset by default. Cursor payload: `{ v: 1, k: [sortValue, id], f: <filterHash> }`,
  base64url-encoded, HMAC-free (opaque, not secret), validated on decode.
- Every list has a **unique tie-breaker** (`id`). Filters and sort are part of `f`; a cursor
  from a different filter/sort is rejected with `400 INVALID_CURSOR` so a client cannot silently
  mix result sets.
- Limits: `limit` 1–50 for cards, 1–100 for admin tables, default 24/50. No `skip` beyond
  `MAX_OFFSET` (e.g. 1,000) once cursor pagination lands; `skip` is deprecated and removed.
- Counts: never `COUNT(*)` on discovery. Use a cached/estimated total or omit it. Admin tables
  may use an exact count because their volume is bounded.
- Sorting by a volatile aggregate (`most-backed`, `most-delivered`) is served from a refreshed
  ranking projection, not `ORDER BY` over a join, once volume justifies it.

### 4.4 Authentication and authorization

- Keep the BFF pattern: the provider token is exchanged once; the browser only holds an
  HttpOnly cookie; the API only accepts the Inverge session.
- Harden the session: `iss: inverge`, `aud: inverge-web`, explicit `alg`, production secret
  guard, 1 h access token. Refresh is a later, explicit decision (see §10).
- `PrivyAuthGuard` loads the user per request. Add a short-lived (30 s) in-process user cache
  keyed by `sub` only after cache invalidation on role/ban/KYC change is in place.
- Every resource route re-checks ownership in the service. `AdminGuard` on every `/admin/*`
  route, including moderation.
- Frontend role checks remain presentation only. The web must fetch capabilities from the API,
  not derive them from a local flag.

### 4.5 Web data fetching

| Surface | Pattern |
|---|---|
| Public marketing, ideas, campaigns, topics | Server Components; shared server data-access functions in `features/<domain>/server`; `fetch` with explicit `next: { revalidate }` or `cache: "no-store"` per resource |
| Public long pages (campaign detail) | Server render + `Suspense` boundaries for below-the-fold tabs; no client fetch for first paint |
| Creator dashboard | Server fetch of the overview only; each heavy panel is a separate Suspense boundary or a route-level fetch; never one 13-chart payload |
| Interactions (support, feedback, save) | Client mutation to a same-origin Route Handler (BFF), optimistic only where rollback is trivial; **financial actions always server-confirmed** |
| Notifications | Read on navigation + bounded polling (see §7) |
| Saved campaigns | Stays device-local (D-023) until a bookmark endpoint is explicitly approved |

No TanStack Query is installed and none is required for the patterns above. Adopt it only if a
screen demonstrably needs client cache orchestration; record the decision if so.

### 4.6 Observability

- Structured JSON logs with `requestId`, `route`, `status`, `durationMs`, `userId` **hashed**,
  no tokens, no raw IP, no provider payloads.
- Metrics: route/status counts, P50/P95/P99 latency, DB pool saturation, cache hit ratio,
  Redis errors, queue depth/age, 429 counts, provider latency.
- `GET /health/live` (process) and `/health/ready` (DB `SELECT 1`, Redis `PING`).
- Trace propagation: accept `traceparent` if present, emit `x-request-id` regardless.
- Alerts: 5xx rate, P95 latency, pool exhaustion, Redis down, queue backlog, reconciliation lag.
- NFR-05 (3 s on mid-range Android/3G) is validated with Lighthouse/WebPageTest on the built
  app, not inferred from server timings.

---

## 5. Endpoint inventory

Legend: **exists** (no contract change), **change** (exists, needs work), **missing**,
**deferred** (explicitly not built now), **no** (not wanted).

### 5.1 Public discovery

| Route | Status | Notes |
|---|---|---|
| `GET /ideas` | change | cursor pagination, stable sort, remove post-page sort, `mine` boolean fix |
| `GET /ideas/:slug` | change | accept slug explicitly, narrow projection, cache, parameter read reduction |
| `GET /campaigns` | change | list projection, cursor, sort correctness, slug support |
| `GET /campaigns/:slug` | change | add slug lookup; keep `:id` |
| `GET /categories` | missing | derive from a canonical taxonomy module shared with campaigns |
| `GET /topics` | missing | gap item 21 |
| `GET /campaigns/:id/related` | missing | recommendation output must be explainable and exclude paid placement from organic ranking |
| `GET /transparency` | missing | chain-derived only; returns `asOf` and `source` |
| `GET /feed` | change | cursor + total policy (gap item 22), buffered impressions |
| `GET /ideas/:id/comments` | change | author projection (gap item 2), cursor |
| `GET /ideas/:id/survey` | exists | public preview; keep |

### 5.2 Authenticated participation

| Route | Status | Notes |
|---|---|---|
| `POST /ideas/:id/support` / `DELETE` | change | idempotency key, rate limit |
| `POST /ideas/:id/pre-pledge` / `DELETE` | change | idempotency, string money on the wire |
| `POST /ideas/:id/survey/responses` | change | rate limit; this is the feedback endpoint (no `/feedback` alias) |
| `POST /ideas/:id/comments` | change | rate limit, moderation |
| `POST/DELETE /campaigns/:id/bookmarks` | no | deliberately not wanted (`web-ui-api-gaps.md`, "Explicitly not asks") |
| `GET /me` | change | narrow projection of `/auth/me` |
| `GET /me/activity` | missing | unified read model (support, pre-pledge, comment, backing) |
| `GET /me/saved` | deferred | saved campaigns are device-local (D-023) |
| `GET /me/notifications` | missing | notifier exists, no read model |
| `GET /me/pre-pledges` | missing | web dashboard has the screen |
| `GET /me/dashboard` | missing | aggregate of the few numbers the home needs; do not bundle charts |

### 5.3 Creator workspace

| Route | Status | Notes |
|---|---|---|
| `POST /ideas`, `PATCH /ideas/:id`, `POST /ideas/:id/publish` | exists | add idempotency to create |
| `GET /ideas/:id/insights` | change | period filter, aggregate projection, bounded history |
| `GET /creator/overview` | missing | list + counts, not all analytics |
| `GET /creator/campaigns/:id/analytics` | missing | depends on contributions/indexer |
| `POST /campaigns` | missing | no create path today; gap item 17 |
| `PATCH /campaigns/:id` | missing | draft editing |
| `POST /campaigns/:id/submit` | exists | add idempotency |
| Milestone management | deferred | no program; do not fake |
| Reward tiers | missing | gap item 19; schema addition |

### 5.4 Financial and escrow

| Route | Status | Notes |
|---|---|---|
| `POST /ideas/:id/boosts`, `GET /ideas/:id/boosts` | exists | idempotency |
| `POST /flat-fee/webhook` | change | event inbox, replay tooling |
| `POST /wallets/link`, `GET /wallets`, `PATCH /wallets/:id/role` | exists | — |
| Contributions, receipts, milestones, objections, rulings, refunds, withdrawals | deferred | Requires the Anchor program and indexer; **do not stub** |
| `GET /campaigns/:id/receipts` | deferred | read model over `OnChainEvent` (gap item 7) |

### 5.5 Administration

| Route | Status | Notes |
|---|---|---|
| `GET/PATCH /admin/params`, `GET /admin/params/audit` | exists | — |
| `GET/PATCH /admin/boost-prices` | exists | — |
| `GET /admin/users`, `PATCH /admin/users/:id/role` | change | persist audit; cursor |
| `GET /admin/campaigns`, `GET /admin/campaigns/:id`, `POST /admin/campaigns/:id/review` | exists | — |
| `POST /admin/moderation/screen` | change | **add `AdminGuard`** |
| Moderation queue + case decision | missing | FR-1004 human review has no queue endpoint |
| Idea moderation actions | missing | — |
| Category/topic management | missing | — |
| General audit log | missing | params-only today |
| Dispute review | deferred | no escrow |

### 5.6 Versioning impact

The only known consumer today is `inverge-web`'s four auth Route Handlers. Moving to
`/api/v1` is therefore a coordinated one-file-per-handler change, not a compatibility project.
If an unlisted consumer exists, an alias window is the safer choice (see §10, decision 1).

---

## 6. PostgreSQL plan

Ordered by evidence, not aesthetics. Validate every index with `EXPLAIN (ANALYZE, BUFFERS)` on
a representative dataset before merging.

1. **`IdeaSignal(userId)`** — used by feed personalisation (`feed.service.ts:367`) and the
   public profile. Currently a sequential scan.
2. **Campaign discovery sorts** — `(status, deadline)`, `(status, createdAt)`,
   `(status, totalRaised)`; `reviewStatus` queue already has `@@index([reviewStatus, submittedAt])`.
3. **`Contribution(campaignId, createdAt)`** and **`OnChainEvent(campaignId, eventType)`** —
   receipt timelines and escrow aggregates.
4. **`MilestoneClaim(milestoneId, submittedAt)`** — "latest claim" per milestone.
5. **`Idea(category, status, createdAt)`** and **`Idea(discoverabilityTier, status, createdAt)`** —
   discovery filters; replace the single-column indexes when they are proven redundant.
6. Partial indexes (`WHERE status IN (...)`, `WHERE banned_at IS NULL`) cannot be expressed in
   the Prisma schema; add them in a raw-SQL migration with a comment explaining why.
7. **Query shape fixes before indexes**: replace `findMany` + application filtering/sorting with
   `where`/`orderBy`/`select`; replace the full-event scan in escrow stats with `groupBy`.
8. **Aggregates**: keep `IdeaMetricSnapshot` as the analytics source. Add a daily campaign
   aggregate only when contributions exist. Never let an analytics projection decide refund
   eligibility or tranche availability (SRS invariant 7).
9. **Pool**: 25 is fine for one instance; make it `DB_POOL_MAX` and document the
   `instances × max` relationship with Postgres `max_connections`. Add saturation metrics.
10. **Transactions**: keep them short; never hold one across an external call. The existing
    `submit` transaction does provider-free work — good. Future provider calls must happen
    before/after, not inside.
11. **Constraint review**: `Contribution.txSignature` and `OnChainEvent.txSignature` are unique
    (correct). Add a check constraint for non-negative amounts where missing.

---

## 7. Redis, rate limiting, analytics, real-time, jobs

### 7.1 Cache (cache-aside)

| Key | Value | TTL | Invalidation |
|---|---|---|---|
| `v1:idea:public:{id}` | public idea projection + gate progress | 30 s ± 10 % | generation bump on update/publish |
| `v1:campaign:public:{id}` | detail projection | 30 s | generation bump on review/launch |
| `v1:list:ideas:{filterHash}:{cursor}` | page | 20 s | ideas generation bump |
| `v1:list:campaigns:{filterHash}:{cursor}` | page | 20 s | campaigns generation bump |
| `v1:topics` / `v1:categories` | taxonomy | 5 min | taxonomy generation bump |
| `v1:platform:escrow` | aggregates + `asOf` | 60 s | time only |
| `v1:params` | all platform params | 10 s | explicit delete on `PATCH /admin/params` |

- Versioned namespace: keys include `v{n}:{resource}:gen={counter}`; invalidation increments a
  counter instead of `KEYS`/`SCAN`. No wildcard deletion.
- Never cached: `/auth/**`, `/me/**`, `/ideas/:id/insights`, `/admin/**`, `/wallets/**`,
  personalised feeds, anything containing an email, provider id, KYC/AML state or balance.
- Failure: Redis client with `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, 50 ms
  read budget, errors downgraded to a counter + warn log. Read path falls back to Postgres with
  per-instance single-flight so a cold cache cannot stampede the DB.
- No financial authority is cached: escrow stats are a labelled projection, and any refund or
  tranche call re-reads authoritative state.

### 7.2 Rate limiting

Policies live in one config module (`rate-limit.policies.ts`), not in controllers.

| Group | Key | Limit | Burst | Redis down |
|---|---|---|---|---|
| Public discovery reads | IP (trusted proxy) | 120/min | 30 | bounded local bucket |
| Search / filtered lists | IP | 30/min | 10 | bounded local bucket |
| Auth session exchange | IP + provider subject | 10/5 min | 3 | fail closed (429/503) |
| Username check | IP | 20/min | 5 | local bucket |
| Signals (support, pre-pledge) | user id | 30/min | 10 | local bucket |
| Comments / feedback | user id | 10/min | 3 | local bucket |
| Insights / dashboard reads | user id | 60/min | 20 | local bucket |
| Boost / fee initiation | user id | 5/min | 2 | **fail closed** |
| Provider webhooks | provider + signature | signature-verified; 300/min IP guard | — | process (durable receipt) |
| Admin mutations | user id | 60/min | 10 | fail closed |

- Key derivation never trusts raw `X-Forwarded-For`; `TRUST_PROXY_HOPS` configures Express
  `trust proxy` and only the resolved `req.ip` is used.
- Headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, plus `Retry-After` on
  429. Document that these are per-policy, not global.
- Redis store is required for multi-instance enforcement. The local fallback is a bounded
  token bucket per instance and is documented as approximate.
- Infrastructure DDoS protection remains the CDN/WAF's job; this layer is abuse control, not
  DDoS mitigation.

### 7.3 Analytics privacy

No analytics exist today. Build the smallest correct thing when a creator metric is actually
needed:

- Event fields: `name`, `objectType`, `objectId`, `occurredAt`, `countryCode` (from a trusted
  edge header, validated against ISO 3166-1), `deviceClass` (`mobile|tablet|desktop|unknown`),
  `referrerCategory`, `placement` (`organic|paid`), `consentState`, optional `dedupeKey`.
- **No IP column, ever.** No raw IP in logs used for analytics. Geo is resolved at the edge
  before the event enters the app.
- `dedupeKey` = HMAC(rotating daily salt, ephemeral session value), retained ≤ 24 h.
- Ingestion: `POST /api/v1/analytics/events`, batch ≤ 20, ≤ 32 KB, 202, queue, validated
  against a closed taxonomy. Bot/user-agent filtering at the edge; no fingerprinting.
- Aggregation: nightly into `campaign_daily_metrics`; creator reads hit the aggregate only.
- Retention: raw events 90 days, aggregates 24 months, documented in the privacy page.
- Label estimates: `uniqueVisitors` is an estimate; page views are not people; provider/chain
  confirmed events are separate and authoritative.
- Paid placement is a separate dimension and never alters supporter counts, feedback scores
  or pre-pledge totals (FR-206a).

### 7.4 Real-time

| Use case | Decision |
|---|---|
| Public browsing | HTTP + cache |
| Dashboard initial data | server fetch |
| Creator analytics | snapshot on navigation; manual refresh |
| Notifications | HTTP read model; poll every 60 s while visible, pause when hidden |
| Milestone / moderation status | poll with backoff (30 s → 5 min) |
| Upload / job progress | polling (no upload pipeline exists) |
| Financial confirmation | authoritative status endpoint with 2 s → 30 s backoff; never trust a socket |
| Bidirectional collaboration | not needed |

No WebSocket or SSE is introduced in Stages 1–4. If notification fan-out later justifies SSE,
the design must define auth, heartbeat, `Last-Event-ID` replay, per-user connection caps,
Redis pub/sub fan-out, and outage behaviour. Live events are hints; the client always reconciles
against the API/chain before acting.

### 7.5 Background jobs

Only `metrics-snapshot` exists. Add jobs one at a time, each with an input schema, idempotency
key, exponential backoff, max attempts, timeout, DLQ, and an alert:

1. `analytics-aggregate` (nightly, idempotent per day/object).
2. `notification-dispatch` (idempotent per notification id).
3. `impression-flush` (batch from Redis).
4. `provider-reconcile` (verify pending flat-fee charges).

Webhook handling stays synchronous and fast; durable receipt + async follow-up only when the
work exceeds the provider's timeout. Add a `WebhookEvent` inbox with a unique
`(provider, eventId)` and a processed-at marker.

---

## 8. Security controls

- **P0**: `AdminGuard` on moderation; version prefix; error envelope; production secret guard;
  boolean query fix; public-profile query fix; dashboard auth gate before live data.
- CORS allowlist; 1 MB body; Helmet retained.
- Ownership checks stay in services, not controllers. Add e2e cases per resource
  (owner / non-owner / admin / anonymous).
- Mass assignment: already blocked by the whitelist pipe; keep DTOs explicit.
- URL fields (`avatarUrl`, creator `links`, campaign media) validated as `https` with a host
  allowlist; fetch server-side only through a vetted proxy, never arbitrary SSRF.
- Uploads: none today. When added: type sniffing, size caps, image re-encode, private bucket,
  signed URLs, no raw KYC documents (NFR-12).
- Admin audit: append-only `AdminAuditEvent` for role changes, reviews, moderation decisions,
  parameter edits.
- Redaction: error filter strips Prisma/provider internals; logs never carry tokens, cookies,
  raw provider bodies or full KYC payloads.
- Dependency scanning: `pnpm audit` in CI + Dependabot/Renovate.
- Financial: no backend key moves escrow; refunds are claim-based and backend-independent;
  amounts are strings/atomic units; retries are idempotent; finality comes from chain/provider
  state.

---

## 9. Documentation and automation

Create under `inverge-api/docs/api/` (contract owner), linked from `inverge-web/docs/`:

```text
docs/api/README.md                     entry point, environments, versioning
docs/api/openapi.json                  generated, committed
docs/api/authentication.md             session, roles, boundaries
docs/api/errors.md                     envelope, codes, status mapping
docs/api/pagination-filtering.md       cursors, filters, sort, limits
docs/api/caching.md                    keys, TTLs, invalidation, failure
docs/api/rate-limiting.md              policies, headers, proxy trust
docs/api/analytics-privacy.md          taxonomy, IP policy, retention
docs/api/realtime.md                   polling/SSE decisions and failure modes
docs/api/webhooks.md                   providers, signatures, idempotency
docs/api/gaps.md                       live coverage matrix (replaces duplication)
docs/architecture/data-flow.md         web → API → DB/Redis → jobs/providers
```

Scripts (root `package.json` in the API):

```text
openapi:emit     build the app, write docs/api/openapi.json
openapi:check    re-emit and fail on diff (CI)
openapi:lint     validate the spec
docs:routes      list controller routes and compare with the spec paths (undocumented = fail)
```

CI (new, both repos): install → format check → lint → typecheck → unit tests → build →
OpenAPI drift → `pnpm audit`. E2E runs against service containers on PRs that touch the API.

Each endpoint entry documents: purpose/roles, method/path, auth, schemas, success example,
errors, pagination, rate policy, cache, idempotency, freshness/authority, and status
(`implemented | partial | mocked | missing | blocked | deferred`).

---

## 10. Implementation stages

Each stage is independently reviewable and leaves the app working.

### Stage 0 — Baseline (prerequisite)

- Fix the `ideas.service.spec.ts` mock (`idea.findFirst`) so the suite is green.
- Add CI for both repos.
- Record the baseline: unit results, build, bundle/p95 reference.

**Exit:** `pnpm test` green in the API; CI runs on a PR.

### Stage 1 — Contract

- `api/v1` prefix + update the four web auth handlers.
- Request-ID middleware, error filter, `AppError` codes, validation detail mapping.
- Enable the Swagger CLI plugin; define response DTOs for the routes the web will consume first.
  *(Superseded in delivery: the spec is emitted through `ts-node`, where the CLI transformer does not
  run. Explicit `@ApiOkResponse` DTOs are used instead; see §15.)*
- Commit `openapi.json`, add emit/check scripts, generate web types, add a typed fetcher.
- Create `docs/api/*` skeleton and `gaps.md` from the tables in §5.

**Exit:** every existing route appears in the spec; drift check passes; error envelope covered
by unit + e2e tests; web auth works against `/api/v1`.

### Stage 2 — Secure, efficient reads

- Authz fixes (moderation guard, audit table, narrow `/auth/me`).
- Cursor pagination helper + migrate ideas, campaigns, feed, comments.
- Remove post-page sorting; fix boolean query parsing; validate path params.
- Parameter caching; public-profile rewrite; escrow stats SQL.
- Index migration + `EXPLAIN` evidence; list `select` narrowing.

**Exit:** no route loads an unbounded collection; p95 on seeded data recorded; e2e authz matrix
green.

### Stage 3 — Cache and protect

- Redis cache module with the §7.1 keys, single-flight and outage fallback.
- Rate-limit policies, headers, proxy trust, fail policies.
- CORS allowlist, body limits, health endpoints, structured logs + metrics.

**Exit:** cache hit ratio and DB query count per route measured; 429 behaviour tested; Redis-down
test shows bounded degradation and fail-closed financial/auth paths.

### Stage 4 — Analytics and jobs

- Event taxonomy, no-IP table, ingestion endpoint, nightly aggregation, retention job.
- Notification read model + dispatch queue.
- Webhook inbox + replay tooling.

**Exit:** no IP stored; aggregation reconciled against raw counts; duplicate webhook delivery
is a no-op.

### Stage 5 — Web integration and progressive rendering

- Replace fixtures route by route, campaigns first (gap item 6).
- Server-side `/d/*` gate; capabilities from the API.
- Suspense boundaries for heavy dashboard panels; bounded polling for notifications.
- Consistent loading/empty/error/retry states using the error codes.

**Exit:** one public journey and one creator journey run end to end against the live API with
no fixture fallback; NFR-05 measured on a throttled mobile profile.

### Stage 6 — Verification and automation

- Contract tests, performance baselines (autocannon/k6 on seeded data), resilience tests
  (Redis down, pool exhaustion, queue backlog), docs final pass, gap report updated.

---

## 11. Verification

### Before Stage 0 (2026-10-21)

| Check | Command | Result |
|---|---|---|
| API unit tests | `node ./node_modules/jest/bin/jest.js --silent --forceExit` | **16 failed / 268 passed / 284 total**, 1 suite (`ideas.service.spec.ts`): mock lacks `idea.findFirst` |
| API typecheck | `node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **Passes** (exit 0) |
| API e2e | not run | Requires live Postgres + Redis; suites exist in `test/` |
| Web tests | `node ./node_modules/vitest/vitest.mjs run --reporter=dot` | **764 passed / 1 failed, 76 of 97 files executed in 643 s.** The failure is a vitest fork-worker timeout (`pre-pledges-dashboard.test.tsx`), not an assertion; 21 files never started. The run shared the machine with the API suite. |
| Web typecheck | `tsc --noEmit` | Did not finish within 4 minutes without `next typegen` |

The failing suite was pre-existing and unrelated to this plan. It was a Stage 0
prerequisite because it masked regressions.

### After Stage 0 + Stage 1

| Check | Command | Result |
|---|---|---|
| API unit tests | `jest --ci --forceExit` | **294 passed / 294, 31 suites** |
| API typecheck | `tsc --noEmit -p tsconfig.json` | **Passes** |
| API build | `nest build` | **Passes**; output at `dist/main.js` (no `dist/src/` creep) |
| OpenAPI drift | `pnpm openapi:check` | **Up to date**; 52 paths, 63 operations |
| Web typecheck | `pnpm typecheck` (`next typegen && tsc --noEmit`) | **Passes** |
| Web auth tests | `vitest run src/app/api/auth src/features/auth/server/session-user.test.ts --environment=node` | **52 passed / 52, 5 files** |
| Web build | `pnpm build` | **Passes** (exit 0). All marketing and dashboard routes compiled and prerendered |
| Web lint | `eslint` on the changed files | **Passes** (exit 0). The full-repository run was not completed; only the touched files were linted |
| Web full suite | `vitest run` | Not re-run after the change; the earlier run above was environment-limited (jsdom worker startup) |
| API e2e | `jest -c jest-e2e.config.js` | Not run: needs live Postgres and Redis. `test/versioning.e2e-spec.ts` was added but not executed. |

### After Stage 2, slice 1

| Check | Command | Result |
|---|---|---|
| API unit tests | `jest --ci --forceExit` | **319 passed / 319, 34 suites** |
| API typecheck | `tsc --noEmit -p tsconfig.json` | **Passes** |
| API build | `nest build` | **Passes** |
| OpenAPI drift | `pnpm openapi:check` | **Up to date** (no route or schema change in this slice) |
| New coverage | `boolean-query.spec.ts`, `idea.dto.spec.ts`, `moderation.controller.spec.ts`, `platform-params.service.spec.ts` | Guards are asserted, `?mine=false` is parsed at the DTO boundary, the parameter snapshot is invalidated on write |
| API e2e | — | Still requires live Postgres and Redis; not run |

The jsdom environment is pathologically slow on this machine (99 % of a 74 s run for
five trivial tests). Running the touched suites with `--environment=node` isolates
the change from that environment problem; it does not replace a full CI run.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| `/api/v1` breaks an unlisted consumer | Confirm with the owner; otherwise ship aliases for one release |
| Response envelope changes break the web | The web does not consume product endpoints yet; migrate in the same PR per endpoint |
| Dirty `inverge-web` worktree | Work in a dedicated worktree/branch; never reformat or revert user changes |
| No CI means drift checks are advisory | Add CI in Stage 0 before generating the spec |
| No representative data for index decisions | Extend the seed with volume fixtures; record `EXPLAIN` output in the PR |
| Proxy topology unknown | Make `TRUST_PROXY_HOPS` explicit; document per environment |
| Redis is a single local container | Treat cache/limits as degradable; document HA as a deployment prerequisite |
| Financial endpoints could be stubbed prematurely | Hard rule: no contribution/escrow/refund route before the program + indexer exist |
| Stale docs repeat (the gap doc already drifted) | One index (`docs/api/gaps.md`), generated route checks, and a docs step in the PR checklist |

---

## 13. Unresolved decisions

These need an owner decision before Stage 1 or 2. Each is a candidate `DECISIONS.md` entry.

1. **Versioning**: `/api/v1` now (recommended) vs a root alias for one release.
2. **List envelope**: `{ data, page }` now vs keep arrays and add metadata later.
3. **Sorted-by-aggregate discovery**: keyset on `(createdAt, id)` plus a ranking projection, or
   offset for `most-backed` until volume justifies the projection.
4. **Rate-limit implementation**: `@nestjs/throttler` + Redis storage, or a repo-native
   `RateLimiterPort` with Redis and in-memory adapters. The port matches the existing vendor
   pattern; the throttler is less code.
5. **Session refresh**: keep 1 h and re-authenticate, or add a refresh token/rotation.
6. **Admin audit storage**: a general `AdminAuditEvent` table (recommended) vs extending
   `PlatformParamAudit`.
7. **Fix the pre-existing failing spec** as part of Stage 0 (recommended).
8. **Web client stack**: server-only fetch + a small typed fetcher (recommended) vs adopting
   TanStack Query as `web-ui-api-gaps.md` assumes.
9. **Public profile content**: should `ideasSupported` remain public (it reveals what an
   account backed), or be reduced to a count?
10. **Analytics consent**: is consent required at launch (GDPR/NDPA posture), and does the
    privacy page need an update before ingestion ships?

---

## 14. Prioritised next steps

1. Approve decisions 1, 2, 4, 7, 8.
2. Stage 0: green unit suite + CI.
3. Stage 1: version prefix, error envelope, request IDs, committed OpenAPI, generated types.
4. Stage 2: authz fixes (`AdminGuard` on moderation, admin audit), cursor pagination, index
   migration, public-profile and escrow-stats queries.
5. Stage 3: Redis cache, route-specific rate limits, health/metrics, CORS/body limits.
6. Stage 4: analytics (no IP), notification queue, webhook inbox.
7. Stage 5: web integration, campaigns first; real dashboard gate.
8. Stage 6: contract/performance/resilience verification and the gap report update.

## 15. Delivery log — Stage 0 and Stage 1 (2026-10-21)

Approved by the owner before implementation:

| Decision | Outcome |
|---|---|
| Scope | Stage 0 + Stage 1 only; Stages 2–6 not started |
| Versioning | Move to `/api/v1` now, no alias window (D-035) |
| Web data layer | Adopt TanStack Query (D-037), mounted with the first query |
| Error shape | One envelope, request id on every response (D-036) |
| Contract | Commit the OpenAPI document and drift-check it (D-038) |

### Stage 0

- `ideas.service.spec.ts`: the mock was missing `idea.findFirst`, and the `getQuality` test called the
  service with no idea. Both fixed; the suite is green (see verification below).
- GitHub Actions added to both repositories. The API job installs, generates the Prisma client,
  typechecks, runs unit tests, builds, and runs `openapi:check`. The web job runs format, lint,
  typecheck, tests and build.

### Stage 1

- `/api/v1` global prefix; the four web Route Handlers, the session lookup, and their tests now use it.
- `ApiExceptionFilter` registered through `APP_FILTER`; `requestId` middleware; inbound ids accepted
  only when UUID.
- `docs/api/` created: README, authentication, errors, pagination, caching, rate limiting, analytics
  privacy, real-time decision, webhooks, and the feature/route gap matrix.
- `scripts/emit-openapi.ts` + `openapi:emit` / `openapi:check`; `docs/api/openapi.json` committed.
- Response DTOs for the four consumed auth routes.
- Web: `src/lib/api/{base-url,error,server}.ts`, generated `openapi.ts`, and the `api:types` script.
  `readSessionUser` now uses the typed server client instead of a hand-rolled fetch.

### Deviations from the plan, and why

1. **No Swagger CLI plugin.** The CLI transformer only runs under `nest build`; the emitter runs on
   source through `ts-node`. Using both would produce a spec that differs from the running app. Input
   DTOs already carry explicit `@ApiProperty` decorators; response DTOs are explicit where they exist.
2. **BullMQ connects lazily.** An eager ioredis connection retried forever when Redis was down, which
   made the emitter hang and made boot depend on Redis being up. `lazyConnect: true` defers the first
   connection to the first command, inside the scheduler's existing try/catch. This is a behaviour
   change outside the contract scope and is called out for review.
3. **`apiBaseUrl` moved** from `features/auth/server/session-user.ts` to `lib/api/base-url.ts` so the
   shared client does not depend on a feature module. The old module re-exports it; existing imports
   and mocks still work.
4. **TanStack Query is installed but not mounted.** Mounting a provider with no consumers would ship
   client JavaScript and a root client boundary for nothing. It lands with the first API-backed client
   screen (D-037).
5. **Only the auth responses have DTOs.** Annotating 63 handlers accurately is Stage 2 work; the thin
   schemas are listed in `docs/api/gaps.md` rather than implied to be complete.

### Not verified in this pass

- API e2e (`test/*.e2e-spec.ts`) needs live Postgres and Redis; it was updated for the new envelope but
  not executed.
- The web CI workflow was not run on GitHub. Local web checks are reported in the hand-off.
- Provider webhook URLs have not been changed in Paystack or Didit dashboards.

## 16. Delivery log — Stage 2, slice 1 (2026-10-21)

The plan's Stage 2 is split into slices. This slice closes the authorization and
runaway-read defects; pagination and index work remain.

Done:

- **Moderation authorization.** `AdminGuard` added after `PrivyAuthGuard`. A unit test asserts the
  guard metadata, so removing it fails a test rather than shipping an open vendor-cost endpoint.
- **Role-change audit.** `PATCH /admin/users/:id/role` writes the role change and an audit row in one
  transaction, keyed `auth.user.role` in the shared `PlatformParamAudit` table. The table is generic
  (`key`, `oldValue`, `newValue`, `changedBy`, `changedAt`); no migration was needed. Read it with
  `GET /admin/params/audit?key=auth.user.role`.
- **Narrow session projections.** `POST /auth/session` and `GET /auth/me` no longer return the full
  `User` row (provider subject id, KYC status, ban state, internal timestamps).
- **Boolean query parsing.** `?mine=false` is now `false`. `@Type(() => Boolean)` was the bug;
  `parseBoolean` accepts `true|false|1|0`, and anything else reaches `@IsBoolean()` and fails with a
  400. Covered by a helper spec and a DTO-level spec.
- **Public-profile rewrite.** One indexed lookup by id or stored handle replaces loading every user.
  Published and supported lists are capped at 24 and filtered to public statuses. Display-name-derived
  slugs are no longer routable: they change with the display name and required the full scan.
- **Escrow stats.** One `groupBy` aggregate replaces loading every `OnChainEvent` into Node.
- **Parameter snapshot.** `PlatformParamsService` reads the whole parameter table once per 5 s instead
  of 5–17 point reads per request, and invalidates immediately on `set`. Staleness is bounded to 5 s
  per process, and the write path is authoritative.

Not done in this slice:

- Cursor pagination for ideas, campaigns, comments and the ranked feed; the list envelope is still the
  bare array. This is the next slice and the largest contract change.
- `sort=most-delivered` still sorts the current page in memory. It needs a denormalized
  released-claim counter (or a tested raw query) before it can paginate correctly.
- Index migration and `EXPLAIN` evidence: no Postgres is reachable in this environment. The missing
  `OnChainEvent.eventType` index is recorded in `docs/api/gaps.md`.
- Removing the duplicate `GET /campaigns/escrow/stats` alias.
- e2e authorization matrix: the unit-level guard assertion runs, but the e2e suite still needs
  Postgres and Redis.


## 17. Delivery log — Stage 2, slice 2 (2026-10-21)

Cursor pagination for discovery collections.

Done:

- **Shared keyset helper.** `src/common/http/pagination.ts` owns the page envelope
  (`{ data, page: { limit, nextCursor, hasMore, total, totalKind } }`), the opaque cursor, the
  filter fingerprint and the `(sortValue, id)` comparison. A cursor is bound to the query that
  produced it; reusing it with different filters is `400 INVALID_CURSOR`.
- **`GET /ideas`** pages on `(createdAt desc, id desc)`. The featured/promoted re-sort is gone: it
  reordered only the current page. `promoted` and `boostTier` are still returned.
- **`GET /campaigns`** pages on `(createdAt, id)`, `(deadline, id)` or `(totalRaised, id)`. List rows
  now select only the milestone fields the summary needs instead of every milestone column.
- **`most-delivered` removed.** It counted approved claims and sorted after the page was cut. It now
  fails validation rather than returning a misleading order; restoring it needs a denormalized
  released-claim counter.
- **`skip`/`take` replaced by `limit`/`cursor`** on both routes (default 24, max 50). The OpenAPI
  document and the web's generated types were regenerated.
- **e2e assertions** for the ideas list read `body.data` (the suites still need `/api/v1` path
  migration before they can run).
- **Unbounded-read audit.** Active feed promotions are restricted to the candidate pool and capped at
  200; the insights chart series is limited to 180 days; AML screening history is capped at 100 rows.
- **Duplicate escrow route removed.** `GET /platform/escrow` is the only escrow projection;
  `GET /campaigns/escrow/stats` was an alias with the same handler.
- **Production session secret enforced.** Environment validation fails at boot when
  `NODE_ENV=production` and `SESSION_JWT_SECRET` is still the documented default (or empty).
  Development keeps the zero-config default.

Not done in this slice:

- Feed cursors: the ranker's output has no stable sort value yet. The candidate pool stays bounded.
- Comment cursors: the list is bounded at 300 but ordered by highlighted/like count, which is
  volatile; the cursor design needs to follow the thread ordering.
- Cursor-aware typed response DTOs, so the OpenAPI entries for these two routes still have no
  response schema.
- Per-idea recompute reads (all pre-pledges, all survey responses) still load every row for one idea.
  They are the FR-206a recompute path and are bounded by one idea's participation, not by the platform;
  batching becomes necessary only at much larger per-idea volume.
- The nightly snapshot job reads every validating idea in one pass. It is a job, not a request, and is
  a Stage 4 batching concern.
- Index migration and `EXPLAIN` evidence (no Postgres reachable).

## 18. Delivery log - Stage 3 (2026-10-22)

Cache, rate limiting, operational endpoints and the e2e bootstrap.

Done:

- **Cache-aside module.** `src/common/cache/` implements versioned keys
  (`v1:{namespace}:g{n}:{key}`), generation bumps instead of `KEYS`/`SCAN`, ±10 % TTL
  jitter, per-instance single-flight registered before the Redis read, and a 5 s
  breaker. Redis is optional: `REDIS_ENABLED=false` bypasses it entirely.
- **Wired reads.** Public idea pages/details, public campaign pages/details and the
  platform escrow projection are cached. `mine=true` lists and authenticated campaign
  details bypass the cache. Signal, survey, submission and review mutations bump the
  relevant generation after commit.
- **Token-bucket rate limiting.** Policies live in one module (`discovery`, `search`,
  `auth`, `username`, `signals`, `comments`, `dashboard`, `financial`, `webhook`,
  `admin`). Redis Lua keeps the bucket atomic; a bounded local bucket is the fallback;
  auth, financial and admin fail closed when Redis is enabled but unreachable. Headers
  and `Retry-After` are emitted, and identifiers are SHA-256 hashed before they become
  Redis keys.
- **Production bootstrap extracted.** `src/bootstrap.ts` is shared by `main.ts` and the
  e2e harness: `/api/v1` prefix, request id, 1 MB body limit, Helmet, explicit CORS
  allowlist (`CORS_ORIGINS`, same-origin by default in production), `trust proxy` from
  `TRUST_PROXY_HOPS`, explicit `@Type` conversion, JSON logger in production.
- **Health and metrics.** `GET /health/live`, `GET /health/ready` (Postgres is the only
  hard dependency; Redis is reported as degraded) and `GET /metrics` (Prometheus text,
  optional `METRICS_TOKEN`, hidden from OpenAPI). Health/metrics stay outside the
  version prefix.
- **Structured telemetry.** One request log line with request id, matched route,
  status, duration and a hashed user id; no query string, body, token, cookie or raw IP.
  Counters and latency histograms are per instance and scrape-aggregated.
- **Queue registration is optional.** `QUEUE_ENABLED=false` prevents the BullMQ Worker
  from being registered; a Worker dials Redis during bootstrap and cannot be made lazy
  from the queue options. The snapshot scheduler also checks the flag.
- **e2e now runs through the production bootstrap.** `test/create-test-app.ts` applies
  `configureApp`; all suites use `/api/v1` paths. `jest.setup.ts` disables Redis, queues
  and rate limiting. The live AI moderation suite is opt-in (`RUN_LIVE_AI_E2E=true`).
  Result: **96 passed, 2 skipped** across 7 suites; unit: **377 passed**.

Not done in this slice:

- Redis was not installed in this environment, so the Redis success path is exercised
  by fakes only; the outage/disabled path is exercised by e2e. A Redis-backed
  integration run is still required before deployment.
- No analytics, notification read model or webhook inbox (Stage 4). The Prisma schema
  currently has uncommitted advertising work from another change, so schema-coupled
  Stage 4 work must be coordinated rather than layered blindly.
- Auth rate limiting is IP-only; the provider subject is not part of the key yet.
- `search` classification is query-key based; a new filter key must be added to the
  list in `rate-limit.policies.ts`.
- Index migration and `EXPLAIN` evidence remain open.
- Web Stage 5 is not started: the web repository is currently on `main`, while the API
  client/generated-types work lives on `feat/web3auth-auth`, with user-owned dirty files
  in both trees.
