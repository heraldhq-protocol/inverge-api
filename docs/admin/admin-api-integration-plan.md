# Admin API integration plan

Companion to [`admin-audit.md`](./admin-audit.md) and
[`admin-missing-features.md`](./admin-missing-features.md).

This document is endpoint-by-endpoint. Every endpoint is marked **Existing** (present in
`inverge-api/docs/api/openapi.json` today) or **Proposed** (not implemented, shape is a
recommendation). Nothing in the Existing column was inferred.

## 1. Integration principles

1. **The browser never holds a bearer token.** All admin API calls run on the Next.js server
   using the HttpOnly session cookie, as `features/verification/server/api.ts` already does.
2. **Reads are server components; writes are route handlers or server actions.** A client
   component may own the form, but the request leaves from the server.
3. **No optimistic authority.** A decision renders as pending until the API confirms it; a
   failed write restores the prior state and surfaces the API's `error.code`.
4. **The API stays the authority.** A hidden button is not authorization. Every web-side
   permission check is presentation only.
5. **Pass the API's status through.** `sendApiJson` returns `{ ok, status, code, message }`;
   a 409 stale transition must remain a 409 in the UI, not become a generic 500.
6. **Demo mode makes zero admin API calls.** If `ADMIN_DEMO_MODE` is on, the admin data layer
   resolves to fixtures and write actions are disabled. See
   [`admin-demo-mode.md`](./admin-demo-mode.md).
7. **Base URL** comes from `apiBaseUrl()` in `src/lib/api/server.ts` (`INVERGE_API_URL` +
   `/api/v1`). There is no default; a missing URL is a 503 `API_NOT_CONFIGURED`, not a
   fallback to localhost.

## 2. Response shape assumptions

- Success: bare JSON body.
- Failure: `{ "error": { "code": string, "message": string, "details"?: unknown } }`.
- Lists: `{ items, total, skip, take }` for campaigns; `{ items, nextCursor }` for
  verification cases; programme list shape must be confirmed from `GET /admin/programmes`
  before mapping.

## 3. Phase 0 — shared admin data layer

Build once, use everywhere.

| Concern | Design |
| --- | --- |
| Base client | `src/features/admin/server/client.ts` wrapping `fetchApiJson` / `sendApiJson` with the session token from `readSessionToken()`. |
| Result type | `AdminResult<T> = { ok: true; data: T } \| { ok: false; status: number; code: string; message: string; details?: unknown }`. |
| Auth failure | `401` → `NOT_SIGNED_IN`; `403` → `FORBIDDEN` with the API message. Pages render a sign-in or access-denied state. |
| Unconfigured | `503` → `API_NOT_CONFIGURED`; pages render an explicit "no API configured" panel. Never fall back to fixtures. |
| Revalidation | Mutations call `revalidatePath()` for the affected route plus the overview. |
| Demo guard | Every client function first checks `adminDemoMode()` and returns `DEMO_MODE` instead of calling the API. |
| Logging | Log `{ path, status, code }` server-side; never log tokens, emails or provider references. |

**Acceptance:** a page cannot accidentally reach the API in demo mode; a missing API URL
produces a visible configured-error state; no client bundle contains a bearer token.

## 4. Phase 1 — campaign review (P0)

| # | Endpoint | Status | Web caller | Method / notes |
| --- | --- | --- | --- | --- |
| 1.1 | `GET /admin/campaigns?reviewStatus=&skip=&take=` | Existing | `/admin/campaigns` server component | `reviewStatus` ∈ `IN_REVIEW, CHANGES_REQUESTED, APPROVED, REJECTED, NOT_SUBMITTED, ALL`; default `IN_REVIEW`; `take` ≤ 100. |
| 1.2 | `GET /admin/campaigns/:id` | Existing | `/admin/campaigns/[id]` | Returns `{ campaign, applicationFee, preconditions, verificationGate, reviewEvents }` (verify exact keys before typing). Includes KYC/AML/KYB, fee and escrow facts. |
| 1.3 | `POST /admin/campaigns/:id/review` | Existing | Decision form | Body `{ action, reason? }`. `action` ∈ `APPROVE, REQUEST_CHANGES, REJECT`. `reason` required 20–2000 chars for change request/reject; optional for approve. |
| 1.4 | `GET /admin/analytics/overview?range=` | Existing | `/admin` overview cards | Use only for platform metrics; the review queue still comes from 1.1. |

**Mapping work**

- Web `Campaign` fixtures are richer than the API projection (story blocks, disclosures).
  Do not fake missing fields. The review detail must render what the API returns and mark
  sections the API does not provide as unavailable.
- API review statuses are SCREAMING_SNAKE; web uses kebab-case. Add one explicit adapter,
  not scattered `replace()` calls.
- The API enforces preconditions (`evaluateCampaignReviewGates`). Render blockers from the
  response; do not recompute them in the browser.
- Remove `features/campaigns/lib/admin-review-store.ts` from the review path. Keep it only
  behind demo mode, or delete it once demo fixtures are read-only.

**Acceptance:** two browsers see the same decision; a second decision returns the API's
conflict; the reason rule is enforced by the API and mirrored in the form; the server's
review history replaces the local history panel.

## 5. Phase 2 — programme operations (P1)

| # | Endpoint | Status | Web caller |
| --- | --- | --- | --- |
| 2.1 | `GET /admin/programmes` | Existing | `/admin/programmes` list |
| 2.2 | `POST /admin/programmes` | Existing | wizard create |
| 2.3 | `GET /admin/programmes/:id` | Existing | detail / edit |
| 2.4 | `PATCH /admin/programmes/:id` | Existing | wizard save |
| 2.5 | `POST /admin/programmes/:id/status` | Existing | publish/archive controls |
| 2.6 | `GET /admin/programmes/:id/entries` | Existing | entries tab |
| 2.7 | `POST /admin/programmes/:id/entries/:entryId/decision` | Existing | entry decision |
| 2.8 | `POST /admin/programmes/:id/entries/:entryId/curated-rank` | Existing | ranking |
| 2.9 | `POST/DELETE /admin/programmes/:id/judges[/:assignmentId]` | Existing | judge assignment |
| 2.10 | `POST/PATCH/DELETE /admin/programmes/:id/prizes[/:prizeId]` | Existing | prizes |
| 2.11 | `POST/PATCH/DELETE /admin/programmes/:id/sponsors[/:sponsorId]` | Existing | sponsors |
| 2.12 | `POST/PATCH /admin/programmes/:id/announcements[/:announcementId]` | Existing | announcements |
| 2.13 | `GET /admin/programmes/:id/results/preview` | Existing | results preview |
| 2.14 | `POST /admin/programmes/:id/results/publish` and `/unpublish` | Existing | publish/unpublish with confirmation |
| 2.15 | `GET /admin/programmes/:id/report`, `/analytics`, `/audit` | Existing | reporting and audit tabs |

**Ordering constraint:** 2.1–2.5 first; they replace the local store. 2.6–2.15 can ship as
independent tabs. Until 2.15 exists, the audit log cannot show programme events outside the
programme detail.

**Money display:** prizes and sponsors are read-only until the finance projection exists. The
UI must not compute totals the API does not return.

## 6. Phase 3 — verification hardening (P1)

| # | Endpoint | Status | Work |
| --- | --- | --- | --- |
| 3.1 | `GET /verification/admin/queues` | Existing | keep; add as-of timestamp |
| 3.2 | `GET /verification/admin/cases?status=&risk=&requiresReview=&cursor=&limit=` | Existing | add cursor paging; currently `limit: "50"` fixed |
| 3.3 | `GET /verification/admin/cases/:id` | Existing | keep |
| 3.4 | `POST /verification/admin/cases/:id/resolve` | Existing | gate the form on capability; show API result |

**Open design question:** verification uses `ComplianceReviewerGuard`, not `AdminGuard`. It
should probably live under `/compliance` with its own navigation, or the admin shell must
render it only for actors holding `COMPLIANCE_REVIEWER` or `ADMIN`.

**Error codes:** `resolveRisk` already forwards `error.code`. The UI must distinguish
"already resolved" from "not permitted" from "provider unreachable".

## 7. Phase 4 — platform operations (P1–P2)

| # | Endpoint | Status | Web caller |
| --- | --- | --- | --- |
| 4.1 | `GET /admin/users?query=&role=&limit=&offset=` | Existing | users list |
| 4.2 | `PATCH /admin/users/:id/role` | Existing | role change |
| 4.3 | `GET /admin/params`, `PATCH /admin/params` | Existing | settings form |
| 4.4 | `GET /admin/params/audit?limit=&offset=` | Existing | settings history |
| 4.5 | `GET /admin/boost-prices`, `PATCH /admin/boost-prices` | Existing | pricing form |
| 4.6 | `GET /admin/analytics/overview` | Existing | analytics cards |
| 4.7 | `GET /admin/analytics/access-requests`, `PATCH …/:id` | Existing | request queue |
| 4.8 | `GET /admin/ai/access-requests`, `PATCH …/:id` | Existing | AI request queue |
| 4.9 | `GET /admin/email/templates`, `POST /admin/email/editorial/preview`, `POST …/send` | Existing | email editorial |
| 4.10 | `POST /admin/moderation/screen` | Existing | moderation tool, not a queue |
| 4.11 | `GET /admin/audit?actor=&domain=&entity=&from=&to=&cursor=` | **Proposed** | global audit |
| 4.12 | `POST /admin/users/:id/suspend`, `POST …/reinstate` | **Proposed** | suspension |
| 4.13 | `GET /admin/moderation/cases`, `GET …/:id`, `POST …/:id/decision` | **Proposed** | moderation queue |
| 4.14 | `GET /admin/escrow/reconciliation`, `GET /admin/campaigns/:id/contributions` | **Proposed** | escrow read model |
| 4.15 | `GET /admin/milestones/claims`, `GET …/:id`, `POST …/:id/ruling` | **Proposed** | milestone rulings |
| 4.16 | `GET /admin/notifications`, `POST /admin/notifications` | **Proposed** | broadcast |

### Proposed shapes (recommendations, not contracts)

```ts
// GET /admin/audit
type AdminAuditPage = {
  items: Array<{
    id: string;
    at: string;              // ISO
    domain: "auth" | "campaign" | "programme" | "advertising" | "money";
    entity: { type: string; id: string };
    actor: { id: string; label: string };
    action: string;
    from: string | null;
    to: string | null;
    reason: string | null;
  }>;
  nextCursor: string | null;
};

// POST /admin/milestones/claims/:id/ruling
type RulingInput = {
  decision: "APPROVE" | "REJECT" | "REQUEST_EVIDENCE";
  reason: string;            // required, min 20
  objectionId?: string;      // when the ruling answers an objection
};
```

The ruling endpoint must **not** trigger a transfer. It records a decision that an existing
or future escrow job can read. Chain state remains authoritative.

## 8. Type and adapter strategy

1. **Generate types from OpenAPI.** `inverge-api/docs/api/openapi.json` is committed; a
   generated client removes hand-written drift. Until then, keep one adapter per domain in
   `src/features/<domain>/server/`.
2. **Keep fixtures and API types separate.** Do not widen an API type to match a fixture.
   Add a view model per page and map explicitly.
3. **Status adapters are exhaustive.** A `switch` over the API enum with a `never` check so a
   new API status fails the build rather than rendering blank.
4. **Money stays integer atomic units** end to end. Format only at the leaf.

## 9. Failure, empty and loading states

Every admin page must implement all four:

| State | Requirement |
| --- | --- |
| Loading | Suspense boundary with a skeleton that matches the final layout. |
| Empty | Explains *why* it is empty (no submissions vs filter matched nothing vs not connected). |
| Error | Shows the API `code`, a retry action, and whether anything was changed. |
| Forbidden | Names the required role; never renders the mutation form. |

A failed write must say "nothing was changed" only when the API confirms it; a network
timeout is ambiguous and must say so.

## 10. Migration sequence

1. Add the shared admin client and result type; no page changes.
2. Convert `/admin/campaigns` reads, keep the local decision path behind a flag.
3. Convert the decision write; delete the local override branch.
4. Relabel or remove `/admin/payments`.
5. Convert programme list and create/edit.
6. Convert programme tabs one at a time.
7. Add users/params/audit pages.
8. Add verification capability gating and paging.
9. Add the proposed endpoints in product-priority order (milestones first).

Each step must be independently revertible and must not change demo behaviour.

## 11. Verification plan

| Layer | Check |
| --- | --- |
| Type | `pnpm typecheck` in `inverge-web` and `inverge-api`. |
| Unit | Adapter tests for status mapping and money formatting; route-handler tests with a mocked `fetch`. |
| API | `pnpm test` and targeted `pnpm test:e2e` for campaign review and programmes. |
| Browser | Playwright scenarios in [`admin-demo-mode.md`](./admin-demo-mode.md) §5, run against a real API for integration and against demo mode for UI. |
| Security | Confirm no token in the client bundle; confirm `403` renders an access-denied state; confirm demo mode makes no network call to `/admin/*`. |

## 12. Explicit non-goals

- Building a second authorization system in the web app.
- Client-side calls to the API.
- Optimistic money, KYC, or escrow state.
- Auto-reconciling chain state from the admin UI.
- Inventing endpoints for domains that have no model or policy yet.
