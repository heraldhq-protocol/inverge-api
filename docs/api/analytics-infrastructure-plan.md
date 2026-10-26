# Analytics infrastructure: audit and implementation plan

Status: **Phase 1 implemented**. This document keeps the original audit, the
decision log and the phased plan. Section 1 describes the state *before* the
Phase 1 slice; the implementation is recorded in
[analytics.md](./analytics.md) and [product-analytics.md](./product-analytics.md).
Phase 2 and the challenge domain remain proposals and must not be treated as
shipped.

This document answers the analytics brief against the code that existed at audit
time. It separates what was implemented, what was declared but not emitted, what
is blocked on a missing domain, and what requires a privacy-policy decision. The
contract in [analytics-privacy.md](./analytics-privacy.md) is authoritative until
the product owner changes it.

## 1. Current state

### 1.1 What exists

| Capability | Where | State |
|---|---|---|
| Raw product events | `ProductAnalyticsEvent`, `src/modules/analytics/product-analytics-event.ts` | Implemented, closed taxonomy of 8 names |
| Writer | `ProductAnalyticsService.record()` | Implemented, server-side only, after domain commit, drop-on-failure |
| Signal roll-up | `IdeaSignalDailyMetric`, `AnalyticsAggregationService` | Implemented, idempotent per `(ideaId, day)` |
| Retention | `AnalyticsRetentionService` | Implemented, raw 90 days by `receivedAt`, aggregates 25 whole months |
| Maintenance queue | `AnalyticsProcessor`, `AnalyticsScheduler` | Implemented, `analytics-maintenance` at 04:15 UTC, only when `QUEUE_ENABLED=true` |
| Creator insights | `GET /api/v1/ideas/:id/insights`, `InsightsService` | Implemented from domain metrics, owner-only, no cache, not product analytics |
| Redis cache | `CacheService`, versioned keys, single-flight | Implemented |
| Rate limiting | `RateLimitService`, token bucket, local fallback | Implemented |
| Queue | BullMQ, optional registration | Implemented |
| Telemetry | `/metrics`, request metrics | Implemented |
| Advertising events | `AdvertisementEvent`, `docs/api/advertising.md` | Separate bounded context, no sink today |

Only `IDEA_SIGNAL` is emitted today, from `IdeasService.support` and
`IdeasService.prePledge` after the domain commit. The other seven names are
declared but not emitted:

- `IDEA_VIEWED`, `CAMPAIGN_VIEWED`: need a web server integration.
- `CAMPAIGN_STEP_STARTED`, `CAMPAIGN_STEP_COMPLETED`: no creator-flow caller.
- `CONTRIBUTION_STARTED`, `CONTRIBUTION_CONFIRMED`: no contribution initiation or
  confirmation path; escrow and the indexer do not exist in either repository.
- `SEARCH_PERFORMED`: no server-side search caller; recording cached API reads
  would measure cache traffic, not search intent.

### 1.2 What does not exist

- No HTTP ingestion route for product analytics.
- No event idempotency key, schema version, generic resource type or resource id.
- No batching, no ingestion queue, no bulk insert.
- No reach, acquisition, geographic, device, validation, campaign-funnel or
  competition aggregate.
- No creator or admin analytics read route for product analytics.
- No consent record, no analytics deletion path, no visitor identifier.
- No backend premium-analytics entitlement. The web has a server-only stub,
  `getAiInsightsEntitlement()`, which returns `not_configured`.
- No `Competition`, `Ideathon`, `Leaderboard`, `Vote`, `Entry` or `Standing`
  model. `docs/idea-community-loop-plan.md` is a draft plan with no code.
- No follow or save model. `SignalType` is only `SUPPORT` and `PRE_PLEDGE`.
- No contribution initiation or confirmation endpoint. `Contribution` is a table
  and an indexer projection, not a live write path.

### 1.3 Documentation drift at audit time

At audit time `docs/api/analytics-privacy.md` said "target. No analytics pipeline
exists" while `docs/api/product-analytics.md` said the server-side pipeline was
implemented. The status lines have since been corrected. The privacy rules remain
the contract; Phase 2 is still target.

## 2. Gap matrix against the brief

| Brief requirement | Today | Gap | Blocking decision |
|---|---|---|---|
| Versioned event schema | No version field | Add `schemaVersion` and a wire-to-internal name map | None |
| Unique event id / idempotency | `id` is generated at insert | Add caller-supplied `eventKey` with a unique constraint | None |
| Generic resource type/id | `ideaId`, `campaignId` only | Add `resourceType` and `resourceId` for page and future challenge events | None |
| Anonymous visitor id / session | `sessionId` exists, mutually exclusive with `userId` | No first-party visitor id, no consent, no new/returning classification | Privacy |
| Referrer / acquisition source | `source` accepts `feed`, `search`, `direct` | No social, external, internal, campaign or UTM categories | Privacy |
| Device / browser / OS | Forbidden by the privacy contract | Coarse device, browser and OS families | Privacy |
| Country / coarse region | `countryCode` column exists, no wiring | Trusted edge header wiring; no region | Privacy for region |
| Allowlisted event properties | Closed per-event allowlist | Extend the allowlist with the new taxonomy | None |
| Page and share events | None | `PAGE_VIEWED`, `SHARE_CLICKED` | Public ingest or server-side share route |
| Competition / ideathon / leaderboard | No domain | Cannot emit or aggregate | Domain |
| Idea validation report | Domain tables exist | No analytics read model or conversion rates | None |
| Campaign funnel | Events declared, not emitted | No contribution path; confirmed backing must come from `Contribution` | Escrow/indexer |
| Batch ingestion | One insert per event | Ingestion queue, bulk insert, dedupe, backpressure | None |
| Asynchronous aggregation | Signal roll-up only | Reach, acquisition and funnel aggregates | None |
| Idempotent processing | Signal roll-up is idempotent | Ingest and all new aggregates must be idempotent | None |
| Failed-job tracking | BullMQ failed set, worker error log | Counters and a run record without payloads | None |
| Dashboard reads | Creator insights only | Bounded, cached analytics routes | None |
| Premium entitlement | Web stub only | Server-owned entitlement interface | Product |
| Consent and deletion | No consent, no analytics deletion | Consent record and deletion path | Privacy/legal |
| Bot filtering | None | Transient bot classification before insert | Privacy |
| Tests | 24 analytics unit cases, e2e signal path | Ingest, dedupe, read, entitlement, cache, failure isolation | None |

## 3. Hard conflicts that block implementation

These are not engineering preferences. Each changes the product's privacy
contract or adds a domain that does not exist.

1. **Public browser ingestion.** The brief asks for batch event ingestion from
   the frontend. `analytics-privacy.md` says: "There is no public ingest endpoint
   for product analytics. Writing is server-side only." A public route cannot be
   added without changing that rule.
2. **Device, browser and OS.** The brief asks for device category, browser family
   and operating system. The privacy contract says: "User agents or device
   fingerprints" are never collected. Deriving a coarse device category from a
   user agent is still user-agent processing and needs an explicit policy change.
3. **Region and city.** The brief asks for country and optional coarse region or
   city. The contract says country only, "never a city or coordinates."
4. **Referrer and UTM.** The brief asks for referrer category and UTM parameters.
   The contract forbids "arbitrary full referrer URLs containing query strings."
   A closed referrer category may be compatible; UTM retention is not yet
   approved.
5. **Consent.** The brief asks for consent requirements and a consent-aware
   pipeline. The contract says analytics is first-party and aggregate, so there
   is no consent banner today. Non-essential tracking requires explicit opt-in
   and a contract update first.
6. **Competition, ideathon and leaderboard analytics.** The brief asks for
   competition page views, entries, votes, judging and participation. None of
   those models exist. The community-loop plan is a draft. The planned challenge
   model has weighted support standings, not votes. Do not invent a vote model
   for analytics.
7. **Premium analytics.** The brief asks for premium reports and entitlements.
   There is no billing or plan service. `CreatorTier` is a creator-quality tier,
   not a paid analytics plan. Do not repurpose it silently.
8. **Migrations and OpenAPI.** The API working tree contains uncommitted
   campaign-deployment schema, routes and `docs/api/openapi.json` changes. Adding
   analytics migrations or regenerating the spec in the same tree would mix two
   changes and break the drift check. Work must happen in a clean worktree or
   after that work is committed.

## 4. Recommended phasing

### Phase 0: decisions and documentation

- Product owner resolves the Phase 1 decisions (D1-D4, D6, D10-D13) in section
  15. D5 and D7-D9 gate later phases or are recorded as deferred.
- Correct the stale status line in `analytics-privacy.md` only after the decision.
- Record the accepted architecture in a decision record.

### Phase 1: server-side MVP, no privacy expansion (recommended now)

This is the largest slice that respects the current contract.

- Add an event idempotency key, schema version, generic resource type/id and a
  closed source set to `ProductAnalyticsEvent`.
- Add a service-to-service ingestion route, not a public route. The web server
  calls it after rendering a page. The browser never calls the API for analytics.
- Use the existing session-scoped anonymous id for unique-session counting. Do
  not call it a unique visitor; Phase 1 cannot measure a returning visitor
  across sessions.
- Accept a country code only from a trusted CDN header. Never derive it from an
  IP in the application. Store no IP, user agent, device, referrer URL or UTM.
- Batch through a new `analytics-ingest` BullMQ queue with an inline fallback
  when the queue is disabled or unreachable. A failure never fails the page or
  the product action.
- Aggregate reach and acquisition per resource per UTC day. Keep validation
  metrics in the existing domain tables; do not duplicate them.
- Add owner/admin read routes for reach, acquisition, validation and campaign
  funnel summaries. No public analytics in idea or campaign responses.
- Add a server-owned entitlement interface with a basic default and a premium
  flag that is false until a billing or grant system exists.
- Tests, docs, OpenAPI and a clean migration.

Phase 1 does **not** deliver new/returning visitors, sessions per visitor,
engagement time, device or browser breakdowns, region, UTM, competition metrics
or premium reports. Those are honest gaps, not hidden approximations.

### Phase 2: consent-based audience measurement (requires approval)

Only after D1-D5 are approved and the privacy notice and NDPA review are done:

- Public batch ingestion with a consent gate.
- A first-party pseudonymous visitor id, separate from the account id, with
  expiry and deletion rules.
- Coarse device, browser and OS families derived at the edge. The raw user agent
  is discarded and never stored.
- Country and coarse region from the edge. No city, no coordinates, no IP.
- Referrer category and allowlisted UTM fields. No full referrer URL, no query
  string, no free text.
- New versus returning visitors, sessions per visitor and engaged-session rate
  where the client can measure it reliably.
- Bot filtering, consent records, deletion and retention enforcement.

### Phase 3: competition and ideathon analytics (requires domain)

Only after the community-loop plan is approved and its models exist. The event
names can be reserved now, but no table, route or aggregate should be created
against a domain that does not exist. The planned challenge model has no vote;
"votes cast" must be redefined or dropped before it becomes a metric.

### Phase 4: premium reports (requires billing or grants)

Add report entitlements and historical comparisons only when a server-owned
plan, grant or billing source exists. Basic analytics stay available on every
plan, matching the web stub's stated intent.

## 5. Event taxonomy

The stored enum keeps the existing `SCREAMING_SNAKE_CASE` values. The public wire
contract uses `snake_case` and maps 1:1 in one adapter. This avoids a data
migration and keeps the frontend contract conventional.

| Wire name | Internal name | State | Trigger | Attempt or confirmed | Properties |
|---|---|---|---|---|---|
| `page_viewed` | `PAGE_VIEWED` | Proposed Phase 1 | Web server after render | Attempt | `pageKey`, optional `resourceType`, `resourceId`, `source` |
| `idea_viewed` | `IDEA_VIEWED` | Declared, not emitted | Web server after render | Attempt | `ideaId`, `source`, `position` |
| `competition_viewed` | `CHALLENGE_VIEWED` | Blocked | Challenge detail render | Attempt | `challengeId`, `source` |
| `leaderboard_viewed` | `STANDINGS_VIEWED` | Blocked | Standings render | Attempt | `challengeId` |
| `idea_supported` | `IDEA_SIGNAL` + `signalType=SUPPORT` | Emitted | `IdeasService.support` after commit | Confirmed | `ideaId` |
| `idea_upvoted` | `IDEA_SIGNAL` + `signalType=SUPPORT` | Decision D8 | Same as support unless a separate domain action is added | Confirmed | `ideaId` |
| `idea_followed` | None | Blocked | No follow model | - | - |
| `idea_saved` | None | Blocked | No save model | - | - |
| `feedback_submitted` | `FEEDBACK_SUBMITTED` | Proposed Phase 1 | `SurveyResponse` after commit | Confirmed | `ideaId`, optional `surveyResponseId` |
| `prepledge_created` | `IDEA_SIGNAL` + `signalType=PRE_PLEDGE` | Emitted | `IdeasService.prePledge` after commit | Confirmed | `ideaId` |
| `competition_entry_started` | `CHALLENGE_ENTRY_STARTED` | Blocked | Entry form opened, persisted intent | Attempt | `challengeId`, `ideaId` |
| `competition_entry_submitted` | `CHALLENGE_ENTRY_SUBMITTED` | Blocked | `ChallengeEntry` persisted | Confirmed | `challengeId`, `ideaId` |
| `competition_vote_cast` | `CHALLENGE_VOTE_CAST` | Blocked | No vote model | - | - |
| `share_clicked` | `SHARE_CLICKED` | Proposed Phase 2 | Share action or share redirect | Attempt | `resourceType`, `resourceId`, `channel` |
| `campaign_viewed` | `CAMPAIGN_VIEWED` | Declared, not emitted | Web server after render | Attempt | `campaignId`, `source`, `position` |
| `campaign_backing_started` | `CONTRIBUTION_STARTED` | Declared, not emitted | Persisted backing intent | Attempt | `campaignId` |
| `campaign_backing_completed` | `CONTRIBUTION_CONFIRMED` | Declared, not emitted | Contribution confirmed by the authoritative path | Confirmed | `campaignId`, optional `contributionId` |
| `search_performed` | `SEARCH_PERFORMED` | Declared, not emitted | Server-side search after the query | Attempt | `queryLength`, `resultCount`, `filterKeys` |

Rules:

- A click is never a confirmed support, vote, entry or payment. Confirmed events
  are emitted only after the domain row is committed.
- `IDEA_SIGNAL` remains one event with a `signalType`; do not add a duplicate
  `IDEA_SUPPORTED` event.
- `IDEA_UPVOTED` is the current support action unless the product adds a distinct
  upvote. Do not create two signals for one button.
- `IDEA_FOLLOWED` and `IDEA_SAVED` stay out of the taxonomy until the domain
  models exist. Analytics must not invent a feature.
- `CONTRIBUTION_CONFIRMED` must read from `Contribution` or the indexer, never
  from a frontend click. The event carries `contributionId` for correlation; the
  amount is read from `Contribution`, not aggregated from analytics. A
  pre-pledge is never a confirmed contribution.
- `FEEDBACK_SUBMITTED` carries the survey response id for correlation. The
  average rating is computed from `SurveyResponse.answers` by the existing
  feedback logic, not copied into a second analytics field.
- `PAGE_VIEWED` uses a closed `pageKey`, not a free-text path or query string.
  This prevents search terms, wallet addresses and other user input from entering
  analytics through the URL.

## 6. Data model

### 6.1 Phase 1 additive changes

```prisma
enum AnalyticsResourceType {
  IDEA
  CAMPAIGN
  PAGE
}

model ProductAnalyticsEvent {
  // existing fields stay; `source` remains a String with a closed validator,
  // so existing `feed`/`search`/`direct` rows do not need a type migration.
  eventKey      String                  @unique
  schemaVersion Int                     @default(1)
  resourceType  AnalyticsResourceType?
  resourceId    String?

  @@index([resourceType, resourceId, name, occurredAt])
  @@index([resourceType, resourceId, source, occurredAt])
  @@index([eventKey])
}

// Daily reach. `uniqueSessions` is honest: Phase 1 has no cross-session visitor.
model ResourceReachDailyMetric {
  id             String                @id @default(cuid())
  resourceType   AnalyticsResourceType
  resourceId     String
  day            DateTime              @db.Date
  views          Int                   @default(0)
  uniqueSessions Int                   @default(0)
  createdAt      DateTime              @default(now())
  updatedAt      DateTime              @updatedAt

  @@unique([resourceType, resourceId, day])
  @@index([day])
}

model ResourceAcquisitionDailyMetric {
  id             String                @id @default(cuid())
  resourceType   AnalyticsResourceType
  resourceId     String
  day            DateTime              @db.Date
  source         String
  views          Int                   @default(0)
  uniqueSessions Int                   @default(0)

  @@unique([resourceType, resourceId, day, source])
  @@index([day])
}

model CampaignFunnelDailyMetric {
  id                  String   @id @default(cuid())
  campaignId          String
  day                 DateTime @db.Date
  views               Int      @default(0)
  uniqueSessions      Int      @default(0)
  stepStarted         Int      @default(0)
  stepCompleted       Int      @default(0)
  contributionStarted Int      @default(0)

  @@unique([campaignId, day])
  @@index([day])
}
```

Notes on the Phase 1 model:

- `ideaId` and `campaignId` stay as denormalized pointers for the existing signal
  path and indexes. New events set both the typed pointer where one exists and
  the generic `resourceType`/`resourceId` pair. The generic pair is the extension
  point for pages and future challenges. Do not add a third pointer.
- For `PAGE` events, `resourceId` carries a closed page key such as `home`,
  `ideas`, `idea_detail` or `campaign_detail`. There is no free-text path or
  query-string column.
- `eventKey` is nullable only during the backfill migration. Existing rows get
  `eventKey = id`, then the column becomes required and uniquely indexed. New
  callers supply a UUID; a retry reuses it.
- Existing rows are backfilled with `resourceType = IDEA` and
  `resourceId = ideaId`, or `CAMPAIGN` and `resourceId = campaignId`, where the
  typed pointer is present.
- `uniqueSessions` in `ResourceAcquisitionDailyMetric` is per source. One session
  can contribute to more than one source, so the source rows can sum to more than
  the resource's total unique sessions. Document that in the report rather than
  forcing the numbers to reconcile.
- `CampaignFunnelDailyMetric` deliberately has no `contributionConfirmed`
  column. Confirmed backing is a domain fact and is read from `Contribution`.
  Storing it twice would create two sources of truth.

Do not add an `IdeaValidationDailyMetric`. Support, pre-pledge, feedback, rating
and comments already have domain tables. The validation report joins
`IdeaSignalDailyMetric`, `IdeaSignal`, `SurveyResponse`, `IdeaComment` and
`IdeaMetricSnapshot`. Duplicating them in analytics would create two sources of
truth.

Do not add a `Competition` or `Standing` analytics table. That domain does not
exist. Add its aggregates with the domain, not before it.

### 6.2 Phase 2 fields, only after approval

```prisma
model AnalyticsConsent {
  id         String    @id @default(cuid())
  subjectKey String    // hashed visitor id or internal user id
  purpose    String    // product_analytics
  version    String
  grantedAt  DateTime?
  revokedAt  DateTime?
  expiresAt  DateTime?
  createdAt  DateTime  @default(now())

  @@unique([subjectKey, purpose, version])
  @@index([expiresAt])
}

// Proposed, not approved. No IP, no user agent, no raw device string.
model AnalyticsVisitor {
  id            String    @id @default(cuid())
  visitorKeyHash String   @unique
  firstSeenAt   DateTime
  lastSeenAt    DateTime
  consentId     String?
  expiresAt     DateTime
}
```

Phase 2 event fields would be coarse enums only:
`deviceCategory`, `browserFamily`, `osFamily`, `regionCode`, `acquisitionSource`,
`utmSource`, `utmMedium`, `utmCampaign`, `consentVersion`. No raw user agent, no
IP, no referrer URL, no city, no coordinates, no free text.

### 6.3 Index and volume notes

- Every aggregate is keyed by UTC `day`. Display time zones are a client concern.
- `ResourceReachDailyMetric` and `ResourceAcquisitionDailyMetric` are bounded by
  resource count and days, not by visitors.
- Distinct sessions are computed from raw events for a bounded day. If daily
  volume makes that query expensive, add a `(resource, day, session)` visitor-day
  table with a unique key and count rows. Do not add it before the measurement
  shows a need.
- Do not partition yet. Evaluate partitioning or a separate analytics database
  when raw events exceed roughly 50 million rows per month or the dashboard p95
  exceeds 500 ms after indexing. Record the measurement before changing the
  storage model.

## 7. Ingestion and processing

### 7.1 Phase 1 service-to-service path

```
Next.js server render
  -> after() / non-blocking call
  -> POST /api/v1/internal/analytics/events
  -> service-token guard
  -> batch validation
  -> analytics-ingest queue (BullMQ)
  -> createMany({ skipDuplicates: true })
```

- The browser never calls the API for analytics. There is no public ingest route.
- The web server sends a batch of at most 50 events and at most 64 KB.
- The service token is a dedicated HMAC secret with a timestamp and body hash,
  not a user session token. It is rotated independently and rejected when the
  timestamp is outside five minutes.
- If the queue is disabled or Redis is unreachable, the route writes inline. If
  that also fails, it returns `202` with `persisted: false` and increments a
  failure counter. The page render is never blocked.
- Idempotency is the unique `eventKey`. A retry is a no-op. Redis may keep a
  short-lived `SETNX` key to avoid a database round-trip, but Postgres remains the
  durable dedupe record.
- Event-key rules:
  - Domain-confirmed events use the domain row id:
    `IDEA_SIGNAL:<signalId>`, `FEEDBACK_SUBMITTED:<surveyResponseId>` and
    `CONTRIBUTION_CONFIRMED:<contributionId>`.
  - A page view uses a random UUID generated once for that render. A retry of the
    same request reuses it; a new page view gets a new key.
  - An attempted action uses a random UUID generated when the persisted intent is
    created. A click without a persisted intent is not a confirmed event.
  - Never derive a key from free text, a raw URL or a query string.
- Bot filtering is not part of Phase 1 because the caller is the trusted web
  server. Phase 2 adds transient bot classification before insert.
- The session id is a pseudonymous counting key, never an authentication or
  authorization credential. A public ingest request must not be able to attach
  events to a resource the caller cannot see; Phase 2 resolves the resource's
  public visibility before accepting the event. A private or draft resource
  rejects the event rather than inflating a hidden counter.

### 7.2 Queue

- New queue `analytics-ingest`, registered only when `QUEUE_ENABLED=true`.
- Job attempts: 3, exponential backoff, `removeOnComplete: 1000`,
  `removeOnFail: 5000`.
- One `error` listener per queue and one `@OnWorkerEvent('error')` per worker, as
  the existing queue code requires.
- A failed job is logged without event values. Counters track accepted,
  duplicated, rejected and failed.
- Do not use Redis as the only record of an event. The database insert is the
  durable step.

### 7.3 Rate limits

Add policies to `RATE_LIMIT_POLICIES` and the path resolver:

| Policy | Scope | Limit | Burst | Fail closed | Applies to |
|---|---|---|---|---|---|
| `analytics_ingest_service` | `ip` | 600/min | 120 | false | Phase 1 internal ingest |
| `analytics_ingest_anon` | `ip` | 60/min | 20 | false | Phase 2 public ingest |
| `analytics_ingest_user` | `user` | 300/min | 60 | false | Phase 2 authenticated ingest |
| `analytics_dashboard` | `user` | 60/min | 20 | false | Summary and timeseries reads |
| `analytics_report` | `user` | 10/min | 3 | true | Expensive reports and exports |
| `analytics_admin` | `user` | 60/min | 10 | true | Admin platform reads |

The existing limiter supports `ip` and `user` scopes only. Do not add a third
scope for the service route; the web server's IP is sufficient and the HMAC guard
is the authentication boundary.

The existing limiter hashes the identifier before it becomes a Redis key. Never
store a raw IP. A rate-limited response is `429` with `Retry-After`, consistent
with the existing error envelope.

### 7.4 Aggregation

- Extend the nightly `analytics-maintenance` job at 04:15 UTC.
- Rebuild yesterday plus a rolling seven-day window so late-arriving events are
  corrected. Each upsert replaces the day's counts, never increments them.
- Reach: `views` is the count of view events; `uniqueSessions` is the distinct
  `sessionId` count for that resource and day.
- Acquisition: group by the closed source set. Phase 1 has no referrer or UTM.
- Campaign funnel: views, unique sessions, step started, step completed and
  backing started. Confirmed backing is read from `Contribution`, not from an
  analytics event.
- Idempotency is per aggregate key. A rerun produces the same row.
- The job writes a bounded run summary (day, rows, duration, failure count) to
  logs and metrics. Do not store event payloads in the run record.

## 8. Metric definitions

### 8.1 Reach

- Total views: count of view events for the resource and range.
- Unique views: views with a session id, deduplicated per session per day.
- Unique visitors: **not available in Phase 1**. Report `uniqueSessions` and
  label it as sessions in the API and dashboard. Phase 2 adds a consented
  visitor id.
- Views by resource: one summary per resource.
- Daily, weekly and monthly trends: UTC buckets. Weekly starts Monday. Monthly is
  the calendar month.
- New and returning visitors, sessions per visitor, average engagement time and
  engaged-session rate: Phase 2. Do not infer them from session ids.

### 8.2 Acquisition

- Phase 1 sources: `feed`, `search`, `direct`, `internal`.
- Phase 2 adds `social`, `external`, `campaign` and allowlisted UTM fields.
- No full referrer URL, query string or free text is stored.
- Direct includes a missing or unrecognised source. Do not guess.

### 8.3 Geographic and device

- Phase 1: country only, from a trusted edge header, validated as ISO 3166-1
  alpha-2. If the header is absent, store null. Never derive country from an IP
  in the application.
- Phase 2: coarse region and coarse device, browser and OS families, if approved.
  No city, coordinates, raw user agent or IP.

### 8.4 Idea validation

Use the domain tables, not a parallel analytics source:

- Supporters: distinct `IdeaSignal` rows with `type=SUPPORT`.
- Upvotes: the current support action unless D8 adds a separate upvote.
- Feedback submissions: `SurveyResponse` count for the idea.
- Average rating: mean of `RATING` answers, using the existing feedback logic.
- Follows and saves: blocked until the domain models exist.
- Weighted pre-pledges and estimated funding interest: the existing
  `MetricsService` weighting. Show it as estimated interest, never as funds.
- Discussion engagement: `IdeaComment` and `CommentLike` counts.
- View-to-support, view-to-feedback and view-to-follow: numerator from the domain
  table, denominator from reach. A zero denominator returns `null`, not `0`.
- Confirmed funding: `Contribution` and escrow only. Never add pre-pledges to
  confirmed funds.

### 8.5 Competition and ideathon

Blocked on the domain. When the challenge model exists:

- Page views and unique sessions from reach.
- Entries started and submitted from `ChallengeEntry` transitions.
- Completion rate from submitted divided by started, with a null zero
  denominator.
- Votes cast only if the domain adds a vote. The planned challenge ranks by
  weighted support, not votes.
- Judging activity and score distributions from `ChallengeJudgeScore`.
- Participation by country, device and source from the approved Phase 2
  dimensions.
- Sponsor challenge engagement only as aggregate counts. No sponsor access to
  visitor-level data.

### 8.6 Campaign

- Views and unique sessions from reach.
- Step started and completed from the creator-flow events.
- Backing started from a persisted backing intent, not a button click.
- Backing completed from `Contribution` or the indexer. The analytics event is a
  funnel marker, not the financial source of truth.

## 9. API design

All routes are under `/api/v1`, use the existing error envelope and include a
`default` `ErrorResponse` in OpenAPI.

### 9.1 Phase 1 ingestion

`POST /api/v1/internal/analytics/events`

- Auth: service HMAC guard, not a user bearer token.
- Body: `{ events: AnalyticsEvent[] }`, maximum 50 events, 64 KB.
- Response: `202 { accepted, duplicates, rejected, persisted }`.
- No public route. No event payload is echoed.
- Validation: closed names, schema version, event key format, timestamps within
  90 days and five minutes of clock skew, resource type allowlist, source set,
  country code format, max lengths, no unknown fields.

### 9.2 Phase 1 reads

| Method | Path | Access | Purpose |
|---|---|---|---|
| `GET` | `/ideas/:id/analytics/summary` | Owner or admin | Reach totals and validation headline |
| `GET` | `/ideas/:id/analytics/timeseries` | Owner or admin | Daily, weekly or monthly views and unique sessions |
| `GET` | `/ideas/:id/analytics/acquisition` | Owner or admin | Source breakdown, top N plus `other` |
| `GET` | `/ideas/:id/analytics/validation` | Owner or admin | Supporters, feedback, rating, comments, conversion rates |
| `GET` | `/campaigns/:id/analytics/summary` | Owner or admin | Reach and funnel headline |
| `GET` | `/campaigns/:id/analytics/funnel` | Owner or admin | Step and backing-started funnel |
| `GET` | `/admin/analytics/overview` | Admin | Platform totals and stale-aggregate status |

Extend the existing `GET /api/v1/auth/capabilities` with an `analytics` object
rather than adding a second capability route. That keeps one capability source
for the web.

Do not remove or duplicate `GET /api/v1/ideas/:id/insights`. It remains the
validation and quality report. The new routes are audience reports. If the
product prefers one endpoint, extend `insights` with an additive `audience`
object instead of creating two owner checks in the web.

A non-owner gets `404`, matching the existing unpublished-idea rule, so ids
cannot be probed. An admin gets `200`. No route returns visitor-level rows.

### 9.3 Query parameters

- `from`, `to`: ISO dates, inclusive, UTC. Default: last 30 days. Maximum: 366
  days. `from` must be on or before `to`; a future `to` is clamped to today.
- `interval`: `day`, `week` or `month`. Default `day`.
- `limit`: top-N breakdown size, default 10, maximum 50.
- `tz`: not accepted in Phase 1. The API returns UTC and the client formats.

### 9.4 Response shape

```json
{
  "data": {
    "resource": { "type": "IDEA", "id": "idea_123" },
    "range": { "from": "2026-09-25", "to": "2026-10-24", "interval": "day" },
    "totals": { "views": 1200, "uniqueSessions": 430 },
    "series": [
      { "bucket": "2026-10-01", "views": 42, "uniqueSessions": 31 }
    ]
  },
  "meta": {
    "generatedAt": "2026-10-25T12:00:00.000Z",
    "asOf": "2026-10-24T04:15:00.000Z",
    "approximate": true,
    "approximateReasons": ["unique_sessions_not_visitors"],
    "cache": "miss"
  }
}
```

- `approximate` is always true in Phase 1 because unique sessions are not unique
  visitors and no consent measurement exists.
- `asOf` is the last successful aggregate run. If the nightly job failed, serve
  the last known aggregate with `meta.stale: true` and a reason. Do not return a
  fabricated zero.
- Zero-fill empty buckets so charts do not mislead. State that in the docs.

### 9.5 Errors

- `400 INVALID_DATE_RANGE`
- `400 INVALID_INTERVAL`
- `403 ANALYTICS_ENTITLEMENT_REQUIRED`
- `404 NOT_FOUND` for a missing or non-owned resource
- `413 PAYLOAD_TOO_LARGE` for an oversize batch
- `422 INVALID_ANALYTICS_EVENT` with an index, not the payload
- `429 RATE_LIMITED` with `Retry-After`
- `503 ANALYTICS_INGEST_UNAVAILABLE` only when the service chooses to fail the
  ingest call; the web server must ignore it

### 9.6 Caching

- Keys: `analytics:v1:<report>:<resourceType>:<id>:<from>:<to>:<interval>`.
- TTL: 60 seconds for summaries and breakdowns; 300 seconds for platform
  overview.
- Cache only after the authorization check. Never cache a response for a
  non-owner.
- Invalidate by `bumpEventually('analytics:<resourceType>:<id>')` after an
  aggregate rebuild. TTL handles normal freshness.
- Premium fields use a separate key or are gated before serialization. Do not
  serve a premium payload from a basic cache entry.
- The cache never holds visitor-level rows, because those rows are never exposed.

## 10. Privacy, consent and retention

### 10.1 Phase 1

- No IP address, raw or hashed, in analytics tables, queues or logs.
- No user agent, device fingerprint or raw device string.
- No referrer URL, query string or UTM.
- No free text, email, wallet, provider subject or KYC data.
- Country only from a trusted edge header. No city, coordinates or IP
  geolocation in the application.
- Anonymous events use a session-scoped random id. It expires with the session
  and is never joined to a user later. Authenticated events use the internal
  user id only.
- No consent banner, because Phase 1 is first-party, aggregate and
  session-scoped, matching the current contract.
- Raw events: 90 days by `receivedAt`. Aggregates: 25 whole months.
- Account deletion removes raw events for that user id. Anonymous session rows
  cannot be linked to the account by design and expire on the raw retention
  schedule. Aggregates remain aggregate and non-identifying.
- No creator or sponsor can see visitor-level history. No public route returns
  analytics.

### 10.2 Phase 2, only after approval

- Explicit opt-in for non-essential measurement, with a consent record and a
  versioned privacy notice.
- A first-party pseudonymous visitor id, separate from the account id, with an
  expiry and a deletion path.
- Coarse device, browser, OS and region derived at the edge. The raw user agent
  and IP are discarded immediately after classification.
- Referrer category and allowlisted UTM fields. No full URL, no query string.
- Bot filtering before insert. Do not store the bot signal.
- New/returning and engagement metrics only where consent and measurement make
  them reliable.
- Document the approximations caused by consent refusal, blocked scripts,
  cleared storage and cross-device use.

### 10.3 Legal review

The brief itself requires a review of Nigerian and international privacy
requirements with the project owner before enabling non-essential tracking. That
review is a gate for Phase 2, not a task for engineering to assume. The NDPA
lawful basis, consent wording, retention for consent records and the deletion
procedure need an owner decision.

## 11. Premium analytics access

Implemented as D14.

- `AnalyticsAccessGrant` is keyed by `(userId, feature="analytics.premium")`.
  `status` is `PENDING`, `APPROVED` or `REJECTED`; `source` is `REQUEST`, `ADMIN`
  or `PAID`; `requestedAt`, `decidedAt`, `decidedBy`, `expiresAt` and
  `externalReference` are recorded.
- `GET /api/v1/analytics/access` exposes `premium`, `requestStatus`, `canRequest`,
  `source` and the timestamps. `POST /api/v1/analytics/access-requests` is
  idempotent. Admins list and decide through `/api/v1/admin/analytics/access-requests`.
- The owner gets basic summary, timeseries and validation counts without a grant.
  Acquisition, geography and campaign-funnel reports require `premium`.
  Non-owners get `404`. Admin is `NOT_REQUIRED`.
- `CreatorTier` (`STARTER`, `TRUSTED`, `ESTABLISHED`) is creator-quality context,
  not a plan. It is returned in the access response but never grants premium.
- Enforce on the server for every report. Hiding a frontend card is not
  enforcement.
- The future paid wall calls
  `AnalyticsAccessService.grantPaidAccess(userId, paidThrough, externalReference)`,
  which writes `APPROVED`/`PAID` with `expiresAt`. No price, plan or billing
  provider is invented now; the read routes already enforce the grant.
- Replace the web `getAiInsightsEntitlement()` stub only after the web is wired to
  the API capability. Keep the existing copy that basic analytics are available on
  every plan.
- Premium report candidates: historical trends beyond the basic window,
  returning-visitor rate, device and region breakdowns, acquisition performance,
  funnels and comparisons across a creator's own resources. The last two are
  implemented; the privacy-dependent ones remain Phase 2.

## 12. Frontend integration contract

### 12.1 Phase 1

- The Next.js server records a view after rendering, using `after()` or an
  equivalent non-blocking hook. It never blocks the page.
- The web server holds the analytics service secret. The browser does not.
- The web server reads a first-party, HttpOnly, session-scoped random id from a
  cookie and forwards it to the API. The cookie has no `Max-Age` or `Expires`, so
  it ends with the browser session. It is not a cross-site identifier and is
  never joined to an account later. If the product rejects a first-party session
  cookie, Phase 1 can report total views but not unique sessions; that is D13.
- The event includes that session id, a closed `pageKey`, the resource type and
  id, and a source from the closed source set. It does not include a path or a
  query string.
- A failed analytics call is ignored. It must not break discovery, idea detail,
  campaign pages, support, pre-pledge, comments or backing.
- No client-side analytics script, no third-party pixel, no cookie banner in
  Phase 1.
- The dashboard reads the API with the user's session and renders loading, empty,
  stale and error states. It never calls a visitor-level endpoint.

### 12.2 Phase 2

- A consent gate runs before any non-essential event. Refusal disables the
  client queue and leaves the product fully usable.
- Batch at most 20 events or 5 seconds, whichever comes first. Use
  `navigator.sendBeacon` on page hide and `fetch` with `keepalive` as a fallback.
- Retry with exponential backoff and reuse the event key. A duplicate is a no-op.
- No PII, no free text, no raw URL, no IP, no user agent, no fingerprint.
- Event table: name, when it fires, required and optional properties, anonymous
  versus authenticated, consent requirement and dedupe rule.
- Dashboard query parameters: `from`, `to`, `interval`, `limit`. UTC responses,
  client-side display time zone. No WebSockets or SSE; refresh on demand or at a
  reasonable interval.

## 13. Tests and acceptance criteria

### 13.1 Unit

- Event schema: every allowed name, every rejected field, max lengths, timestamp
  bounds, resource type, source set, country code, user/session exclusivity,
  consent version in Phase 2.
- Idempotency: duplicate `eventKey` is a no-op; a retry does not inflate counts.
- Batch validation: max events, max body, per-event rejection index, no payload
  echo.
- Date ranges: inclusive bounds, UTC day boundaries, week and month buckets,
  invalid and reversed ranges, future clamp.
- Aggregation: idempotent upserts, distinct sessions, zero denominators, stale
  aggregate handling.
- Acquisition: closed source mapping, direct fallback, no free text.
- Privacy: no IP, user agent, referrer URL or free text can be persisted; country
  only from the trusted header.
- Entitlement: owner basic, admin all, non-owner 404, premium false by default.
- Cache: key isolation by resource and range, no cross-resource hit, premium and
  basic separation.
- Retention: raw and aggregate cutoffs.
- Failure isolation: a failed analytics write does not fail support, pre-pledge,
  feedback or a page render.

### 13.2 E2E

- Phase 1 internal ingest rejects a missing or stale service token.
- There is no public ingest route.
- A duplicate batch is idempotent.
- Owner reads their summary; another user gets 404; admin gets 200.
- Date range validation and zero-fill.
- Cache hit and invalidation after a manual aggregate rebuild.
- Queue disabled: inline fallback still persists or returns `persisted: false`
  without failing the caller.
- Real Redis rate limit across two app instances, opt-in with `REDIS_E2E=true`.
- OpenAPI contains every new route and the shared `ErrorResponse`.

### 13.3 Performance

- Seed a realistic event volume for one day and run the aggregation and a
  dashboard read. Inspect Prisma's actual queries, not a literal-SQL plan.
- Record p50 and p95 for the summary and timeseries routes with cache off and on.
- Do not claim capacity from a single-process saturated run. State the
  concurrency and the measurement method.
- If distinct-session counting is the bottleneck, add the visitor-day table or a
  parameterized `COUNT(DISTINCT ...)` query with evidence, not a guess.

## 14. Migration, rollout and operations

### 14.1 Migration order

1. Add nullable `eventKey`, `schemaVersion` with default `1`, and nullable
   `resourceType`/`resourceId`.
2. Backfill `eventKey = id`, and `resourceType`/`resourceId` from `ideaId` or
   `campaignId` where present.
3. Make `eventKey` required and add the unique index.
4. Add the resource/source indexes.
5. Create the three aggregate tables.
6. Deploy the API with ingest and read flags off.
7. Turn on ingest for the web server, then turn on reads for owners and admins.

No historical view data is backfilled. Aggregates start empty and the dashboard
shows an honest empty state. Existing signal events keep working.

### 14.2 Rollback

- Turn the ingest and read flags off first.
- Revert the API and web deployment.
- Drop the aggregate tables and the new columns only after the code no longer
  writes them. Dropping analytics data is acceptable; it is not a product source
  of truth.
- Do not drop or rewrite `IdeaSignal`, `SurveyResponse`, `IdeaComment`,
  `Contribution` or any other domain table. They are not analytics-owned.

### 14.3 Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANALYTICS_INGEST_ENABLED` | `false` | Enable the service-to-service ingest route |
| `ANALYTICS_READ_ENABLED` | `false` | Enable creator and admin analytics reads |
| `ANALYTICS_INGEST_SECRET` | none | HMAC secret for the web server; required when ingest is enabled |
| `ANALYTICS_INGEST_CLOCK_SKEW_SECONDS` | `300` | Replay window for the HMAC timestamp |
| `ANALYTICS_RAW_RETENTION_DAYS` | `90` | Existing raw-event retention |
| `ANALYTICS_AGGREGATE_RETENTION_MONTHS` | `25` | Existing aggregate retention |

`QUEUE_ENABLED` and `REDIS_ENABLED` keep their existing meaning. With
`QUEUE_ENABLED=false`, ingest writes inline. With `REDIS_ENABLED=false`, the
limiter uses its bounded local bucket and the cache is bypassed. Neither mode may
fail a page render.

### 14.4 Operations

- The nightly job runs at 04:15 UTC in the API process when queues are enabled.
  There is no separate worker process today. Document that adding one is an
  operational choice, not a requirement for Phase 1.
- A failed job stays in BullMQ's failed set with attempts and backoff. An operator
  can inspect the job metadata and retry it. Event values are not logged.
- Rejected events are counted by reason (unknown name, bad timestamp, bad
  resource, oversize batch). Do not store the rejected payload.
- `/metrics` exposes accepted, duplicated, rejected, failed and aggregate-run
  counters. Do not put resource ids or event keys in metric labels; that would
  create unbounded cardinality.
- A stale aggregate is served with `meta.stale` and `asOf`. It is not replaced
  with zeroes.

### 14.5 Compatibility

- The new routes are additive. No existing response shape changes.
- `GET /ideas/:id/insights` remains as it is.
- The web analytics preview remains fixture-only until the API contract is
  merged. There is no generated client in the web repository; OpenAPI is the
  contract and the web uses server-side fetch.
- The new enum type and new nullable columns are backward compatible for readers.
  The only required new write field is `eventKey`, and the writer supplies it.

## 15. Decisions

### 15.1 Decisions taken on 2026-10-25

- **D1:** Phase 1 is server-side only. No public browser ingestion. Phase 2
  public ingestion requires a privacy-contract amendment and NDPA review.
- **D2:** No device, browser or OS collection in Phase 1. Phase 2 coarse
  families only, with the raw user agent discarded.
- **D3:** Country only in Phase 1, supplied by the trusted web server as a
  two-letter code. The API reads no forwarding header and stores no address. No
  region or city.
- **D4:** No referrer or UTM in Phase 1. Phase 2 closed category and allowlisted
  UTM only.
- **D5:** No consent banner in Phase 1. Phase 2 explicit opt-in with a consent
  record.
- **D6 (superseded by D14):** Premium reports were originally gated by
  `CreatorTier`: `STARTER` basic, `TRUSTED` and `ESTABLISHED` premium, admin all.
  This is no longer the implementation. `CreatorTier` is a creator-quality tier,
  not an entitlement.
- **D7:** Build the challenge domain and its analytics together. This is a
  separate workstream after Phase 1 analytics. It must resolve the open
  decisions in `docs/idea-community-loop-plan.md` first. The planned model has
  weighted support standings, not votes.
- **D8:** No follows, saves or separate upvote in Phase 1. Support is the current
  upvote. Follow and save need domain models first.
- **D9:** Confirmed backing comes from `Contribution` or the indexer only. It is
  deferred until escrow exists and is never inferred from a click.
- **D10:** Implement Phase 1 in a clean worktree from `a4ee069`. Do not mix it
  with the uncommitted campaign-deployment schema or OpenAPI drift.
- **D11:** The internal ingest route uses a dedicated HMAC secret with a
  timestamp and body hash, rotated independently.
- **D12:** API-first. Keep the web analytics preview on fixtures until the
  contract is stable. No public analytics.
- **D13:** Use a first-party, HttpOnly, session-scoped cookie with no `Max-Age`
  for the anonymous session id. If the product rejects it, Phase 1 reports total
  views but not unique sessions.
- **D14:** Premium reports are request-gated by an `AnalyticsAccessGrant` keyed
  by `(userId, feature="analytics.premium")`. A user submits a request; an admin
  approves or rejects it. Basic summary, timeseries and validation counts stay
  free. Admin is `NOT_REQUIRED`. `CreatorTier` is context only. A future paid wall
  writes an `APPROVED`/`PAID` grant with `expiresAt` through
  `AnalyticsAccessService.grantPaidAccess`; no price, plan or billing provider is
  invented now.

### 15.2 Decision log

| ID | Question | Decision | Blocks |
|---|---|---|---|
| D1 | Public browser ingestion now? | No. Phase 1 is service-to-service only; Phase 2 after consent and NDPA review. | Public ingest, page and share events from the browser |
| D2 | Collect device, browser and OS? | No in Phase 1. Phase 2 coarse families only, raw user agent discarded. | Device breakdowns |
| D3 | Coarse region or city? | Country only in Phase 1, supplied by the trusted web server. The API reads no forwarding header. Phase 2 region only after approval; never city. | Geographic breakdowns |
| D4 | Referrer and UTM? | Phase 2 closed category and allowlisted UTM only; no full URL or query string. | Acquisition detail |
| D5 | Consent model? | Phase 2 explicit opt-in with a consent record; no banner in Phase 1. | Public tracking |
| D6 | Premium entitlement source? | Superseded by D14. `CreatorTier` is not an entitlement. | Premium reports |
| D7 | Competition, ideathon and leaderboard analytics? | Build the challenge domain and its analytics together, after Phase 1. Resolve the community-loop open decisions first. The planned model has no vote. | Competition metrics |
| D8 | Follows, saves and a separate upvote? | Do not invent. Support is the current upvote. Follow and save need domain models first. | Validation report completeness |
| D9 | Confirmed backing source? | `Contribution` or the indexer only. Defer until escrow exists. Never infer from a click. | Campaign funnel completion |
| D10 | Migration and OpenAPI coordination? | Clean worktree from `a4ee069`. Do not mix with the uncommitted campaign-deployment work. | All schema and contract changes |
| D11 | Service-to-service auth? | Dedicated HMAC secret with timestamp and body hash, rotated independently. | Phase 1 ingest |
| D12 | Dashboard surface? | API-first. Keep the web analytics preview on fixtures until the contract is stable. No public analytics. | Frontend integration |
| D13 | Session id transport? | First-party, HttpOnly, session-scoped cookie with no `Max-Age`. If rejected, Phase 1 reports total views but not unique sessions. | Unique-session reporting |
| D14 | Premium access model? | Request-gated `AnalyticsAccessGrant` (`PENDING`/`APPROVED`/`REJECTED`, source `REQUEST`/`ADMIN`/`PAID`). Basic reports free; admin `NOT_REQUIRED`; future paid wall adds `PAID` + `expiresAt` through `grantPaidAccess`. No invented pricing. | Premium reports, future billing |

## 16. First implementation slice after approval

If D1-D4, D6, D10, D11 and D13 are approved as recommended, the first slice is:

1. Additive migration for `eventKey`, `schemaVersion`, `resourceType`,
   `resourceId` and the three aggregate tables. The existing `source` field keeps
   its closed validator and gains no duplicate column.
2. Event-name adapter and batch validation, including the closed wire-to-internal
   map.
3. Service HMAC guard and `POST /api/v1/internal/analytics/events`.
4. `analytics-ingest` queue with inline fallback and idempotent bulk insert.
5. Reach and acquisition aggregation in the nightly job, with a rolling
   seven-day rebuild.
6. Owner/admin summary, timeseries, acquisition and validation routes, cached and
   bounded. The validation route reports support, feedback, rating and comments.
   Follows and saves stay absent until D8 adds the domain models.
7. `AnalyticsAccessService` with request-gated premium access (D14). Basic
   reports are free; admin is `NOT_REQUIRED`; `CreatorTier` is context only.
8. Unit, e2e, real-Redis rate-limit and performance evidence.
9. OpenAPI, API docs, gap tracker and operational notes.
10. A separate web PR for the server-side view call, after the API contract is
    merged. No browser ingest.

This slice gives a live, honest MVP: views, unique sessions, sources, validation
conversion and campaign reach. It does not pretend to measure returning visitors,
devices, regions or competitions before the privacy and domain decisions are
made.

## 17. Challenge domain workstream

D7 says to build the challenge domain and its analytics together. This is not
part of the Phase 1 slice above. It is the next workstream, sequenced after the
Phase 1 event and read foundation so challenge events reuse one ingest, aggregate
and entitlement layer instead of growing a second analytics stack.

The source plan is `docs/idea-community-loop-plan.md`. It is a draft owned by the
product owner. Do not overwrite it. Resolve its open decisions before writing the
challenge schema.

### 17.1 Open decisions that block the challenge domain

| Decision | Proposed default | Why it blocks |
|---|---|---|
| `LINK_ONLY` ideas in public standings | An idea can be entered by its creator, but a public standings row requires `DISCOVERABLE`. A `LINK_ONLY` entry is visible only to its creator and admins. | Publishing a standings row would turn a link-only idea into a discoverable surface. |
| Anti-gaming personal data | Start with account-level signals only: account age, rate limits, support burst patterns and duplicate-account checks. Do not store IP, user agent or device hashes unless a separate fraud-purpose privacy decision approves them. | The draft plan proposes salted IP/device hashes, which conflicts with the analytics privacy contract. Fraud prevention is a separate purpose and needs its own approval. |
| Minimum account age | Exclude below-minimum accounts from challenge scoring, not from viewing or entering. Show a neutral eligibility message. | The idea metric floor must not silently change the challenge rule. |
| `pastFunder` factor | Leave unwired. `VERIFIED` means KYC only, not past funding. | Wiring it without a definition would mislabel supporters. |
| Judge model | Per-challenge `ChallengeJudge` assignment with a `JudgeGuard`. Do not add a global `JUDGE` role. | A global role would let a judge score every challenge. |
| Standings storage | Materialised `ChallengeStanding` refreshed by a job. Redis is a cache, never the ranking source. | Standings must survive a cache flush and be reproducible from domain rows. |
| Sponsor entity | Standalone `Sponsor` with no KYB at launch. Record the sponsor contact and terms off-platform. | KYB is a later compliance programme, not a reason to block the domain. |
| Auth for judges and participants | The session JWT path is live: `AuthService.authenticate` returns `sessionToken` and guards verify it. Reuse it. | The draft plan's "provider token vs session JWT" note is stale. Verify again before the first judge write. |
| Requirement numbering | Adopt the draft's FR-704..FR-729 and NFR-20..NFR-25, or renumber in one docs change. | Two numbering schemes would make the gap tracker ambiguous. |
| Web surface | API-first. Keep the preview on fixtures until the challenge contract is stable. | A fixture UI can hide missing authorization and empty-state behaviour. |
| "Votes cast" | The planned challenge has weighted support, not votes. Report support signals and unique supporters. Rename the brief's vote metric or add a vote model only if the product wants one. | A vote metric without a vote model would be fabricated. |
| Prizes and payouts | Off-platform. No escrow, no payout route, no prize ledger in this workstream. | Escrow is a separate programme with its own compliance surface. |
| Sponsor self-serve, public API | Document only. Do not build in the first challenge phase. | It needs sponsor KYB, API keys and rate limits. |

### 17.2 Challenge event names

Use the domain term `challenge` internally and keep the brief's
`competition`/`leaderboard` names as documented aliases for the public contract.

| Wire name | Internal name | Trigger | Confirmed? |
|---|---|---|---|
| `challenge_viewed` (alias `competition_viewed`) | `CHALLENGE_VIEWED` | Challenge detail render | No |
| `standings_viewed` (alias `leaderboard_viewed`) | `STANDINGS_VIEWED` | Standings render | No |
| `challenge_entry_started` (alias `competition_entry_started`) | `CHALLENGE_ENTRY_STARTED` | Persisted entry intent | No |
| `challenge_entry_submitted` (alias `competition_entry_submitted`) | `CHALLENGE_ENTRY_SUBMITTED` | `ChallengeEntry` committed | Yes |
| `challenge_support_cast` (alias `competition_vote_cast` only if a vote model is added) | `CHALLENGE_SUPPORT_CAST` | Support row committed | Yes |
| `challenge_result_published` | `CHALLENGE_RESULT_PUBLISHED` | Result snapshot committed | Yes |

Judging activity and score distributions are read from `ChallengeJudgeScore`, not
from an analytics event. A judge opening a form is not a confirmed score.

### 17.3 Challenge metrics

- Views and unique sessions for the challenge page and standings page.
- Entries started, entries submitted and completion rate, with a null zero
  denominator.
- Support signals, unique supporters and the weighted standing, read from the
  domain.
- Judging coverage: judges assigned, scores submitted, score distribution and
  completion rate.
- Results published and the frozen snapshot.
- Participation by country and device only after Phase 2 privacy approval.
- Sponsor engagement as aggregate counts only. No sponsor access to
  visitor-level rows.

### 17.4 Sequence

1. Resolve section 17.1 with the product owner.
2. Challenge Phase A schema and services: challenges, entries, weighted
   standings, anti-gaming, sponsor, public read routes.
3. Challenge analytics: event names, reach/funnel aggregates, owner/admin
   dashboards.
4. Challenge Phase B: judging, results, badges and their analytics.
5. Web challenge surfaces on the live contract.
6. Sponsor self-serve and public API only after a separate decision.

No challenge table, route or migration is created before step 1 is resolved.
