# Campaign review sprint (API)

Status: implementation in progress. Verification results are appended in section 8.

## 1. Why

The web admin sprint established a preview review queue, a decision guard, and a
browser-local audit trail. It deliberately left three things undone, and the
product audit records them as missing or blocked:

- review decisions never leave the browser;
- no Prisma state distinguishes `IN_REVIEW`, `CHANGES_REQUESTED`, `APPROVED` and
  `REJECTED`;
- FR-103 (KYC before submission) and FR-311 (application fee before entering the
  queue) are not enforced by `POST /campaigns/:id/submit`.

This sprint closes those gaps in the API. It does not attempt to connect the web
preview to the API: the web has no session client or server-side data layer yet.

## 2. Scope

1. **Session exchange (gap item 25).** `POST /auth/session` currently returns the
   caller's provider token under `token`; callers need the Inverge session JWT
   under `sessionToken`. Tests already assume this shape, so the suite captures
   the regression.
2. **Review state.** Add `CampaignReviewStatus` (`NOT_SUBMITTED`, `IN_REVIEW`,
   `CHANGES_REQUESTED`, `APPROVED`, `REJECTED`) and review metadata on
   `Campaign`. The funding lifecycle (`CampaignStatus`) is untouched: approving
   a campaign does not publish it or imply escrow.
3. **Authoritative audit.** Add append-only `CampaignReviewEvent` rows carrying
   actor, action, from/to state, reason and timestamp. Application code never
   updates or deletes them.
4. **Admin review API.**
   - `GET /admin/campaigns` - review queue, filterable by review status.
   - `GET /admin/campaigns/:id` - review detail: campaign snapshot, creator
     verification facts, application-fee fact, and review history.
   - `POST /admin/campaigns/:id/review` - approve, request changes, or reject.
     Request-changes and rejection require a trimmed reason of 20-2000
     characters. Approval may carry an optional note.
5. **Submission gates.** `POST /campaigns/:id/submit` must verify:
   - FR-103: the creator (or their business) is funds-eligible (`KYC`/`KYB`
     verified and AML clear);
   - FR-311: a `SUCCEEDED` `APPLICATION_FEE` charge owned by the creator is
     linked to the campaign.
   The charge id is accepted in the submit body when the campaign has not linked
   one yet. Re-submission after a change request reuses the same paid charge.
6. **Tests and docs.** Pure rule tests, submission-gate tests, and an e2e suite
   against Postgres covering RBAC, validation, transitions, audit rows and
   double-decision conflicts.

## 3. Non-goals

- Publication: no transition to `ACTIVE`, no `termsHash`, no on-chain event.
  `CampaignStatus` stays `IN_REVIEW` after approval until a publication flow
  exists. The API contract says so explicitly.
- Payment initiation: no Paystack charge creation endpoint is added. The gate
  verifies an existing successful charge; fabricating a charge is never allowed.
- KYC provider work, notifications, escrow, disputes, and the remainder of the
  admin workspace.
- Connecting `inverge-web` to the API.

## 4. Decisions

- **Review state is separate from funding state.** `Campaign.status` continues
  to describe the funding lifecycle. `reviewStatus` is the single source of
  truth for curation. This avoids overloading `IN_REVIEW` with "approved but
  unpublished".
- **Approval is not publication.** An approved campaign remains
  `status = IN_REVIEW` with `reviewStatus = APPROVED`. A later publication step
  must set escrow, the terms hash and `launchedAt`.
- **One application fee per campaign.** `applicationFeeChargeId` is unique. A
  successful charge cannot be claimed by a second campaign. Re-submission after
  changes reuses it (the fee is non-refundable and already paid - FR-311).
- **Reason bounds mirror the web guard.** 20 characters minimum, 2000 maximum,
  trimmed. Approval has no required reason.
- **Preconditions are re-checked at approval.** KYC can be revoked after
  submission; approval re-evaluates the same gates and returns 422 with the
  blockers when they no longer hold. Change requests and rejections do not
  require the gates.
- **Concurrency.** The decision update is conditional on
  `reviewStatus = IN_REVIEW`; a second concurrent decision receives 409. The
  state update and the audit append share one transaction.
- **Admin surface.** Existing `PrivyAuthGuard` + `AdminGuard` (role `ADMIN` or
  `ADMIN_ALLOWLIST`). No new permission vocabulary is invented in the API.

## 5. Contract

### `POST /auth/session`

Request: `{ accessToken }`. Response adds `sessionToken` (JWT, 1 hour); the
provider token is no longer returned. `user`, `creator` and
`requiresOnboarding` are unchanged.

### `POST /campaigns/:id/submit`

Auth: creator. Body: `{ applicationFeeChargeId? }`. Success: `status` and
`reviewStatus` become `IN_REVIEW`, `submittedAt` is set, `reviewReason` cleared.
Failure: 403 not the creator; 400 with `{ message, blockers }` when eligibility
or fee checks fail; 409 when the current state is not `DRAFT` or
`CHANGES_REQUESTED`.

### `GET /admin/campaigns`

Auth: admin. Query: `reviewStatus` (default `IN_REVIEW`, or `ALL`), `skip`,
`take`. Returns `{ items, total, skip, take }` ordered oldest-submitted first for
`IN_REVIEW`, newest-reviewed first otherwise. Items expose campaign summary,
creator display identity, and submission timestamps only.

### `GET /admin/campaigns/:id`

Auth: admin. Returns the campaign summary, milestone terms, creator verification
facts (statuses only - never provider refs), business verification facts,
application-fee fact, computed `preconditions` (identity/business, application
fee), and review events newest first with actor projection.

### `POST /admin/campaigns/:id/review`

Auth: admin. Body: `{ action: 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT', reason? }`.
Success: `{ id, reviewStatus, reviewedAt, reviewedById, reviewReason, event }`.
Failure: 400 bad reason; 404 unknown campaign; 409 not in review; 422 approval
blocked by unmet preconditions with `{ message, blockers }`.

## 6. Data changes

```prisma
enum CampaignReviewStatus { NOT_SUBMITTED IN_REVIEW CHANGES_REQUESTED APPROVED REJECTED }
enum CampaignReviewAction { APPROVE REQUEST_CHANGES REJECT }

model CampaignReviewEvent {
  id, campaignId, actorId, action, fromStatus, toStatus, reason?, createdAt
  @@index([campaignId, createdAt])
  @@index([createdAt])
}
```

`Campaign` gains `reviewStatus`, `submittedAt`, `reviewedAt`, `reviewedById`,
`reviewReason` and `reviewEvents`; `applicationFeeChargeId` becomes unique.

## 7. Acceptance criteria

- A non-admin cannot read the queue or decide a review.
- A campaign cannot enter the queue without funds eligibility and a successful,
  owned application fee; the response names the blockers.
- Valid approaches: `IN_REVIEW` -> `APPROVED`, `IN_REVIEW` ->
  `CHANGES_REQUESTED`, `IN_REVIEW` -> `REJECTED`; every decision appends exactly
  one event with actor and reason.
- Rejection/change request without a 20-character reason is refused and writes
  nothing.
- A decided campaign cannot be decided again.
- `CHANGES_REQUESTED` can be resubmitted and re-reviewed without a second fee.
- Approval after KYC revocation is refused.
- No response leaks `kycProviderRef`, `kybProviderRef`, or `processorRef`.
- `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build` pass.

## 8. Verification

Date: 2026-10-19. Environment: Windows, Node v22.14.0, Postgres reachable at
`localhost:5432`. Redis is not running, so BullMQ logs `ECONNREFUSED 6379`; no
queue-consuming behavior is exercised. `maxWorkers: 1` was added to
`jest-e2e.config.js` because the e2e suites share one Postgres database and the
stub auth identities.

### 8.1 Commands run

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm typecheck` | **Passed** | `tsc --noEmit -p tsconfig.json` clean |
| `pnpm build` | **Passed** | `nest build` |
| `pnpm test` (unit) | **1 suite failed (pre-existing)** | 27 suites passed, 1 failed; 250 tests passed, 16 failed. The failures are all in `src/modules/ideas/ideas.service.spec.ts` with `this.prisma.idea.findFirst is not a function`: the spec's Prisma mock predates the service's `findFirst`-based `get()`. The file is untouched by this sprint |
| `pnpm test:e2e` | **5 of 6 suites passed** | 94 tests passed. The one failing suite is `test/moderation.ai.e2e-spec.ts`, a live classifier test against the configured provider endpoint; it receives HTTP 402 `Insufficient Balance` (external account billing, not a code defect). `campaign-review.e2e-spec.ts` passes 10/10; `admin`, `ideas`, `feed`, and `kyc` pass |
| `pnpm format` | **Cannot run (pre-existing)** | `prettier` is referenced by the `format` script but is not in `devDependencies`, so the command is unavailable and there is no `format:check`. No dependency was added without approval. `prisma format` and `prisma validate` were run and are clean |

### 8.2 New coverage

- `campaign-review.rules.spec.ts` and `campaign-review.preconditions.spec.ts` -
  19 unit tests over the transition rules, reason bounds, and FR-103/FR-311 gates.
- `campaign-review.e2e-spec.ts` - 10 tests: RBAC denial, submit gates with named
  blockers, application-fee linkage and reuse across resubmission, queue/detail
  privacy (no `kycProviderRef`/`kybProviderRef`/`processorRef`), reason
  validation, request-changes then resubmit, approve-does-not-publish,
  double-decision 409, KYC-revocation 422, terminal rejection, and 404s.

### 8.3 Adjacent repairs required to make the gate meaningful

Pre-existing defects that this sprint's auth change surfaced or that blocked the
suites:

- `AuthService.authenticate` derived the DID and email from a truncated token
  prefix, so several callers within one suite resolved to the same user and
  cleanup never matched. It now derives a stable identity from the whole token
  (`stub:<identity>:<email>`; a bare token is hashed into a unique email). The
  `ideas`, `feed`, and `kyc` suites clean up by `did:privy:stub:<prefix>` and now
  pass.
- `toPublicCreator` fell back to the account email local part as a public
  `displayName`, leaking email-derived identifiers on public surfaces. The
  fallback is removed and an unset display name stays `null`;
  `creator-profile.projection.spec.ts` now passes.
- The `ideas`, `feed`, and `kyc` e2e fixtures used the removed `agriculture`
  category; they now use `agritech`, matching the DTO's allowed values.
- `admin.e2e-spec.ts` used identities that collided under the stub and is now
  run-unique.

### 8.4 Known limitations

- Redis is not running; BullMQ connection errors are logged and no queued work is
  processed.
- The live AI moderation test depends on a funded external provider account and
  is not deterministic in CI.
- The unit failures in `ideas.service.spec.ts` are mock drift, not product
  behavior; repairing that mock is a separate task.
- The API `format` gate cannot run until `prettier` is installed; this is
  pre-existing and was not changed.

