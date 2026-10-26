# Product analytics: implementation

Status: **implemented**. Phase 1 is a server-side pipeline with a signed
service-to-service ingest route and owner/admin read APIs. The privacy contract is
[analytics-privacy.md](./analytics-privacy.md); the HTTP contract is
[analytics.md](./analytics.md).

There is still **no public browser ingestion route**. The Next.js server is the
only caller of the ingest route, and it holds the shared secret.

## Two write paths

| Path | Used for | Timing |
|---|---|---|
| `ProductAnalyticsService.record()` | Confirmed domain outcomes | After the domain transaction commits |
| `POST /api/v1/internal/analytics/events` | Views, step attempts, search observations | Server-to-server, HMAC-signed |

A domain write is best-effort: a rejected event or a database failure is logged
without values and dropped. Analytics may never fail support, pre-pledge, feedback
or a page render.

The ingest route validates every event, writes valid events in one
`createMany({ skipDuplicates: true })`, and reports rejected events by index. With
`QUEUE_ENABLED=true` the batch is handed to the `analytics-ingest` BullMQ queue
(three attempts, exponential backoff); a queue failure falls back to an inline
write so a Redis outage does not drop views.

## Closed taxonomy

Stored names are `SCREAMING_SNAKE_CASE`. The wire names below are the only names
the signed route accepts; a confirmed outcome sent to it is rejected rather than
trusted.

| Wire name | Stored name | Confirmed by |
|---|---|---|
| `page_viewed` | `PAGE_VIEWED` | Web server, closed page key |
| `idea_viewed` | `IDEA_VIEWED` | Web server |
| `campaign_viewed` | `CAMPAIGN_VIEWED` | Web server |
| `campaign_step_started` | `CAMPAIGN_STEP_STARTED` | Web server |
| `campaign_step_completed` | `CAMPAIGN_STEP_COMPLETED` | Web server |
| `search_performed` | `SEARCH_PERFORMED` | Web server (lengths and filter keys only) |
| - | `IDEA_SIGNAL` | `IdeasService.support` / `prePledge`, after commit |
| - | `FEEDBACK_SUBMITTED` | `SurveyService`, after commit |
| - | `CONTRIBUTION_STARTED` | Deferred with the contribution flow |
| - | `CONTRIBUTION_CONFIRMED` | Deferred with the indexer |

`idea_supported`, `idea_upvoted`, `idea_followed`, `idea_saved`,
`feedback_submitted`, `prepledge_created`, `competition_entry_started`,
`competition_entry_submitted`, `competition_vote_cast`, `campaign_backing_started`,
`campaign_backing_completed` and `share_clicked` are **confirmed names**. They are
never accepted on the ingest route. A frontend click is not a completed action.

`IDEA_FOLLOWED`, `IDEA_SAVED` and `competition_vote_cast` have no domain model
yet, so they are not emitted at all. A challenge domain is a separate workstream;
see the plan.

## Validation

`assertProductAnalyticsEvent` runs before every insert. It checks:

- the stored name is in the closed taxonomy;
- `occurredAt` is within the last 90 days and at most 5 minutes in the future;
- an event has either an internal `userId` or an anonymous `sessionId`, never both;
- only fields declared for that event name are present (a stray `email`, `query`,
  `ip` or `userAgent` is rejected);
- ids, page keys, source, step, signal type, country code, currency, filter keys
  and counts match their structural formats.

The table has no IP, user-agent, cookie, email, wallet, provider-subject or
free-text column. `countryCode` is a two-letter code resolved before the call; the
ingest path never sees an address.

## Idempotency

Every row has a unique `eventKey` and a `schemaVersion` (currently `1`). Domain
events use the domain row id (`IDEA_SIGNAL:<signalId>`,
`FEEDBACK_SUBMITTED:<surveyResponseId>`), so editing feedback cannot inflate the
count. Views use a UUID generated once per render and reused by retries. A replay
is skipped by the unique constraint and reported as a duplicate.

## Aggregation and retention

Nightly `analytics-maintenance` runs at 04:15 UTC when the queue is enabled:

1. `IdeaSignalDailyMetric` per `(ideaId, day)`
2. `ResourceReachDailyMetric` per `(resourceType, resourceId, day)`
3. `ResourceAcquisitionDailyMetric` per `(resourceType, resourceId, day, source)`
4. `ResourceCountryDailyMetric` per `(resourceType, resourceId, day, countryCode)`
5. `CampaignFunnelDailyMetric` per `(campaignId, day)`

Each pass is idempotent: a rerun replaces that day's rows. Unique actors are
distinct internal user ids, not row counts. Raw events are deleted after
`ANALYTICS_RAW_RETENTION_DAYS` (default 90); aggregates older than
`ANALYTICS_AGGREGATE_RETENTION_MONTHS` (default 25) whole months are deleted.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANALYTICS_INGEST_ENABLED` | `false` | Mounts the signed ingest route; boot fails if enabled without a secret |
| `ANALYTICS_INGEST_SECRET` | - | Shared HMAC key, at least 32 characters |
| `ANALYTICS_INGEST_CLOCK_SKEW_SECONDS` | `300` | Accepted timestamp skew |
| `ANALYTICS_INGEST_MAX_BODY_BYTES` | `65536` | Raw body cap for ingest |
| `ANALYTICS_READ_ENABLED` | `true` | Kill switch for every analytics read route (404 when false) |
| `ANALYTICS_RAW_RETENTION_DAYS` | `90` | Raw-event retention |
| `ANALYTICS_AGGREGATE_RETENTION_MONTHS` | `25` | Aggregate retention |

## Verification

- `src/modules/analytics/*.spec.ts`: 92 cases across 12 suites. Covers taxonomy
  validation, rejected free-text fields, drop-on-failure, range and bucket
  boundaries, zero denominators, idempotent aggregation, both retention cutoffs,
  HMAC and body limits, queue fallback, request-gated entitlements and the read
  guard.
- `test/analytics.e2e-spec.ts`: the domain signal path and the absence of a public
  ingest route.
- `test/analytics-phase1.e2e-spec.ts`: 18 cases against real Postgres covering
  signed ingest, stale and invalid signatures, duplicate keys, batch rejection,
  roll-up idempotency, owner/non-owner/admin reads, premium denial, the
  request → approve flow and the capabilities projection.

## Honest gaps

- No device, browser, OS, region-within-country, referrer/UTM, returning-visitor
  or bot classification. Those are Phase 2 and require a privacy-policy amendment
  and NDPA review.
- No follow/save/vote events because the domain models do not exist.
- No contribution start/confirm events until the escrow flow and indexer exist.
- `confirmedBacking` is the indexer-owned `Contribution` total, not a
  range-bounded analytics sum. It is never derived from a click.
- The web analytics preview is not wired to these routes yet.
