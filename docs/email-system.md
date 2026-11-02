# Email system

Status: **implemented through the account, idea, campaign and verification
domains**. Payment, contribution, milestone-decision and refund mail is **not
wired** because those domain events do not exist in this API yet (see
[Blocked integrations](#blocked-integrations)). This document records the audit,
the architecture, every environment variable, the provider setup and the manual
staging checks.

## 1. Audit findings

What already existed before this work:

| Area | Finding |
|---|---|
| Provider | Resend over REST, behind `EMAIL_PORT` (`src/ports/email/`). A stub writes to `.local/email-outbox` and refuses to run in production. |
| Verification | Six-digit codes, HMAC-SHA256 with a server pepper, single-use, expiry, attempts, per-hour cap, resend cooldown, advisory-lock serialisation (`modules/auth/email/`). |
| Registration | `AuthService.authenticate` stores a provider email only as **verified** when the signed token carries `email_verified: true`; otherwise it is stored as unverified and the account is sent through OTP. `suggestedEmail` is never persisted. |
| Identity states | Email ownership (`emailVerifiedAt`), KYC (`kycStatus`) and AML (`amlStatus`) are separate columns and separate flows. |
| Notifications | Persisted `Notification` row first, then dispatch; BullMQ retry (5 attempts), `dedupeKey` uniqueness, per-template preferences, in-app read API. |
| Queue | One BullMQ queue (`inverge-jobs`) and one Worker; in-process timers for periodic work. |
| Webhooks | `POST /webhooks/didit` and Paystack callbacks verify raw-body HMACs; `WebhookInboxService` gives at-most-once application keyed by provider event id. |
| Consent | No consent record existed. `notifyDiscoveryDigest` is a delivery preference, not marketing consent. |
| Domain events | Only idea→campaign conversion emitted a notification (`WAITLIST_CONVERSION`). `CAMPAIGN_FUNDED` and milestone templates existed but nothing emitted them. |
| Contributions | Read-only projections (`Contribution`, `ContributionAuthorization`). No contribution, funding, milestone-decision or refund service exists. |

Decisions taken from the audit:

- **One send path.** The previous notification adapter rendered its own HTML and
  called `EMAIL_PORT` directly. That duplicated the new delivery ledger,
  suppression and provider-idempotency logic, so the adapter layer for email was
  removed. `NotificationMessage` remains the contract; `NotificationsService`
  now calls `EmailDeliveryService`. The in-app notification row, dedupe key,
  queue and retry semantics are unchanged.
- **Templates are pure code**, versioned in `src/common/email/`, not stored in a
  database or a vendor dashboard.
- **`SENT` means accepted by Resend.** Only a signed `email.delivered` webhook
  moves a row to `DELIVERED`.

## 2. Architecture

```
domain service (idea, comment, campaign, KYC, verification)
        │  NotificationsService.notify()          (persisted row + retry)
        │  or EmailVerificationService             (code, no notification row)
        ▼
EmailDeliveryService                              src/modules/email/
  ├─ renderEmailTemplate(id, vars, context)       src/common/email/
  ├─ EmailSubscription / EmailSuppression checks
  ├─ EmailDelivery claim (unique idempotency key)
  └─ EMAIL_PORT.send()  ── Resend / stub
        │
        ▼
POST /api/v1/webhooks/resend  (Svix signature)
  └─ WebhookInboxService (dedupe by svix-id)
       ├─ EmailDelivery status: DELIVERED / BOUNCED / COMPLAINED / FAILED / DELAYED
       └─ EmailSuppression: HARD_BOUNCE / COMPLAINT
```

### Templates

`src/common/email/` is a pure, testable module:

- `brand.ts` - the four required brand colours (`#FBF9F5`, `#1FA85C`,
  `#0D1D15`, `#EAE6E1`), HTML escaping, header sanitisation, absolute-URL
  enforcement.
- `layout.ts` - table-based responsive shell, hidden preview text, 600px
  container, mobile media query, Outlook-safe button, footer with sender
  identification and unsubscribe when the template is marketing.
- `catalog.ts` - every template: category, required variables, copy builder.
- `render.ts` - validation, locale negotiation (`en` today, fallback), and the
  marketing rule: an unsubscribe URL **and** a postal address are mandatory.
- `unsubscribe-token.ts` - stateless HMAC token (no token table to leak).

Every template produces a subject, preview text, HTML, plain text, an optional
CTA, and a footer reason. Variables are escaped on output; a subject cannot carry
a newline. A missing required variable raises `EmailTemplateError` naming only the
variable keys.

| Template | Category | Required variables | Emitted from |
|---|---|---|---|
| `VERIFICATION_CODE` | transactional | `code`, `expiresInMinutes`, `purpose` | Email verification request/resend |
| `EMAIL_VERIFIED` | transactional | - | Successful verification |
| `EMAIL_CHANGED` | transactional | `changedAt` | Successful address change (sent to the previous address) |
| `IDEA_PUBLISHED` | transactional | `ideaTitle` | `IdeasService.publish` |
| `IDEA_FEEDBACK` | transactional | `ideaTitle` | `SurveyService.submitResponse` |
| `IDEA_COMMENT` | transactional | `ideaTitle` | `CommentsService.post` |
| `WAITLIST_IDEA_LIVE` | transactional | - | Idea→campaign conversion |
| `ACCOUNT_UPDATE` | transactional | - | Safe fallback for an unknown notification template |
| `CAMPAIGN_SUBMITTED` | transactional | `campaignTitle` | `CampaignsService.submit` |
| `CAMPAIGN_APPROVED` | transactional | `campaignTitle` | Campaign review decision |
| `CAMPAIGN_CHANGES_REQUESTED` | transactional | `campaignTitle` | Campaign review decision |
| `CAMPAIGN_PUBLISHED` | transactional | `campaignTitle` | `CampaignDraftsService.publish` |
| `CAMPAIGN_FUNDED` | transactional | `campaignTitle` | **No emitter yet** (needs reconciled chain event) |
| `MILESTONE_REVIEW` | transactional | `milestoneTitle` | **No emitter yet** (no milestone service) |
| `KYC_APPROVED` / `KYC_DECLINED` / `KYC_ACTION_REQUIRED` | transactional | - | Verification decision sync/reconciliation |
| `AML_REVIEW` / `AML_CLEAR` | transactional | - | AML risk change or reviewer resolution |
| `EDIT_INVERGE` | marketing | `issueTitle`, `intro` | Manual editorial send only |
| `IDEA_OF_THE_WEEK` | marketing | `ideaTitle`, `ideaSummary` | Manual editorial send only |
| `EDITORS_PICK` | marketing | `pickTitle`, `pickSummary` | Manual editorial send only |
| `CREATOR_OF_THE_WEEK` | marketing | `creatorName`, `summary` | Manual editorial send only |
| `UPCOMING_COMPETITIONS` | marketing | `intro` | Manual editorial send only |
| `CAMPAIGN_HIGHLIGHTS` | marketing | `intro` | Manual editorial send only |
| `PLATFORM_ANNOUNCEMENT` | marketing | `title`, `summary` | Manual editorial send only |

Optional variables for editorial templates: `items` (`[{title, summary, meta,
url}]`), `ctaUrl`, `ctaLabel`.

### Verification states

- **Email ownership**: `User.emailVerifiedAt`. A provider's
  `email_verified: true` claim can satisfy it at registration; otherwise OTP is
  required. It never implies KYC.
- **Identity/KYC**: `User.kycStatus` / `VerificationCase`.
- **AML**: `User.amlStatus` / `AmlScreening`.

`GET /api/v1/auth/email` reports the ownership state only.

## 3. Endpoints

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/auth/email` | session | Current address, verified state, live challenge |
| `POST` | `/api/v1/auth/email/request` | session | Issue a six-digit code |
| `POST` | `/api/v1/auth/email/verify` | session | Consume a code (single-use) |
| `POST` | `/api/v1/auth/email/resend` | session | Resend within cooldown rules |
| `DELETE` | `/api/v1/auth/email/pending` | session | Abandon a pending change |
| `GET` | `/api/v1/me/email/preferences` | session | Editorial consent + unsubscribe link |
| `PUT` | `/api/v1/me/email/editorial` | session | Explicit opt-in/opt-out (`{ subscribed }`) |
| `GET` | `/api/v1/email/preferences/:token` | token | HTML confirmation page (no state change) |
| `POST` | `/api/v1/email/preferences/:token/unsubscribe` | token | Unsubscribe; also the RFC 8058 one-click target |
| `POST` | `/api/v1/webhooks/resend` | Svix signature | Delivered/bounced/complained/delayed/failed events |
| `GET` | `/api/v1/admin/email/templates` | admin | Template catalogue and required variables |
| `POST` | `/api/v1/admin/email/editorial/preview` | admin | Render, never send |
| `POST` | `/api/v1/admin/email/editorial/send` | admin | Manual send to explicit accounts |

Opt-in is the only way to create `EmailSubscription`. Registration never does.
`PUT /me/email/editorial` refuses an unverified address (`409
EMAIL_NOT_VERIFIED`).

**Frontend follow-up:** the `inverge-web` settings screen does not yet render the
editorial toggle. It must call `GET /me/email/preferences` and
`PUT /me/email/editorial`; the API does not silently subscribe anyone in the
meantime. The unsubscribe page itself is served by this API and works without a
web deployment change.

## 4. Delivery reliability

- **Idempotency**: `EmailDelivery.idempotencyKey` is unique. Notification mail
  uses `notification/<notificationId>`; verification uses
  `email-verification/<challengeId>`; a domain notification uses its event-aware
  `dedupeKey`; editorial uses `editorial:<issueId>:<template>:<userId>`.
- **Claim before send**: a row moves `PENDING → SENDING` with a conditional
  `updateMany`. A second worker cannot send the same row. A `SENDING` row older
  than `EMAIL_DELIVERY_STALE_SECONDS` may be reclaimed after a crash.
- **Bounded retries**: `EMAIL_DELIVERY_MAX_ATTEMPTS` (default 5). The queue's
  exponential backoff applies to notification rows; callers that throw get the
  same bounded ledger.
- **Status is monotonic**: a late `email.delivered` never reopens a bounce or
  complaint; `email.delivery_delayed` never rolls back an accepted send. Transient
  bounces become `DELAYED`; only `bounce.type === "Permanent"` suppresses.
- **Suppression**: `HARD_BOUNCE` and `COMPLAINT` block every category.
  `UNSUBSCRIBED` blocks marketing only; transactional account mail still
  delivers. Re-subscribing clears only `UNSUBSCRIBED`.
- **No message content stored**: the ledger keeps recipient, template id,
  category, status, provider id, attempt count and a bounded error string. It
  never stores subject, HTML, text, provider response bodies or codes.
- **Webhook replay**: Svix timestamp tolerance is 300 seconds and the signed body
  is checked first. `WebhookInboxService` dedupes on `svix-id`, so a provider
  retry cannot apply a status twice.

## 5. Consent and editorial mail

- Transactional and marketing are separate categories on the delivery ledger.
- Marketing requires: verified address, `EmailSubscription.status =
  SUBSCRIBED`, no suppression, an unsubscribe URL and a configured postal
  address. Any miss is recorded as `SUPPRESSED`, not silently dropped.
- `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` are
  sent on marketing mail.
- Editorial sending is manual and off by default
  (`EDITORIAL_EMAILS_ENABLED=false`). **No schedule, cadence, audience builder or
  content selection is configured**, per the brief: those are editorial decisions,
  not defaults this service may invent.
- The confirmation page does not unsubscribe on GET, so a mail scanner
  prefetching the link cannot remove consent.

## 6. Blocked integrations

These are deliberately not wired. Do not present them as live:

| Email | Why it is blocked |
|---|---|
| Contribution confirmed | No contribution write path in this API. `Contribution` is read-only. |
| Funding outcome confirmed | No reconciled on-chain `FUNDED` handler emits a domain event. `CAMPAIGN_FUNDED` exists as a template only. |
| Milestone decision confirmed | No milestone claim/objection decision service. `MILESTONE_REVIEW` is a template only. |
| Refund eligibility / transfer confirmed | `REFUND_CLAIMED` is an `OnChainEventType`; no refund journey or reconciliation emits it. |
| Idea returned for changes | Ideas only move `DRAFT → VALIDATING`; no moderation-return state exists. |
| Campaign declined | The review action set is `APPROVE` / `REQUEST_CHANGES`; "declined" does not exist. `REQUEST_CHANGES` uses its own template. |
| New idea comment | Wired at `CommentsService.post`. Likes are not emailed. |

When one of these flows lands, it must emit a **confirmed** domain event (the
trusted provider callback or reconciled on-chain event), then call
`NotificationsService.notify` with a stable `dedupeKey`. A UI success response is
not an event.

## 7. Environment variables

| Variable | Default | Notes |
|---|---|---|
| `EMAIL_PROVIDER` | `stub` | `stub` or `resend`. Production rejects `stub`. |
| `RESEND_API_KEY` | - | Required with `resend`. Server-only. |
| `EMAIL_FROM` | - | Verified sender address. Required with `resend`. |
| `EMAIL_FROM_NAME` | `Inverge` | Display name. |
| `EMAIL_REPLY_TO` | - | Optional reply address. |
| `EMAIL_CODE_SECRET` | dev pepper | >=32 chars in production. Peppers six-digit codes. |
| `EMAIL_VERIFICATION_CODE_TTL_SECONDS` | `600` | 60-3600. |
| `EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS` | `60` | 1-600. |
| `EMAIL_VERIFICATION_MAX_ATTEMPTS` | `5` | 1-10. |
| `EMAIL_VERIFICATION_MAX_PER_HOUR` | `5` | 1-20. |
| `EMAIL_DELIVERY_TIMEOUT_MS` | `10000` | Provider request timeout. |
| `PUBLIC_APP_URL` | `http://localhost:3000` | Web-app origin in CTAs. Production requires https and rejects localhost. |
| `PUBLIC_API_URL` | `http://localhost:3000` | Unsubscribe endpoint origin. Same production rule. |
| `RESEND_WEBHOOK_SECRET` | - | `whsec_...` Svix secret. Required with `resend` in production. |
| `EMAIL_LOGO_URL` | `${PUBLIC_APP_URL}/brand/inverge-mark.png` | Hosted PNG (128x128 in this repo). |
| `EMAIL_SUPPORT_ADDRESS` | - | Footer contact address. |
| `EMAIL_COMPANY_ADDRESS` | - | Postal address in marketing footers. Required when editorial sending is enabled. |
| `EMAIL_UNSUBSCRIBE_SECRET` | dev pepper | >=32 chars in production. Signs stateless links. |
| `EMAIL_DELIVERY_MAX_ATTEMPTS` | `5` | 1-10. |
| `EMAIL_DELIVERY_STALE_SECONDS` | `300` | Stale `SENDING` reclaim window. |
| `EDITORIAL_EMAILS_ENABLED` | `false` | Manual editorial send switch. |

Boot fails when `EMAIL_PROVIDER=resend` and `RESEND_API_KEY` or `EMAIL_FROM` is
missing; in production it also fails without `RESEND_WEBHOOK_SECRET`, a real
`EMAIL_CODE_SECRET`/`EMAIL_UNSUBSCRIBE_SECRET`, and public https links.

## 8. Provider setup (manual)

1. Create a Resend account and add the sending domain. Publish the DKIM/SPF
   records Resend shows; wait for **Verified**.
2. Create an API key with send permission. Set `RESEND_API_KEY`, `EMAIL_FROM`
   (an address on the verified domain), `EMAIL_FROM_NAME`.
3. Add a webhook destination: `https://<api-host>/api/v1/webhooks/resend`.
   Subscribe to `email.sent`, `email.delivered`, `email.delivery_delayed`,
   `email.bounced`, `email.complained`, `email.failed`.
4. Copy the destination signing secret (`whsec_...`) into
   `RESEND_WEBHOOK_SECRET`.
5. Set `PUBLIC_APP_URL` to the web deployment and `PUBLIC_API_URL` to the API
   deployment. Both must be HTTPS in production.
6. Confirm `https://<web-host>/brand/inverge-mark.png` is reachable. The 128×128
   PNG is versioned at `inverge-web/public/brand/inverge-mark.png`; set
   `EMAIL_LOGO_URL` only if the asset is hosted elsewhere.
7. Set `EMAIL_SUPPORT_ADDRESS` and, before enabling editorial mail,
   `EMAIL_COMPANY_ADDRESS`.
8. Leave `EDITORIAL_EMAILS_ENABLED=false` until the editorial content source,
   selection process, cadence and consent policy are signed off.

## 9. Staging verification

Automated:

```bash
cd inverge-api
node ./node_modules/jest/bin/jest.js src/common/email src/modules/email \
  src/modules/notifications src/modules/auth/email src/config/env.validation.spec.ts \
  --runInBand
node ./node_modules/jest/bin/jest.js --config jest-e2e.config.js \
  test/email-system.e2e-spec.ts --runInBand
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

The e2e suite covers provider-verified registration, separate email capture,
valid/invalid/expired/reused codes, cooldown, consent, unsubscribe, forged
tokens, signed webhook delivery, replay, hard bounce, and out-of-order events.

Manual checklist on staging (stub disabled, real Resend):

1. Register with an account whose provider token has no verified email. Request a
   code; confirm the mail arrives and the footer shows the real logo and support
   address. Enter the code; confirm `GET /auth/me` reports `emailVerified: true`.
2. Repeat the request twice quickly; the second must return `429` with a
   `retryAfterSeconds` detail. Re-enter a consumed code; it must fail.
3. Publish a draft idea; the creator must receive `IDEA_PUBLISHED`. Post a comment
   from a second account; the creator must receive `IDEA_COMMENT`.
4. Submit a campaign; confirm `CAMPAIGN_SUBMITTED`. Approve or request changes in
   the admin queue; confirm the matching email. Publish; confirm
   `CAMPAIGN_PUBLISHED`.
5. Check the Resend dashboard: the send is `Delivered`. Confirm the ledger row
   moved `SENT → DELIVERED` (query `EmailDelivery` by recipient).
6. Force a hard bounce (Resend test address if available). Confirm the row is
   `BOUNCED` and a `HARD_BOUNCE` suppression exists; a later send to that address
   must be recorded as `SUPPRESSED` without a provider call.
7. Subscribe to editorial mail in Settings, unsubscribe from the email link, and
   confirm marketing send is suppressed while a verification code still arrives.
8. Send a test editorial preview from `/admin/email/editorial/preview`; confirm
   the unsubscribe link and postal address are present. Do not enable a schedule.

## 10. Render deployment

`render.yaml`-style environment groups must include the variables in section 7.
Notes specific to Render:

- `PUBLIC_APP_URL` and `PUBLIC_API_URL` are different services; do not point the
  API URL at the web host.
- Render terminates TLS; set `TRUST_PROXY_HOPS=1` (already required for the rate
  limiter).
- The email webhook path is outside the web app: Resend must reach the API
  service directly.
- Apply the `20261102140000_email_delivery` migration before deploying the new
  code (`pnpm prisma:deploy` or `node scripts/migrate-deploy.mjs`).
- If Redis is disabled, notification dispatch runs inline and the delivery ledger
  still records `SENT`/`FAILED`; retries are then only the caller's.
- A missing webhook secret is a boot failure in production by design; it is not
  a warning.
