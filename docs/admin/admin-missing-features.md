# Admin missing features

Companion to [`admin-audit.md`](./admin-audit.md). Each entry uses the same eleven fields so
it can be lifted into an issue tracker unchanged.

## Template

| Field | Meaning |
| --- | --- |
| **1. ID / title** | Stable identifier and one-line name. |
| **2. Problem** | What is broken or absent today. |
| **3. Evidence** | Files, routes or models that prove it. |
| **4. User story** | Who needs it and why. |
| **5. Proposed behaviour** | The smallest coherent behaviour that solves it. |
| **6. Data & state** | Models, states and invariants the feature must respect. |
| **7. API contract** | Existing endpoints to use or proposed shapes. |
| **8. Permission model** | Who may read and who may write. |
| **9. Acceptance criteria** | Testable outcomes, including failure states. |
| **10. Priority / size / dependencies** | P0–P3, rough size, blockers. |
| **11. Out of scope** | What this feature deliberately does not do. |

---

## A. Access control and identity

### A-01 — Explicit admin demo mode

1. **ID / title:** A-01 — Server-enforced demo mode for fixture-only admin work.
2. **Problem:** Preview auth grants `platform_admin` in any non-production environment, so
   fixture admin is reachable without an explicit opt-in and without a production guard.
3. **Evidence:** `features/programmes/server/access.ts:37-55`; `INVERGE_AUTH_MODE` handling
   in `features/auth/server/auth-mode.ts`.
4. **User story:** As a developer, I want to demonstrate admin flows with fixture data
   without a real admin account, and as an operator I want that capability impossible in
   production.
5. **Proposed behaviour:** `ADMIN_DEMO_MODE=true` is the only way to obtain a demo identity.
   Off by default. `NODE_ENV=production` rejects it at environment validation. The shell
   shows a persistent **DEMO DATA** banner. Verification pages refuse API calls.
6. **Data & state:** Demo identity is synthetic (`demo-operator`), never a credential. No
   fixture is written to the database. Local stores stay local.
7. **API contract:** None. Demo mode must make zero admin API calls.
8. **Permission model:** Demo identity has presentation permissions only. Any future
   API-backed action must ignore the demo identity.
9. **Acceptance criteria:**
   - flag unset → admin requires a real session;
   - flag `true` outside production → demo shell with banner and `data-testid` hooks;
   - flag `true` with `NODE_ENV=production` → environment validation fails;
   - flag malformed (`1`, `yes`) → validation fails, no silent fallback;
   - verification queue and case pages render an unavailable notice instead of calling the API.
10. **Priority / size / dependencies:** **P0**, S. None.
11. **Out of scope:** Seeding a demo database, impersonating a real user, or simulating KYC,
    email, payments or chain state.

### A-02 — Role-aware admin shell

1. **ID / title:** A-02 — Render admin navigation and actions from one capability set.
2. **Problem:** Three permission vocabularies (web `AdminRole`, API `UserRole`, programme
   roles) can disagree; controls are hidden or shown inconsistently.
3. **Evidence:** `features/admin/permissions.ts`; `AdminGuard`;
   `admin-programmes.controller.ts`.
4. **User story:** As an operator, I only see sections I can actually use, and a denied
   action explains which role is required.
5. **Proposed behaviour:** Resolve one server-side capability object per request
   (`platform`, `compliance`, `programme_organiser`, `judge`) and pass it to the shell.
   Navigation items carry the capability they need. Denied routes render an explanation, not
   a blank page or a failing form.
6. **Data & state:** Capability is derived, never stored client-side.
7. **API contract:** `GET /me` (exists) extended with effective roles, or a dedicated
   `GET /admin/me/capabilities` (proposed).
8. **Permission model:** Server decides; client only renders.
9. **Acceptance criteria:** Compliance reviewer sees verification but not campaign review;
   organiser sees only their programmes; direct URL entry to a denied route yields an
   explanatory screen.
10. **Priority / size / dependencies:** **P1**, M. Needs the capabilities contract.
11. **Out of scope:** Per-field permissions and approval workflows.

### A-03 — User administration and suspension

1. **ID / title:** A-03 — Search users, change roles, suspend accounts.
2. **Problem:** The list/role endpoints are unused, and there is no suspension endpoint.
3. **Evidence:** `admin.controller.ts:96-146`; `User.bannedAt`; no banning route.
4. **User story:** As a platform admin, I can find an account and grant or revoke access
   without touching the database.
5. **Proposed behaviour:** Paginated/searchable user table with role, KYC state and ban
   state. Role change requires confirmation and writes an audit entry. Suspension requires a
   reason and is reversible.
6. **Data & state:** `User.role`, `User.bannedAt`; `PlatformParamAudit` key
   `auth.user.role` for role changes; a new audit key for bans.
7. **API contract:** Existing `GET /admin/users`, `PATCH /admin/users/:id/role`; proposed
   `POST /admin/users/:id/suspend` and `POST /admin/users/:id/reinstate`. The role DTO
   currently accepts only `USER` and `ADMIN`, so assigning `COMPLIANCE_REVIEWER` needs a DTO
   extension as well.
8. **Permission model:** `ADMIN` only; self-demotion blocked (already implemented).
9. **Acceptance criteria:** Cannot revoke own admin role; suspended user is refused by
   `AdminGuard`; every change appears in the audit log with actor, before and after.
10. **Priority / size / dependencies:** **P1**, M. Global audit (F-01) for display.
11. **Out of scope:** Deleting accounts or exporting personal data.

### A-06 — Dedicated admin authentication

1. **ID / title:** A-06 — Admin-only sign-in, session and credential lifecycle.
2. **Problem:** Admin access rides on the product wallet/social session. New accounts are always
   `role: 'USER'`, so an operator cannot sign in as an admin; authority depends on a DB edit or
   `ADMIN_ALLOWLIST`.
3. **Evidence:** `inverge-api/src/modules/auth/auth.service.ts:92`;
   `inverge-web/src/app/admin/layout.tsx`; `src/features/programmes/server/access.ts`;
   `AdminGuard`.
4. **User story:** As an operator, I sign in with a staff credential at `/admin/sign-in`, and as a
   security owner I can revoke that access without touching a product account.
5. **Proposed behaviour:** Separate admin identity and session (email + password + TOTP), opaque
   HttpOnly cookie, 20-minute TTL, idle timeout, revocation, lockout, and an append-only auth
   event log. Legacy product-session access is flag-gated during migration.
6. **Data & state:** New `AdminUser`, `AdminSession`, `AdminAuthEvent`, `AdminRecoveryCode`;
   product `User` and its role are untouched.
7. **API contract:** `POST /admin-auth/login`, `/mfa`, `/logout`; `GET /admin-auth/me`;
   `AdminSessionGuard` on `/admin/*`. Full shapes in
   [`admin-auth.md`](./admin-auth.md) §8.
8. **Permission model:** Admin roles are `SUPER_ADMIN`, `OPERATOR`, `REVIEWER`, `READ_ONLY`;
   capabilities are resolved per request. No admin route accepts a product token after cutover.
9. **Acceptance criteria:** Wallet session cannot open `/admin`; valid password without TOTP
   issues no session; revoked/suspended admin is rejected immediately; every outcome is audited;
   demo mode never calls `/admin-auth/*`.
10. **Priority / size / dependencies:** **P0**, L. Blocks the operational-workspace claim and the
    repo split. Needs a hashing-dependency decision and a staging API/database.
11. **Out of scope:** SSO, passkeys, email-based invitations and email password reset in the first
    delivery.

---

## B. Campaign review and moderation

### B-01 — API-backed campaign review

1. **ID / title:** B-01 — Move campaign review off fixtures and localStorage.
2. **Problem:** Every decision is a browser-local record. Two admins reviewing the same
   campaign cannot see each other's work.
3. **Evidence:** `features/campaigns/lib/admin-review-store.ts:16-24`;
   `app/admin/campaigns/page.tsx` imports `previewCampaigns`.
4. **User story:** As a reviewer, my decision is authoritative, attributed and visible to the
   next reviewer.
5. **Proposed behaviour:** Server-render the queue and detail from the API. Submit a decision
   with `action` + `reason`. On success, revalidate and show the server's review history.
   Remove the local override path or keep it strictly for demo mode.
6. **Data & state:** `Campaign.reviewStatus` (`NOT_SUBMITTED`, `IN_REVIEW`,
   `CHANGES_REQUESTED`, `APPROVED`, `REJECTED`), `CampaignReviewEvent` append-only.
7. **API contract:** Existing `GET /admin/campaigns`, `GET /admin/campaigns/:id`,
   `POST /admin/campaigns/:id/review`. Detail already returns KYC, fee and escrow facts.
8. **Permission model:** `ADMIN` via `AdminGuard`; state transition enforced server-side.
9. **Acceptance criteria:** Decision persists across browsers; re-deciding a decided campaign
   returns a conflict; reason is required for change request and rejection; the detail page
   shows verification and fee facts from the server, not fixtures.
10. **Priority / size / dependencies:** **P0**, M. Demo mode must remain isolated.
11. **Out of scope:** Publishing the campaign or releasing funds from the review screen.

### B-02 — Idea and content moderation queue

1. **ID / title:** B-02 — Queue for flagged ideas, comments and media.
2. **Problem:** `ModerationCase` and `IdeaQualityReport` exist; only a stateless
   `POST /admin/moderation/screen` tool exists. There is no queue.
3. **Evidence:** `moderation.controller.ts`; Prisma `ModerationCase`, `IdeaQualityReport`,
   `MediaAssetStatus`.
4. **User story:** As a moderator, I can work through flagged content with context and record
   a decision.
5. **Proposed behaviour:** Filterable queue by reason, severity and age. Detail shows content,
   signals, prior decisions and reporter context. Decisions are advisory per NFR-17 unless a
   policy explicitly allows enforcement.
6. **Data & state:** `ModerationDecision`, `IdeaStatus`, `MediaAssetStatus`; append-only
   decisions.
7. **API contract:** Proposed `GET /admin/moderation/cases`, `GET …/:id`,
   `POST …/:id/decision`.
8. **Permission model:** `ADMIN`; optionally a future `MODERATOR` role.
9. **Acceptance criteria:** Queue is stable under pagination; decision records actor and
   reason; no automatic rejection from classifier output alone.
10. **Priority / size / dependencies:** **P2**, L. Depends on policy decisions.
11. **Out of scope:** Automated takedown and appeals.

### B-03 — Campaign comment and update moderation

1. **ID / title:** B-03 — Moderate campaign discussion and creator updates.
2. **Problem:** `CampaignComment` and `IdeaComment` have no admin surface.
3. **Evidence:** Prisma models; no admin route.
4. **User story:** As an operator, I can hide abusive discussion and review flagged updates.
5. **Proposed behaviour:** Thread view with hide/restore and a reason, linked from the
   moderation queue.
6. **Data & state:** Comment visibility flag + audit event.
7. **API contract:** Proposed admin comment endpoints.
8. **Permission model:** `ADMIN` or `MODERATOR`.
9. **Acceptance criteria:** Hidden comment disappears from public reads; reason is visible to
   the author; action is audited.
10. **Priority / size / dependencies:** **P3**, M. Depends on B-02.
11. **Out of scope:** Editing user content.

---

## C. Programme operations

### C-01 — API-backed programme dashboard

1. **ID / title:** C-01 — Replace `previewProgrammes` with the programme admin API.
2. **Problem:** Creating or editing a programme writes to `localStorage`.
3. **Evidence:** `programmes/lib/local-store.ts:1-12`; `admin-programmes.controller.ts`.
4. **User story:** As a programme organiser, my programme is visible to participants and
   survives a browser reset.
5. **Proposed behaviour:** List from `GET /admin/programmes`; create/edit via
   `POST`/`PATCH`; lifecycle via `POST /admin/programmes/:id/status`. Drafts may remain local
   until the first save, then become server drafts.
6. **Data & state:** `ProgrammeStatus` transitions; `ProgrammeAuditEvent`.
7. **API contract:** Existing programme admin endpoints.
8. **Permission model:** `ADMIN`; future per-programme organiser scope.
9. **Acceptance criteria:** Published programme is publicly readable; invalid transitions
   return a conflict; audit shows status changes.
10. **Priority / size / dependencies:** **P1**, L. Needs capability model (A-02).
11. **Out of scope:** Payments to winners.

### C-02 — Entries, judging and results

1. **ID / title:** C-02 — Operate entries, judges, prizes and results from the API.
2. **Problem:** Entry decisions, curated ranks, judge assignment and result publication are
   fixture-only, despite a complete API.
3. **Evidence:** `admin-programmes.controller.ts:20-40`.
4. **User story:** As an organiser, I can run a programme end to end without local state.
5. **Proposed behaviour:** Tabs for entries, judging, prizes, sponsors, announcements and
   results. Result publication requires a preview step and explicit confirmation; unpublish
   is audited.
6. **Data & state:** `ProgrammeEntryStatus`, `ProgrammeEvaluation`, `ProgrammeResultPublication`,
   `ProgrammePrize`, `ProgrammeSponsor`.
7. **API contract:** Existing entry, judge, prize, sponsor, announcement, result endpoints.
8. **Permission model:** `ADMIN` + per-programme organizer.
9. **Acceptance criteria:** Curated rank is ordered and unique; results cannot publish while
   evaluations are incomplete; every mutation appears in the programme audit.
10. **Priority / size / dependencies:** **P1**, XL. Split into entries, judging, results.
11. **Out of scope:** Judge-facing scoring UI (separate surface).

---

## D. Money, escrow and disputes

### D-01 — Milestone claim and objection review

1. **ID / title:** D-01 — Reviewer queue for milestone claims and objections.
2. **Problem:** Creators can submit claims; no admin surface exists to review them, and
   `ReviewerRuling` is unused. This blocks the core escrow promise.
3. **Evidence:** Prisma `MilestoneClaim`, `MilestoneObjection`, `ReviewerRuling`;
   `features/campaigns/components/milestone-claim-form.tsx`; no controller.
4. **User story:** As a reviewer, I can inspect evidence, objections and history, then record
   a ruling that the escrow release path can trust.
5. **Proposed behaviour:** Queue of claims awaiting ruling. Detail shows milestone terms,
   evidence, objection window, objection text and prior rulings. Ruling requires a reason and
   is append-only. The UI never triggers a chain transaction.
6. **Data & state:** `ClaimStatus`, objection window, `ReviewerRuling`. A ruling is an input
   to escrow, not a substitute for it.
7. **API contract:** Proposed `GET /admin/milestones/claims`, `GET …/:id`,
   `POST …/:id/ruling`; existing campaign/milestone reads.
8. **Permission model:** `ADMIN` plus a distinct `REVIEWER` capability; never the campaign
   creator.
9. **Acceptance criteria:** Cannot rule twice; reason mandatory; ruling references
   objection state; UI states explicitly that funds move only after the on-chain
   transaction.
10. **Priority / size / dependencies:** **P0** for product, L. Needs escrow-read model.
11. **Out of scope:** Executing releases or refunds from the admin UI.

### D-02 — Contributions and escrow reconciliation

1. **ID / title:** D-02 — Read-only contribution and chain reconciliation view.
2. **Problem:** There is no admin view of contributions, deployment fees or indexer drift.
3. **Evidence:** `Contribution`, `OnChainEvent`, `CampaignDeployment*` models; no admin route.
4. **User story:** As an operator, I can answer "did this contribution reach escrow?" without
   querying the database.
5. **Proposed behaviour:** Per-campaign contributions with status, tx signature and
   reconciliation state. Mismatches are surfaced, never auto-corrected.
6. **Data & state:** `OnChainEvent` is indexer-only; off-chain records are projections.
7. **API contract:** Proposed `GET /admin/campaigns/:id/contributions`,
   `GET /admin/escrow/reconciliation`.
8. **Permission model:** `ADMIN`; read-only.
9. **Acceptance criteria:** A contribution shows both off-chain and on-chain state; a
   mismatch is flagged; no write path exists.
10. **Priority / size / dependencies:** **P1**, M.
11. **Out of scope:** Manual reconciliation writes and refunds.

### D-03 — Payments page must be real or removed

1. **ID / title:** D-03 — Replace fixture ledger totals.
2. **Problem:** `/admin/payments` displays prize pool and sponsor totals from fixtures.
3. **Evidence:** `app/admin/payments/page.tsx` imports `previewProgrammes`.
4. **User story:** As a finance operator, I never mistake sample numbers for money.
5. **Proposed behaviour:** Either remove the route until a ledger exists, or back it with a
   real read-only projection and a visible data-as-of timestamp. Never show fixture amounts
   without a per-value **DEMO** marker.
6. **Data & state:** `ProgrammePrize`, `ProgrammeSponsor`, `FlatFeeCharge`, `Contribution`.
7. **API contract:** `GET /admin/programmes/:id/report` exists; a finance aggregate is
   proposed.
8. **Permission model:** `ADMIN`; read-only.
9. **Acceptance criteria:** No unlabelled fixture money; totals reconcile with their source;
   empty state is explicit.
10. **Priority / size / dependencies:** **P0** safety, S (remove/relabel) → M (real data).
11. **Out of scope:** Payouts and invoicing.

---

## E. Advertising and taxonomy

### E-01 — Advertisement API and admin

1. **ID / title:** E-01 — Persist advertising inventory server-side.
2. **Problem:** The entire advertising admin is localStorage while `Advertisement*` models
   exist and public ad slots read fixtures.
3. **Evidence:** `advertising/lib/admin-store.ts:15-24`; Prisma `Advertisement`,
   `AdvertisementPlacement`, `AdvertisementReviewEvent`, `AdvertisementEvent`.
4. **User story:** As an ad ops admin, approval on my machine is visible to every reader.
5. **Proposed behaviour:** Create/edit creative, submit, approve/reject with reason, schedule,
   pause, end. Public slots read only approved creatives inside their schedule window.
6. **Data & state:** `AdCreativeStatus`, `AdReviewAction`, placement and category targeting.
7. **API contract:** Proposed `/admin/advertisements` CRUD + transitions; public read
   endpoint used by `advertising/server/view.ts`.
8. **Permission model:** `advertising:manage` and `advertising:approve`; approval must be a
   separate capability from editing.
9. **Acceptance criteria:** An edit returns an approved creative to draft; rejected creatives
   never render; every transition is audited; labels remain visible.
10. **Priority / size / dependencies:** **P2**, L. Blocked on the inventory contract.
11. **Out of scope:** Programmatic bidding, third-party network sync.

### E-02 — Taxonomy management

1. **ID / title:** E-02 — Create and edit categories and subcategories.
2. **Problem:** Taxonomy is read-only; adding a category requires a migration or seed.
3. **Evidence:** `taxonomy.controller.ts`; Prisma `TaxonomyCategory`,
   `TaxonomySubcategory`.
4. **User story:** As an operator, I can add a category without a deployment.
5. **Proposed behaviour:** Orderable list with slugs, active flag and usage counts. Deletion
   is refused while in use.
6. **Data & state:** Slug uniqueness; referential integrity with ideas and campaigns.
7. **API contract:** Proposed write endpoints.
8. **Permission model:** `ADMIN`.
9. **Acceptance criteria:** Cannot delete in-use taxonomy; order persists; public navigation
   updates.
10. **Priority / size / dependencies:** **P3**, M.
11. **Out of scope:** Bulk taxonomy import.

---

## F. Platform operations

### F-01 — Global audit projection

1. **ID / title:** F-01 — One queryable audit view across domains.
2. **Problem:** Three audit tables with different shapes, and `/admin/audit` shows fixtures.
3. **Evidence:** `PlatformParamAudit`, `CampaignReviewEvent`, `ProgrammeAuditEvent`;
   `app/admin/audit/page.tsx` imports `previewAuditEntries`.
4. **User story:** As an operator or auditor, I can answer "who changed this, when, and what
   was the previous value" across the platform.
5. **Proposed behaviour:** Filter by actor, domain, entity, date. Read-only. Export is a
   later concern.
6. **Data & state:** A projection or view over the three tables; immutable rows.
7. **API contract:** Existing `GET /admin/params/audit`, `GET /admin/programmes/:id/audit`;
   proposed `GET /admin/audit`.
8. **Permission model:** `ADMIN`; optionally a read-only `AUDITOR`.
9. **Acceptance criteria:** Pagination is stable; no row can be edited or deleted; filters
   compose; empty state explains that no matching event exists.
10. **Priority / size / dependencies:** **P1**, M.
11. **Out of scope:** SIEM export and retention automation.

### F-02 — Platform parameters and boost prices

1. **ID / title:** F-02 — Edit platform params and boost prices with history.
2. **Problem:** Endpoints exist, no UI. Operators must call the API directly.
3. **Evidence:** `admin.controller.ts:45-94`.
4. **User story:** As an operator, I can change a boost price and see who changed it last.
5. **Proposed behaviour:** Typed forms per parameter, validation, confirmation for
   money-adjacent values, and an inline change history.
6. **Data & state:** `PlatformParam` + `PlatformParamAudit`.
7. **API contract:** Existing params and boost-price endpoints.
8. **Permission model:** `ADMIN`; `settings:manage`.
9. **Acceptance criteria:** Invalid values are rejected before submit; every change is
   audited with old and new values; defaults are visible.
10. **Priority / size / dependencies:** **P1**, S–M.
11. **Out of scope:** Feature flags that require a redeploy.

### F-03 — Analytics admin

1. **ID / title:** F-03 — Overview metrics and analytics access requests.
2. **Problem:** Endpoints exist; no UI. Access requests cannot be approved.
3. **Evidence:** `analytics.controller.ts`.
4. **User story:** As an admin, I can see platform reach and grant analytics access.
5. **Proposed behaviour:** Range-filtered overview cards and a request queue with
   approve/deny + reason.
6. **Data & state:** `AnalyticsAccessGrant`; derived metrics.
7. **API contract:** Existing `/admin/analytics/*`.
8. **Permission model:** `ADMIN`.
9. **Acceptance criteria:** Metrics state their range and as-of time; decisions are audited.
10. **Priority / size / dependencies:** **P2**, M.
11. **Out of scope:** Custom report builder.

### F-04 — Email editorial admin

1. **ID / title:** F-04 — Preview and send editorial email.
2. **Problem:** Sending exists in the API with no UI guard rails.
3. **Evidence:** `admin-email.controller.ts`.
4. **User story:** As a comms operator, I can preview a send and see exactly who receives it.
5. **Proposed behaviour:** Template list, merge preview, recipient count, explicit typed
   confirmation before send, suppression summary.
6. **Data & state:** `EmailDelivery`, `EmailSuppression`, `EmailSubscription`.
7. **API contract:** Existing templates/preview/send endpoints.
8. **Permission model:** `ADMIN`; separate `email:send` capability.
9. **Acceptance criteria:** Send is impossible without confirmation; suppressed addresses are
   excluded and counted; failures are reported per recipient.
10. **Priority / size / dependencies:** **P2**, M. Depends on the email contract.
11. **Out of scope:** Marketing automation and drip sequences.

### F-05 — Notification broadcast

1. **ID / title:** F-05 — Send targeted platform notifications.
2. **Problem:** Only `/me/notifications` exists.
3. **Evidence:** `notifications.controller.ts`; Prisma `Notification`.
4. **User story:** As an operator, I can announce a programme or incident to a segment.
5. **Proposed behaviour:** Compose, audience preview, schedule, cancel. Delivery is recorded.
6. **Data & state:** `Notification`; audience definition.
7. **API contract:** Proposed admin notification endpoints.
8. **Permission model:** `ADMIN`.
9. **Acceptance criteria:** Audience count is shown before send; cancel prevents delivery;
   delivery is audited.
10. **Priority / size / dependencies:** **P2**, M.
11. **Out of scope:** Push/email channel orchestration beyond existing services.

---

## Suggested build order

1. **A-01** demo mode (done) — makes every later demo safe.
2. **B-01** campaign review write path — highest operational value, API already exists.
3. **D-03** payments page relabel/removal — removes a correctness hazard.
4. **A-02** capability model — prerequisite for programme and user work.
5. **C-01/C-02** programme operations.
6. **D-01** milestone rulings — product-critical, needs design.
7. **F-01/F-02** audit and parameters.
8. **A-03**, **D-02**, **F-03**.
9. **E-01**, **B-02**, **F-04**, **F-05**.
10. **B-03**, **E-02**.
