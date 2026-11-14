# Inverge admin audit

- **Date:** 2026-11-11
- **Scope:** `inverge-web` `/admin/*` routes and the `inverge-api` endpoints they could
  legitimately call. Escrow contracts (`inverge-escrow`) are out of scope except where an
  admin surface would need to read chain state.
- **Method:** source inspection of every admin route, every admin-facing controller, the
  committed OpenAPI document (`inverge-api/docs/api/openapi.json`), the Prisma schema, and
  the existing Vitest suites. No production system was queried. No endpoint was invented.
- **Companion documents:**
  - [`admin-missing-features.md`](./admin-missing-features.md)
  - [`admin-api-integration-plan.md`](./admin-api-integration-plan.md)
  - [`admin-demo-mode.md`](./admin-demo-mode.md)

## 1. Status vocabulary

| Status | Meaning |
| --- | --- |
| **Live** | The page reads and/or writes the real API with the signed-in user's bearer token. |
| **Fixture** | The page renders typed in-repo records. Nothing is fetched. |
| **Local** | The page renders fixtures and accepts mutations, but mutations are written to `window.localStorage` only. |
| **Absent** | No page exists. |
| **Unused API** | A working server endpoint exists that the web app never calls. |
| **Missing API** | No endpoint exists for the operation. |

Two independent boundaries matter and are easy to conflate:

1. **Render gate** — `getProgrammeAdminAccess()` in
   `inverge-web/src/features/programmes/server/access.ts` decides whether the `/admin` shell
   renders at all.
2. **Authority gate** — the API guards (`PrivyAuthGuard` → `AdminGuard` or
   `ComplianceReviewerGuard`) decide whether a privileged operation executes.

Only the second one is authorization. The first is UX.

## 2. Functional-area matrix

| Functional area | Route / page | UI status | API status | Data source | Permission status | Tests | Required work | Priority | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Operating overview | `/admin` (`admin-overview.tsx`) | Local | Unused API | `previewCampaigns` + review local store | Layout render gate only; no per-metric permission | None | Replace fixture counts with `GET /admin/analytics/overview`; keep queue from `GET /admin/campaigns?reviewStatus=IN_REVIEW` | P1 | `admin-overview.tsx:33-40,251-277` |
| Campaign review queue | `/admin/campaigns` | Local | Unused API | `previewCampaigns` + local store | `getProgrammeAdminAccess`; action gate `campaign:review` in domain | `admin-campaign-review-queue.test.tsx` | Server-fetch `GET /admin/campaigns`; send decisions to `POST /admin/campaigns/:id/review` | P0 | `admin-campaign-review-queue.tsx`, `app/admin/campaigns/page.tsx` |
| Campaign review detail | `/admin/campaigns/[id]` | Local | Unused API | Fixture campaign + local store | `adminCan(role,"campaign:review")`, `decideCampaignReview` | `admin-campaign-review-detail.test.tsx` | Fetch `GET /admin/campaigns/:id` (verification + fee facts), POST the decision | P0 | `admin-campaign-review-detail.tsx:87-109,388-392` |
| Verification queue | `/admin/verification` | **Live** | Live | `GET /verification/admin/queues`, `GET /verification/admin/cases` | API `ComplianceReviewerGuard`; page has **no local role check** | `verification-panel.test.tsx` (panel only) | Add page-level role awareness, filters, cursor paging, empty/error UX polish | P1 | `app/admin/verification/page.tsx:100-114`; `verification.controller.ts:171-199` |
| Verification case | `/admin/verification/[id]` | **Live** | Live | `GET /verification/admin/cases/:id`, `POST …/resolve` | API `ComplianceReviewerGuard`; form is client-side | `verification-panel.test.tsx` | Show actor + audit event on resolve; confirm reason-code taxonomy | P1 | `app/admin/verification/[id]/page.tsx:39-153`; `verification.controller.ts:194-211` |
| Advertising inventory | `/admin/advertising` | Local | **Missing API** | `previewAdCreatives` + local store | `adminCan("advertising:manage"/"advertising:approve")` in domain | `admin-store.test.ts`, `validation.test.ts` | Build advertisement API module (models already exist) or delete the page | P2 | `advertising/lib/admin-store.ts:15-24`; Prisma `Advertisement*` models |
| Programme list/dashboard | `/admin/programmes` | Local | Unused API | `previewProgrammes` + local store | Render gate; no per-row permission | `programme.test.ts`, `hub.test.ts` | Server-fetch `GET /admin/programmes`; wire status transitions | P1 | `app/admin/programmes/page.tsx`; `admin-programmes.controller.ts` |
| Programme create/edit | `/admin/programmes/new`, `/admin/programmes/[id]` | Local | Unused API | `programme-wizard` + local drafts | Render gate | `programme.test.ts` | Wire `POST /admin/programmes`, `PATCH /admin/programmes/:id`, `POST …/status` | P1 | `programmes/components/programme-wizard.tsx`; `lib/local-store.ts` |
| Programme entries/judging | (inside programme detail) | Local | Unused API | fixtures | Render gate | `programme.test.ts` | Use entries, judges, decisions, curated-rank endpoints | P1 | `admin-programmes.controller.ts` |
| Programme results/prizes/sponsors | (inside programme detail) | Local | Unused API | fixtures | Render gate | `monetisation.test.ts` | Use prizes/sponsors/results endpoints; keep money display read-only | P1 | `admin-programmes.controller.ts:20-40` |
| Payments / prize ledger | `/admin/payments` | Fixture | **Missing API** | `previewProgrammes` | None | None | Needs a real payments/ledger read model; do not ship fixture money | P0 (safety) → P2 (build) | `app/admin/payments/page.tsx` |
| Audit log | `/admin/audit` | Fixture | Unused API + **Missing API** | `previewAuditEntries`, `ROLE_PERMISSIONS` | Read-only page | None | Aggregate `GET /admin/params/audit` + `GET /admin/programmes/:id/audit`; needs a global audit endpoint | P1 | `app/admin/audit/page.tsx`; `admin.controller.ts:64-70` |
| Idea moderation | Absent | Absent | **Missing API** | — | — | — | Admin queue over `ModerationCase`/`IdeaQualityReport`; only a content-screen tool exists | P2 | `moderation.controller.ts` (screen-only); Prisma `ModerationCase` |
| User administration | Absent | Absent | **Unused API** | — | API `AdminGuard` | `admin.guard.spec.ts` | Add `/admin/users` list + role change UI; ban is missing | P1 | `admin.controller.ts:96-146` |
| Platform params / boost prices | Absent | Absent | **Unused API** | — | API `AdminGuard` | None | Add settings page for params, boost prices, audit | P1 | `admin.controller.ts:45-94` |
| Analytics admin | Absent | Absent | **Unused API** | — | API `AdminGuard` | None | Add overview and access-request screens | P2 | `analytics.controller.ts`; `/admin/analytics/*` |
| Email editorial admin | Absent | Absent | **Unused API** | — | API `AdminGuard` | None | Add preview/send/templates UI with explicit send confirmation | P2 | `admin-email.controller.ts` |
| Contributions / escrow admin | Absent | Absent | **Missing API** | — | — | — | Read-only contribution + escrow reconciliation queue | P1 | Prisma `Contribution`, `OnChainEvent`; no controller |
| Milestone claims / objections | Absent | Absent | **Missing API** | — | — | — | Claim review and objection queue; `ReviewerRuling` unused | P0 (product) | Prisma `MilestoneClaim`, `MilestoneObjection`, `ReviewerRuling`; no route |
| Global audit | Absent | Absent | **Missing API** | — | — | — | One queryable, append-only audit projection across domains | P1 | `PlatformParamAudit` + `CampaignReviewEvent` + `ProgrammeAuditEvent` are separate |
| Notifications broadcast | Absent | Absent | **Missing API** | — | — | — | Admin compose/send; only `/me/notifications` exists | P2 | `notifications.controller.ts` |
| Taxonomy management | Absent | Absent | **Read-only API** | — | — | — | Write endpoints for categories/subcategories | P3 | `taxonomy.controller.ts` |
| Advertising review + events | Absent | Absent | **Missing API** | — | — | — | Review events and impression events exist as models only | P2 | Prisma `AdvertisementReviewEvent`, `AdvertisementEvent` |

## 3. Access-control findings

### A-01 (P0) — `/admin` renders fixture data to any preview identity

`getProgrammeAdminAccess()` accepts `user.mode === "preview"` whenever
`NODE_ENV !== "production"` and synthesises `role: "platform_admin"`. Preview mode is
selected by `INVERGE_AUTH_MODE=preview`. That is intentional for UI work, but it means a
developer with no `ADMIN` role sees the full admin shell with fixtures and can mutate the
local review/programme/advertising stores.

- **Not a data breach:** preview mode never obtains a bearer token for the API, so
  `AdminGuard` still refuses privileged calls.
- **Real risk:** the UI can imply authority it does not have, and the verification pages
  *do* call the API with the preview cookie (which holds no API token), producing confusing
  401s rather than a clear denial.
- **Narrow fix applied:** an explicit demo mode (`ADMIN_DEMO_MODE`) now owns fixture-only
  access, is off by default, is rejected in production, and renders a visible **DEMO DATA**
  banner. Verification pages refuse to call the API in demo mode. See
  [`admin-demo-mode.md`](./admin-demo-mode.md).
- **Still open:** preview auth remains a second, implicit path to fixture admin. Either
  remove it once API auth is the default, or make it require the same explicit flag.

### A-02 (P0) — Verification pages have no local authorization check

`app/admin/verification/page.tsx` and `[id]/page.tsx` call `getAdminQueues()`,
`listAdminCases()`, `getAdminCase()` and render `ResolveRiskForm` without checking the
actor's role. They rely entirely on the layout gate and the API guards. The API is the real
authority, so this is not an escalation, but it produces a page that looks actionable and
then fails at submit. `ResolveRiskForm` should be rendered only when the actor can review.

### A-03 (P1) — Three permission vocabularies

- Web: `AdminRole = "platform_admin" | "organiser" | "judge"` and `AdminPermission`
  (`features/admin/permissions.ts`).
- API: `UserRole = ADMIN | COMPLIANCE_REVIEWER | USER` + `ADMIN_ALLOWLIST`.
- Programme: per-programme organiser/judge roles.

They are not derived from one another, so a web control can be shown to a role the API will
reject. The web matrix must be documented as presentation-only and eventually generated from
one server contract.

### A-04 (P1) — No ban/suspend surface

`AdminGuard` refuses banned users, and the user projection includes `bannedAt`, but there is
no endpoint to set it and no UI. Account suspension is currently a database operation.

### A-05 (P1) — Compliance reviewers cannot be created through the product

`UserRole` includes `COMPLIANCE_REVIEWER`, and `ComplianceReviewerGuard` accepts it, but
`UpdateUserRoleDto` permits only `USER` and `ADMIN` and no UI exposes role changes at all.
Creating a compliance reviewer currently requires direct database access.

## 4. Backend inventory versus UI

### 4.1 Endpoints that exist and are unused by the admin UI

| Domain | Endpoints |
| --- | --- |
| Campaign review | `GET /admin/campaigns`, `GET /admin/campaigns/:id`, `POST /admin/campaigns/:id/review` |
| Programmes | `GET/POST /admin/programmes`, `GET/PATCH /admin/programmes/:id`, `POST /admin/programmes/:id/status`, entries, curated-rank, judges, prizes, sponsors, announcements, results preview/publish/unpublish, report, analytics, audit |
| Platform params | `GET/PATCH /admin/params`, `GET /admin/params/audit`, `GET/PATCH /admin/boost-prices` |
| Users | `GET /admin/users`, `PATCH /admin/users/:id/role` |
| Analytics | `GET /admin/analytics/overview`, `GET/PATCH /admin/analytics/access-requests[/:id]` |
| Email | `GET /admin/email/templates`, `POST /admin/email/editorial/preview`, `POST /admin/email/editorial/send` |
| Moderation | `POST /admin/moderation/screen` |
| AI access | `GET /admin/ai/access-requests`, `PATCH /admin/ai/access-requests/:id` |

### 4.2 Endpoints that do not exist but the product needs

| Domain | Missing | Evidence of need |
| --- | --- | --- |
| Advertising | create/read/update/review creative, placements, impression/click events | `Advertisement*` models, full local admin, public ad slots |
| Contributions & escrow | admin list/detail, reconciliation, refunds | `Contribution`, `OnChainEvent`, `CampaignDeployment*` models |
| Milestones | claim queue, objection queue, ruling | `MilestoneClaim`, `MilestoneObjection`, `ReviewerRuling` models, creator claim UI exists |
| Global audit | cross-domain, filterable audit query | three separate audit tables already exist |
| User lifecycle | suspend/ban, compliance-reviewer assignment UI | `bannedAt`, `UserRole` |
| Notifications | admin broadcast/targeted send | `Notification` model, `/me/notifications` only |
| Taxonomy | create/update/delete categories | read-only taxonomy controller |
| Platform settings | anything beyond params/boost prices | `/admin/payments`, `/admin/audit` expectations |
| Media | moderation/approval of assets | `MediaAsset`, `MediaAssetStatus` |

## 5. Data and authority boundaries

1. **Money.** No admin page currently moves money, and the API has no admin money-mutation
   endpoint. `/admin/payments` presents fixture prize/sponsor totals. It must not be labelled
   a ledger until it reads a real projection. Admin must never confirm escrow release; chain
   state is authoritative.
2. **KYC/AML.** Only the verification pages touch real provider-derived state, and only
   through the API. They correctly show provider references without documents. Demo mode
   disables this path.
3. **Email.** No admin UI sends email. The API has preview/send under `AdminGuard`; any UI
   must use an explicit confirmation step and show the resolved recipient count.
4. **Chain.** No admin surface reads or writes chain state. `OnChainEvent` is indexer-only.
5. **Fixtures.** Fixtures are typed and deterministic, but they are also *production-shaped*:
   they include creator identity flags and funding totals. Every fixture surface must state
   it is not authoritative, which the current pages do.

## 6. Test coverage

| Layer | Existing | Gap |
| --- | --- | --- |
| Web unit (Vitest) | Campaign review queue/detail, verification panel, advertising store/validation/placements, programme domain | No tests for overview, audit log, payments, admin navigation, access gate, demo mode |
| API unit (Jest) | `admin.guard.spec.ts`, `privy-auth.guard.spec.ts`, `email-verified.guard.spec.ts` | No `ComplianceReviewerGuard` spec; no campaign-review service spec listed |
| API e2e | `jest-e2e.config.js` present | Not executed for admin routes in this audit |
| Browser (Playwright) | **Not installed** in either app | 13 required admin scenarios unverified |

No `data-testid` attributes existed in admin components before this change; accessible roles,
labels and `aria-current` are the primary selectors.

## 7. Documentation drift

| Document | Claim | Current reality |
| --- | --- | --- |
| `inverge-web/docs/product-audit.md` §2.1 | Campaign review API missing | `/admin/campaigns*` exists and is tested server-side |
| `inverge-web/docs/admin-review-sprint.md` | Backend dependencies outstanding | Campaign review, programmes, verification, analytics, params, users are live |
| `inverge-api/docs/campaign-review-sprint.md` | Review sprint status | Service and rules exist; web still on fixtures |
| `inverge-api/AGENTS.md` | Campaign surfaces do not call the API | Still true for campaigns, but verification does |

The stale documents should be updated rather than trusted for planning.

## 8. Priority summary

### P0 — correctness, safety, or access control

- **A-01** Explicit demo mode; production rejection; visible DEMO DATA banner. *(fixed)*
- **A-02** Do not render KYC risk-resolution controls to actors who cannot resolve them;
  do not call verification APIs in demo mode. *(demo path fixed; actor check open)*
- **Campaign review write path** — decisions must reach
  `POST /admin/campaigns/:id/review`, not localStorage.
- **Payments page** — remove or relabel fixture money. A page with invented totals is a
  correctness hazard even if labelled.
- **Milestone claim/objection review** — product-critical and entirely absent.

### P1 — the admin workspace becomes operational

- Campaign review reads/writes over the API.
- Programme list/create/edit/entries/judging/results over the API.
- Users + roles page; ban/suspend.
- Platform params + boost prices page.
- Global audit projection.
- Verification role awareness, paging and reason-code UX.
- Contributions/escrow read model.

### P2 — completeness

- Advertising API + admin.
- Idea moderation queue.
- Analytics admin (overview + access requests).
- Email editorial admin.
- Notification broadcast.
- Media moderation.

### P3 — polish

- Taxonomy write.
- Saved views, bulk actions, CSV export.
- Cross-domain search in the command palette.

## 9. Unresolved product questions

1. **Who may review campaigns?** The web matrix grants `campaign:review` only to
   `platform_admin`; the API grants it to `ADMIN`. Is an `organiser` ever allowed to review
   their own programme's campaign?
2. **Does verification review belong in `/admin`?** It uses a different role
   (`COMPLIANCE_REVIEWER`) and a different guard. Mixing it into the admin shell implies a
   platform-admin capability that compliance reviewers do not have. Should it be
   `/compliance`?
3. **What is `/admin/payments` allowed to show?** Sponsor invoices, prize fulfilment, escrow
   balances and contribution receipts are four different ledgers. Which one is this page?
4. **Is there a global audit requirement?** FR-904 implies one; today three audit tables
   exist with different shapes. Is an aggregated projection acceptable, or must there be one
   append-only table?
5. **Can an admin act on a campaign that is not `IN_REVIEW`?** The API enforces state
   transitions; the UI must not offer re-decision. Confirm that no override is wanted.
6. **What is the break-glass policy?** `ADMIN_ALLOWLIST` bypasses the DB role. Who owns it,
   and must its use be surfaced in the audit log?
7. **Should demo mode ever be deployable to a shared environment?** Current decision: no.
   Preview/staging should use real auth with seeded data instead.
