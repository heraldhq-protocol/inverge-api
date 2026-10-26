# Analytics API and frontend contract

Status: **implemented for Phase 1**. Collection, aggregation and reads are
separate. There is no public browser ingest route and no visitor-level data in any
response.

See [product-analytics.md](./product-analytics.md) for the pipeline and
[analytics-privacy.md](./analytics-privacy.md) for what may be collected.

## Surfaces

| Surface | Route | Entitlement |
|---|---|---|
| Signed ingest | `POST /api/v1/internal/analytics/events` | HMAC service secret |
| Idea summary | `GET /api/v1/ideas/{id}/analytics/summary` | Owner or admin (basic) |
| Idea series | `GET /api/v1/ideas/{id}/analytics/timeseries` | Owner or admin (basic) |
| Idea validation | `GET /api/v1/ideas/{id}/analytics/validation` | Owner or admin (basic counts; conversion rates are premium) |
| Idea acquisition | `GET /api/v1/ideas/{id}/analytics/acquisition` | Owner or admin + premium |
| Idea geography | `GET /api/v1/ideas/{id}/analytics/geography` | Owner or admin + premium |
| Campaign summary | `GET /api/v1/campaigns/{id}/analytics/summary` | Owner or admin (basic) |
| Campaign funnel | `GET /api/v1/campaigns/{id}/analytics/funnel` | Owner or admin + premium |
| Platform overview | `GET /api/v1/admin/analytics/overview` | Admin |
| Own access | `GET /api/v1/analytics/access` | Authenticated |
| Request access | `POST /api/v1/analytics/access-requests` | Authenticated |
| Admin request list | `GET /api/v1/admin/analytics/access-requests` | Admin |
| Admin decision | `PATCH /api/v1/admin/analytics/access-requests/{id}` | Admin |

`ANALYTICS_READ_ENABLED=false` makes every read route a `404`, including the
access routes. Ingestion has its own switch.

An idea may be addressed by id or slug. A campaign has no slug.

## Ingestion contract

```http
POST /api/v1/internal/analytics/events
Content-Type: application/json
x-inverge-timestamp: 1792500000
x-inverge-signature: <hex hmac>

{"events":[{"eventKey":"view-01J...","name":"idea_viewed","occurredAt":"2026-10-25T12:00:00.000Z","sessionId":"s-01J...","ideaId":"idea_01J...","source":"feed","countryCode":"NG"}]}
```

The signature is `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`, lowercase hex.
`sha256=` is accepted as a prefix. The timestamp is Unix seconds and must be
within `ANALYTICS_INGEST_CLOCK_SKEW_SECONDS` (default 300). The raw body is signed,
not a re-serialised object.

Limits: 50 events and `ANALYTICS_INGEST_MAX_BODY_BYTES` (default 64 KB) per
request. The route returns `202` with:

```json
{
  "received": 2,
  "accepted": 1,
  "persisted": 1,
  "duplicates": 0,
  "queued": false,
  "rejected": [{ "index": 1, "reason": "confirmed events are emitted by the domain, not ingested" }]
}
```

`persisted` is `0` when the batch was queued. `duplicates` counts keys skipped by
the unique constraint on an inline write. A rejected event never fails the batch.
A persistence outage returns `503 ANALYTICS_INGEST_UNAVAILABLE`; the caller should
retry the same keys, not generate new ones.

### Accepted names and fields

| Name | Required | Optional |
|---|---|---|
| `page_viewed` | `resourceType: "PAGE"`, `resourceId` = closed page key | `source`, `countryCode` |
| `idea_viewed` | `ideaId` | `source`, `position`, `countryCode` |
| `campaign_viewed` | `campaignId` | `source`, `position`, `countryCode` |
| `campaign_step_started` | `campaignId`, `step` | `countryCode` |
| `campaign_step_completed` | `campaignId`, `step`, `durationMs` | `countryCode` |
| `search_performed` | `queryLength`, `resultCount` | `filterKeys` (max 20), `countryCode` |

Every event requires `eventKey` and `occurredAt`. It carries either `userId` or
`sessionId`, never both. Page keys are `home`, `ideas`, `idea-detail`,
`campaigns`, `campaign-detail`, `creator-dashboard`, `settings`, `notifications`
and `auth` - never a URL.

`idea_supported`, `idea_upvoted`, `idea_followed`, `idea_saved`,
`feedback_submitted`, `prepledge_created`, `competition_entry_started`,
`competition_entry_submitted`, `competition_vote_cast`, `campaign_backing_started`,
`campaign_backing_completed` and `share_clicked` are rejected on this route. They
are emitted by the domain after the business row commits.

## Read contract

### Range

`from` and `to` are inclusive UTC calendar days (`YYYY-MM-DD`). Defaults: the last
30 days ending today. Maximum: 366 days. `to` may not be in the future. `interval`
is `day` (default), `week` (Monday start) or `month`.

Invalid input returns `400 INVALID_ANALYTICS_RANGE`. Buckets always include empty
days/weeks/months so a chart can render zeroes.

### Unique sessions

`uniqueSessions` is the distinct count of `COALESCE(userId, sessionId)` over raw
events when the whole range is inside raw retention (90 days by default). Older
ranges fall back to the sum of daily unique counts and set
`uniqueSessionsExact: false`. A bucket-level `uniqueSessions` is always a sum of
daily uniques; `timeseries.uniqueSessionsIsSum` makes that explicit.

### Idea summary

```json
{
  "ideaId": "idea_01J...",
  "from": "2026-09-26",
  "to": "2026-10-25",
  "totals": { "views": 120, "uniqueSessions": 74, "uniqueSessionsExact": true },
  "validation": {
    "supporters": 18,
    "prePledges": 4,
    "feedbackCount": 9,
    "feedbackScore": 4.2,
    "commentCount": 6,
    "estimatedInterestUsd": "1250",
    "follows": null,
    "saves": null
  },
  "lastAggregatedDay": "2026-10-24",
  "generatedAt": "2026-10-25T12:00:00.000Z"
}
```

`estimatedInterestUsd` is weighted intent, never received funds. `follows` and
`saves` are `null` because the models do not exist. `prePledges` is the current
total, not a range-bound count.

### Idea validation

`counts` is the same object. `conversion` is `null` for a basic entitlement; for
premium it carries `viewToSupportPct`, `viewToFeedbackPct` and
`viewToCommentPct`. A zero denominator returns `null`, not `0`.

### Acquisition and geography

`acquisition.sources` is one row per source in `feed`, `search`, `direct`,
`internal`, with `views`, `uniqueSessions` and `sharePct`. `geography.countries`
is capped at 50 rows and sets `truncated`. Both are premium-only and include
`premium: true`.

### Campaign

Summary returns `totals`, `funnel` (`stepStarted`, `stepCompleted`,
`contributionStarted`), and `confirmedBacking`. Funnel adds
`stepCompletionPct` (`null` for a zero denominator) and `backingStarted`.

`confirmedBacking` reads the indexer-owned `Contribution` table:

```json
{ "count": 3, "amountUsd": "750", "source": "contribution_indexer" }
```

It is a current total, not a range sum, and is never inferred from an analytics
event or a click. It is labelled so a reader cannot confuse it with estimated
interest.

### Admin overview

Returns `totals` across all resources, a `resources` array grouped by
`IDEA`/`CAMPAIGN`/`PAGE`, and `lastAggregatedDay`. Admin entitlement is
`NOT_REQUIRED`.

### Caching

Premium reports and the admin overview are cached for 60 seconds by
`CacheService` with keys scoped by resource and range. Basic owner reads are
uncached. Caching is skipped when Redis is disabled. A cached response never
crosses a resource boundary or an entitlement tier.

## Premium access

Collection is free; premium **reports** are request-gated. Basic summary,
timeseries and validation counts are available to the owner without a grant.

`GET /api/v1/analytics/access` returns:

```json
{
  "feature": "analytics.premium",
  "premium": false,
  "requestStatus": "NONE",
  "canRequest": true,
  "source": null,
  "requestedAt": null,
  "decidedAt": null,
  "expiresAt": null,
  "creatorTier": "STARTER"
}
```

`requestStatus` is `NONE`, `PENDING`, `APPROVED`, `REJECTED`, `EXPIRED` or
`NOT_REQUIRED` (admin). `canRequest` is false while pending or approved.
`POST /api/v1/analytics/access-requests` is idempotent: a pending or active
approval is returned unchanged; a rejected or expired grant becomes pending
again.

`GET /api/v1/auth/capabilities` mirrors the same entitlement and adds
`available`. It is `false` when `ANALYTICS_READ_ENABLED=false`; the grant is
still recorded, but the UI must hide the surface instead of offering a report
that would return `404`.

Admins list with `GET /api/v1/admin/analytics/access-requests?status=PENDING&limit=24`
(cursor-paginated, `requestedAt DESC, id DESC`, default 24, max 50) and decide with
`PATCH .../{id}`:

```json
{ "status": "APPROVED", "expiresAt": "2027-01-01T00:00:00.000Z" }
```

`expiresAt` is optional; omitting it grants access without expiry. A past
`expiresAt` is rejected. An admin may change a decision in any direction, which
also supports later revocation.

`CreatorTier` is returned for context only. It does **not** grant premium access.
`STARTER`, `TRUSTED` and `ESTABLISHED` are creator-quality tiers, not billing
plans.

### Future paid wall

`AnalyticsAccessService.grantPaidAccess(userId, paidThrough, externalReference)`
writes an `APPROVED` grant with `source: "PAID"` and an expiry. A future billing
integration calls this entry point; no price, plan or payment provider is invented
here. The read routes already enforce the same grant, so enabling a paid tier is
an additive change.

## Errors

| Status | Code | When |
|---|---|---|
| `400` | `INVALID_ANALYTICS_RANGE` | Bad dates, inverted range, future `to`, over 366 days, unknown interval |
| `400` | validation envelope | Malformed batch shape or more than 50 events |
| `401` | `UNAUTHENTICATED` | No session, or no signed ingest body |
| `401` | `STALE_ANALYTICS_SIGNATURE` | Timestamp outside the skew |
| `401` | `INVALID_ANALYTICS_SIGNATURE` | HMAC mismatch |
| `403` | `ANALYTICS_ENTITLEMENT_REQUIRED` | Premium report without a grant; details carry `requestStatus` and `canRequest` |
| `404` | `NOT_FOUND` | Missing resource, non-owner, or reads disabled |
| `413` | `ANALYTICS_BATCH_TOO_LARGE` | Ingest body over the configured cap |
| `429` | `RATE_LIMITED` | Policy exceeded |
| `503` | `ANALYTICS_INGEST_UNAVAILABLE` | Ingest disabled without a secret, or persistence failed |

## Rate limits

| Policy | Limit | Scope | Failure |
|---|---|---|---|
| `analytics_ingest` | 600/min, burst 120 | hashed IP | fail open |
| `analytics_read` | 60/min, burst 20 | user | fail open |
| `analytics_premium` | 30/min, burst 10 | user | fail open |
| `analytics_request` | 5/hour, burst 2 | user | fail open |
| `analytics_admin` | 60/min, burst 10 | user | fail closed |

## Frontend contract

Phase 1 has **no browser analytics client**. The Next.js server calls the signed
ingest route after rendering, using `after()` or an equivalent non-blocking hook.
The secret stays on the server. A failed call is logged and dropped; it never
blocks the page or a product action.

### Event mapping

| Product moment | Wire event | Notes |
|---|---|---|
| Public page render | `page_viewed` | `pageKey` from the closed list; no URL |
| Idea detail render | `idea_viewed` | Include `ideaId`; `source` is where the visitor came from |
| Campaign detail render | `campaign_viewed` | Include `campaignId` |
| Creator wizard step shown | `campaign_step_started` | `step` is a lowercase slug |
| Creator wizard step completed | `campaign_step_completed` | Include `durationMs` |
| Search submitted | `search_performed` | Lengths and filter keys only; never the query text |
| Support / pre-pledge | none from the client | The API emits `IDEA_SIGNAL` after commit |
| Feedback | none from the client | The API emits `FEEDBACK_SUBMITTED` after commit |
| Backing | none from the client | Deferred until the contribution flow exists |

A click that starts an action is not a completed action. The client must not
synthesize `idea_supported`, `feedback_submitted`, `campaign_backing_completed` or
any other confirmed name.

### Identity

Authenticated events use the internal `userId` resolved by the web server. Anonymous
events use a first-party, session-scoped random `sessionId`; Phase 1 does not join
it to an account later. There is no consent banner because Phase 1 adds no
non-essential tracking. Phase 2 (device, region, referrer, returning visitors,
bot filtering) requires an explicit privacy-policy amendment and NDPA review
before any code ships.

### Dedupe, batching and retry

- Generate `eventKey` once per logical event. Reuse it on every retry.
- Batch up to 50 events per request. Do not split one logical event across keys.
- Retry `503` and network failures with the same keys and exponential backoff;
  do not retry `400`, `401`, `403` or `413`.
- Treat `202` as accepted even when `rejected` is non-empty; log the reasons.
- Never let analytics block rendering, navigation, support, feedback or payment.

### Dashboard states

Every analytics panel must handle four states explicitly:

- **loading**: skeleton with no fabricated numbers;
- **empty**: zero views is a valid result, not an error;
- **unavailable**: `404` (reads disabled), `503`, or a timeout shows "Analytics is
  temporarily unavailable" with a retry;
- **error/entitlement**: `403 ANALYTICS_ENTITLEMENT_REQUIRED` shows the request
  CTA, using `requestStatus` and `canRequest`; pending and rejected states have
  distinct copy.

Never render a zero for an unavailable report. Never infer a rate from a null
conversion; display "not enough data".

## OpenAPI and tests

The routes and DTOs are in `docs/api/openapi.json`. Analytics coverage:

- 92 unit cases across 12 suites;
- 22 Phase 1 e2e cases against real Postgres, including the measured operation
  budgets in `docs/api/query-performance.md`;
- 4 existing domain-signal e2e cases.

## Remaining gaps

- The live creator dashboard: `/d/creator/analytics` reads the premium
  entitlement and submits access requests, but the idea workspace is still
  preview data.
- Phase 2 privacy work: consent record, device/browser/OS, region, referrer/UTM,
  returning visitors, bot filtering, deletion path.
- Follow/save/vote models and contribution start/confirm events.
- Challenge/ideathon/leaderboard analytics; the domain does not exist yet.
