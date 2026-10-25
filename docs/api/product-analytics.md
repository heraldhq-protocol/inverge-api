# Product analytics: implementation

Status: **implemented as a server-side pipeline**. The contract is
[analytics-privacy.md](./analytics-privacy.md); this page records what exists and what
does not.

## How an event is written

There is **no HTTP ingestion route**. Domain services call
`ProductAnalyticsService.record()` after their own transaction commits. A rejected
event or a database failure is logged without values and dropped; analytics may
never fail the user action.

The writer lives in `src/modules/analytics/`. Before insert,
`assertProductAnalyticsEvent` checks:

- the name is in the closed taxonomy;
- `occurredAt` is within the last 90 days and at most 5 minutes in the future;
- an event has either an internal `userId` or an anonymous `sessionId`, never both;
- only fields declared for that event name are present (a stray `email`, `query` or
  `ip` is rejected);
- ids, filter keys and country codes match their structural formats.

The table has no IP, user-agent, cookie, email, wallet, provider-subject or free-text
column. Nothing in the write path reads the request.

## Emitted today

| Event | Where | Properties |
|---|---|---|
| `IDEA_SIGNAL` | `IdeasService.support` / `prePledge`, after commit | `ideaId`, `signalType`, internal `userId` |

A repeated support is a no-op in the domain and is not recorded again. A repeat
pre-pledge updates the existing signal; only its first creation is counted.

The rest of the taxonomy (`IDEA_VIEWED`, `CAMPAIGN_VIEWED`, campaign steps, search,
contributions) is declared but **not emitted**: view events need the web server
integration, and contribution events need the escrow/indexer work. `SEARCH_PERFORMED`
is deliberately not emitted from the API until there is a server-side search caller;
recording cached API reads would measure cache traffic, not search intent.

## Aggregation and retention

- Nightly job `analytics-maintenance` at 04:15 UTC rebuilds yesterday's
  `IdeaSignalDailyMetric` rows and then purges expired data. The BullMQ worker is
  registered only when `QUEUE_ENABLED=true`.
- Aggregation is idempotent per `(ideaId, day)`: a rerun replaces the day's counts.
  `uniqueActors` counts distinct internal user ids, not rows.
- Raw events are deleted after `ANALYTICS_RAW_RETENTION_DAYS` (default 90) by
  `receivedAt`. Aggregates older than `ANALYTICS_AGGREGATE_RETENTION_MONTHS` (default
  25) whole months are deleted.
- There is no admin trigger or creator read route yet. The aggregate table exists for
  the creator dashboard work, not for a public API.

## Verification

`src/modules/analytics/*.spec.ts` (24 cases) covers taxonomy validation (including a
rejected free-text field), the drop-on-failure behaviour, day boundaries, distinct
actors, idempotent upserts and both retention cutoffs. `test/analytics.e2e-spec.ts`
proves there is no public ingestion route, writes real events through the idea
support/pre-pledge endpoints, repeats a support without duplicating the event, and
rolls the day up twice with the same result.
