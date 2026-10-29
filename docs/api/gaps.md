# Feature to API coverage

Status: **living document**. Regenerate the route list from
[`openapi.json`](./openapi.json); do not maintain a second inventory by hand.

Legend: **implemented** = route exists and is exercised by a test;
**partial** = route exists but a documented behaviour is missing or unsafe;
**missing** = no route; **blocked** = deliberately absent until a dependency
exists; **deferred** = planned, not next.

## Identity and access

| Feature | Route | Status | Gap |
|---|---|---|---|
| Provider token → session | `POST /auth/session` | implemented | Returns id/email/role only; no issuer/audience claim; 1 h with no refresh |
| Current user | `GET /auth/me` | implemented | Returns id/email/ownership/role + public creator only; provider ids and KYC facts stay server-side |
| Email status | `GET /auth/email` | implemented | Live challenge projection; no plaintext code |
| Request email code | `POST /auth/email/request` | implemented | Resend delivery to arbitrary recipients is blocked until a domain is verified |
| Verify email code | `POST /auth/email/verify` | implemented | Single-use, hashed, attempt-capped |
| Resend email code | `POST /auth/email/resend` | implemented | Cooldown + hourly cap |
| Cancel pending email | `DELETE /auth/email/pending` | implemented | Supersedes active challenges |
| Username availability | `GET /auth/check-username` | implemented | Public and unthrottled; enumeration is cheap |
| Update profile | `PATCH /auth/me/profile` | implemented | Moderation runs on display name only |
| Public creator | `GET /auth/creators/{idOrUsername}` | implemented | Resolves by id or stored handle; display-name-derived slugs are no longer routable. Published/supported lists capped at 24 |
| Wallet link | `POST /wallets/link` | implemented | — |
| Wallet role | `PATCH /wallets/{id}/role` | implemented | — |
| List wallets | `GET /wallets` | implemented | — |

## Ideas and validation

| Feature | Route | Status | Gap |
|---|---|---|---|
| Browse ideas | `GET /ideas` | implemented | Keyset `(createdAt, id)`; `?mine=false` parses correctly |
| Create idea | `POST /ideas` | implemented | Per-creator cap read per request |
| Read idea | `GET /ideas/{id}` | implemented | — |
| Edit idea | `PATCH /ideas/{id}` | implemented | — |
| Publish | `POST /ideas/{id}/publish` | implemented | — |
| Support / unsupport | `POST` / `DELETE /ideas/{id}/support` | implemented | Recomputes metrics per signal |
| Pre-pledge | `POST` / `DELETE /ideas/{id}/pre-pledge` | implemented | — |
| Survey | `GET` / `PUT /ideas/{id}/survey` | implemented | — |
| Survey responses | `POST` / `DELETE /ideas/{id}/survey/responses` | implemented | — |
| Comments | `GET` / `POST /ideas/{id}/comments` | implemented | Keyset `(highlighted, likeCount, createdAt, id)`; engagement keys are mutable between pages; desire for immutable scrolling needs a recency sort |
| Comment moderation | `DELETE .../comments/{id}`, `PATCH .../highlight` | implemented | — |
| Comment likes | `POST` / `DELETE .../comments/{id}/like` | implemented | — |
| Creator insights | `GET /ideas/{id}/insights` | implemented | No cache; computed per request |
| Quality coaching | `GET /ideas/{id}/quality` | implemented | — |
| Convert idea to campaign | `POST /ideas/{id}/convert` | implemented | Web does not call it yet |
| Boosts | `GET` / `POST /ideas/{id}/boosts` | implemented | — |

## Discovery

| Feature | Route | Status | Gap |
|---|---|---|---|
| Feed | `GET /feed` | partial | Fixed candidate pool, no cursor; parameters come from one snapshot |
| Campaign catalogue | `GET /campaigns` | implemented | Keyset cursor; `most-delivered` removed until a released-claim counter exists |
| Campaign detail | `GET /campaigns/{id}` | implemented | Resolves by campaign id or the source idea's public slug. Anonymous reads are limited to `ACTIVE`/`FUNDED`/`FAILED`/`COMPLETED`; a draft, in-review or rejected campaign is 404 to everyone but its creator. Deep includes on a card-shaped read |
| Search | — | missing | No endpoint; `search_performed` analytics would precede it |
| Topics / categories | `GET /taxonomy` | partial | Canonical 15/154 taxonomy, assignments and browse filters are implemented; editorial topics and web wiring are missing |

## Campaigns and escrow

| Feature | Route | Status | Gap |
|---|---|---|---|
| Create campaign | `POST /campaigns`, `PATCH /campaigns/{id}` | implemented | Persistent draft with optimistic concurrency; see [campaign-deployment.md](../campaign-deployment.md) |
| Deployment | `POST /campaigns/{id}/deployment/prepare`, `…/submit`, `…/reconcile`, `GET …/deployment` | implemented against programme source | Verification needs a deployed binary/IDL and a devnet run before mainnet |
| Publish | `POST /campaigns/{id}/publish` | implemented | Requires review approval + verified deployment + fee |
| Submit for review | `POST /campaigns/{id}/submit` | implemented | Requires KYC + fee; correct |
| Own campaigns | `GET /campaigns?mine=true` | implemented | - |
| Admin review queue | `GET /admin/campaigns` | implemented | — |
| Admin review detail | `GET /admin/campaigns/{id}` | implemented | — |
| Admin decision | `POST /admin/campaigns/{id}/review` | implemented | — |
| Escrow projection | `GET /platform/escrow` | partial | Platform-wide grouped aggregate over all on-chain events, cached 60 s; the duplicate `/campaigns/escrow/stats` alias is removed. The `OnChainEvent(campaignId, eventType, blockTime)` index serves per-campaign reads, not this aggregate |
| Contributions | — | blocked | No Anchor program, no indexer, no route |
| Milestones / tranches | — | blocked | Same |
| Refunds | — | blocked | Program-owned |
| Transparency ledger | — | missing | Depends on the indexer |

## Trust, safety and money

| Feature | Route | Status | Gap |
|---|---|---|---|
| KYC session | `POST /kyc/session` | implemented | — |
| KYC status | `GET /kyc/status` | implemented | — |
| KYC eligibility | `GET /kyc/eligibility` | implemented | Gate call-sites are incomplete |
| KYC webhook | `POST /kyc/webhook` | implemented | Durable `WebhookReceipt` replay guard; production webhook registration is outstanding |
| KYB | `POST /kyb/session`, `GET /kyb/status` | implemented | — |
| AML screening | `POST /kyc/admin/aml-screen`, `GET /kyc/admin/aml/{userId}` | implemented | Ongoing monitoring is not automated |
| Business AML | `POST /kyb/admin/aml-screen`, `GET /kyb/admin/aml/{userId}` | implemented | — |
| Application fee webhook | `POST /flat-fee/webhook` | implemented | Durable `WebhookReceipt` replay guard; payment behaviour unchanged |
| Moderation harness | `POST /admin/moderation/screen` | implemented | — |
| Platform parameters | `GET` / `PATCH /admin/params` | implemented | Reads share a 5 s process snapshot; a write invalidates it |
| Parameter audit | `GET /admin/params/audit` | implemented | — |
| Boost prices | `GET` / `PATCH /admin/boost-prices` | implemented | — |
| Users | `GET /admin/users` | partial | Offset/take only; no role filter |
| Role change | `PATCH /admin/users/{id}/role` | implemented | Role change + audit row commit together; read with `GET /admin/params/audit?key=auth.user.role` |

## Platform

| Feature | Route | Status | Gap |
|---|---|---|---|
| Health / readiness | `GET /health/live`, `GET /health/ready` | implemented | Outside the version prefix; Redis down reports `degraded`, Postgres down fails readiness |
| Public platform summary | `GET /platform/summary` | implemented | Counts only (published ideas, active/completed/total public campaigns); cached 60 s; no escrow or funding figure |
| Account capabilities | `GET /auth/capabilities` | implemented | UI projection of role, verification and onboarding; not cached; see plan §19 |
| Interests | `PUT /me/interests` | implemented | — |
| Product analytics | `/internal/analytics/events`, `/ideas/{id}/analytics/*`, `/campaigns/{id}/analytics/*`, `/analytics/access*`, `/admin/analytics/*` | implemented (Phase 1) | Signed server-to-server ingest for views/steps/search; `IDEA_SIGNAL` and `FEEDBACK_SUBMITTED` after commit; owner basic + request-gated premium reads; nightly roll-up and retention run when `QUEUE_ENABLED=true`. No public browser ingest, device/region/referrer, follow/save/vote or challenge metrics. See [analytics.md](./analytics.md) and [product-analytics.md](./product-analytics.md) |
| Notification list / read | `GET /me/notifications`, `GET .../unread-count`, `PATCH .../{id}/read`, `POST .../read-all` | implemented | Delivery is best-effort past the adapter call; no user preferences or admin replay |
| Outbound webhooks | — | deferred | No subscription product |
| Real-time stream | — | deferred | Decision recorded in [realtime.md](./realtime.md) |

## Duplicate and dead surfaces

- `GET /campaigns/escrow/stats` was removed; `GET /platform/escrow` is the only
  escrow projection. It now adds `asOf`.
- Banned accounts are excluded from the feed and metrics but authenticated write
  routes do not reject them. `accountActive` is therefore advisory for the UI until a
  guard enforces it.
- The boost purchase path has no KYC/AML gate. `submitCampaigns` reflects the gate
  that does exist; `purchaseBoosts` reflects current behaviour, not an endorsement.
- Public marketing surfaces in `inverge-web` consume `/platform/summary`, `/ideas`,
  `/ideas/{id}`, `/ideas/{id}/comments`, `/campaigns`, `/campaigns/{idOrSlug}` and
  `/taxonomy`. `/auth/session`, `/auth/me`, `/auth/check-username` and
  `/auth/me/profile` are consumed by the product shell. Treat every other route as
  contract-first, not as proof of UI integration.

## Known contract gaps

- **Response schemas are thin outside auth.** Only `POST /auth/session`, `GET /auth/me`,
  `GET /auth/check-username` and the creator projection declare a response DTO. Other handlers return
  service objects with no declared type, so the spec lists the status but not the shape. The error
  envelope is the exception: every operation declares it as a `default` response (see
  [errors.md](./errors.md)).
- **Request bodies are typed** for routes that use DTOs (ideas, campaigns, survey, admin), because the
  DTOs already carried `@ApiProperty` decorators.

## How to keep this honest

Every row marked `implemented` must have a test file that names the route. When a
route is added, it appears in `openapi.json` (enforced by `openapi:check`) and gets
a row here. When a row becomes `implemented`, link the test in the pull request.
