# Advertising

Status: **proposed**. No advertising controller, service, migration, cache, or
event sink exists in `inverge-api` today. This document is the implementation
contract for the tables and routes that the web preview already models. Until
the routes appear in `openapi.json` and are covered by tests, treat every path
below as `missing`, not as an API you can call.

The web-side behaviour and policy are in
`inverge-web/docs/ADVERTISING.md`. The web preview reads fixtures and does not
call these routes.

## Boundaries

- Advertising is its own module. It has no relation to `Idea`, `Campaign`,
  `IdeaSignal`, `Contribution`, or `OnChainEvent`, and cannot write ranking,
  validation, review, or funding state.
- A creative is served only when it is `APPROVED` **and** inside its schedule
  **and** booked into the requested placement.
- Public payloads contain approved, active creatives only. Drafts, pending,
  rejected, paused, ended, and out-of-window rows never leave the API.
- Third-party inventory is never selected by the slot endpoint. The vendor
  adapter is a web-only, consent-gated component.
- Admin routes are authenticated and permission-checked server-side. The API is
  the authority; a hidden button is not authorization.

## Proposed data model

Defined in `prisma/schema.prisma` and the (unapplied) migration
`prisma/migrations/20261022120000_advertising/migration.sql`.

| Table | Purpose |
|---|---|
| `Advertisement` | Creative copy, destination, format, kind, status, priority, window, categories, regions, approval facts |
| `AdvertisementPlacement` | One row per booked placement; `@@unique([advertisementId, placementId])` |
| `AdvertisementReviewEvent` | Append-only lifecycle audit (`actorId`, action, from, to, reason) |
| `AdvertisementEvent` | Validated measurement rows; `dedupeKey` unique; no IP, user agent, cookie, account, or free text |

Money, billing, invoices, and advertiser accounts are deliberately absent. There
is no revenue model to reconcile yet.

### Placement ids

The API accepts only the closed set below. An unknown id is a 400
`AD_PLACEMENT_UNKNOWN`, not a new slot.

| Id | Page kind | Format | Viewports | Minimum organic |
|---|---|---|---|---|
| `campaign-feed-inline` | `campaigns` | `NATIVE_CARD` | all | 6 |
| `campaign-detail-inline` | `campaign` | `BANNER` | all | - |
| `campaign-detail-rail` | `campaign` | `SIDEBAR` | desktop | - |
| `idea-feed-inline` | `ideas` | `NATIVE_CARD` | all | 6 |
| `idea-detail-inline` | `idea` | `BANNER` | all | - |
| `idea-detail-rail` | `idea` | `SIDEBAR` | desktop | - |
| `content-inline` | `guide`, `journal` | `BANNER` | all | - |
| `content-sidebar` | `guide`, `journal` | `SIDEBAR` | desktop | - |
| `editorial-third-party` | `guide`, `journal` | `THIRD_PARTY` | tablet, desktop | - |

The registry lives in code, not in a table. Changing inventory is a reviewed
deployment, and the web and API lists must match.

## Public: serve slots

```
GET /api/v1/advertising/slots
```

Query:

| Name | Required | Notes |
|---|---|---|
| `placements` | yes | Comma-separated ids, at most 4, no duplicates |
| `pageKind` | yes | `campaigns`, `campaign`, `ideas`, `idea`, `guide`, `journal` |
| `category` | no | One discovery category; omitted means no category targeting |
| `region` | no | ISO 3166-1 alpha-2, lowercase |

Response `200`:

```json
{
  "asOf": "2026-10-22T12:00:00.000Z",
  "slots": [
    {
      "placementId": "campaign-feed-inline",
      "creative": {
        "id": "northstar-native-2026",
        "advertiser": "Northstar Tools",
        "headline": "Run the shop without the spreadsheet",
        "body": "A workspace for small teams that need invoices, stock, and receipts in one place.",
        "ctaLabel": "See the workspace",
        "destination": "https://example.com/northstar-tools",
        "format": "NATIVE_CARD"
      }
    }
  ]
}
```

Rules:

- No cookie, session, account, or consent header is read. The endpoint is the
  same for every anonymous reader and can be cached.
- `priority` and review metadata are server-only and never returned.
- A placement with no eligible creative is omitted. There is no placeholder
  object; the web renders nothing.
- Density is one creative per placement. A creative appears at most once across
  the response.
- Selection is deterministic for a given `asOf`/day bucket so a cached response
  cannot disagree with itself.
- `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`.
- Empty response is `{ "asOf": "...", "slots": [] }`, not 404.

Errors: `400 AD_PLACEMENT_UNKNOWN`, `400 AD_PLACEMENT_LIMIT`,
`400 VALIDATION`.

## Public: measurement intake

```
POST /api/v1/advertising/events
```

Body (2 KB maximum, JSON only):

```json
{
  "type": "ad_impression",
  "creativeId": "northstar-native-2026",
  "placementId": "campaign-feed-inline",
  "sessionId": "abcdefghijklmnop1234",
  "occurredAt": "2026-10-22T12:00:00.000Z"
}
```

| Field | Rule |
|---|---|
| `type` | `ad_impression`, `ad_click`, `ad_dismiss`, `ad_destination_opened` |
| `creativeId` | 3-96 chars, lowercase alphanumeric and `-`, existing creative |
| `placementId` | One of the closed set |
| `sessionId` | 16-64 chars, `[A-Za-z0-9_-]`; random per tab, never an account |
| `occurredAt` | Optional ISO timestamp; defaults to receipt time; ±10 minutes |

Responses:

| Status | Body | Meaning |
|---|---|---|
| `202` | `{ "accepted": true, "duplicate": false }` | Written (or accepted once a sink exists) |
| `202` | `{ "accepted": true, "duplicate": true }` | Same session/type/creative/placement already seen |
| `400` | `{ "error": { "code": "AD_EVENT_INVALID" } }` | Malformed, unknown type/placement, stale, or future |
| `403` | `{ "error": { "code": "AD_EVENT_REJECTED" } }` | Bot-like or missing user agent |
| `413` | `{ "error": { "code": "PAYLOAD_TOO_LARGE" } }` | Over 2 KB |
| `429` | `{ "error": { "code": "AD_RATE_LIMITED" } }` + `Retry-After` | Over 30 events/minute for one session |

The user agent is used for one bot check and discarded. The route must not log
the raw body. `dedupeKey = sessionId:type:creativeId:placementId` with a unique
constraint and a 6-hour replay window. Accepted events are written outside any
domain transaction and never fail a page action.

## Admin: inventory and lifecycle

All routes require a bearer session and `advertising:manage`; approve/reject
additionally require `advertising:approve`. Unauthenticated is `401`, missing
permission is `403 AD_FORBIDDEN`.

| Route | Purpose |
|---|---|
| `GET /admin/advertising/creatives` | List; filters `status`, `placementId`, `page` |
| `GET /admin/advertising/creatives/{id}` | One creative with placements and last review events |
| `POST /admin/advertising/creatives` | Create as `DRAFT` |
| `PATCH /admin/advertising/creatives/{id}` | Edit; any edit returns the row to `DRAFT` |
| `POST /admin/advertising/creatives/{id}/actions` | `{ "action": "submit" \| "approve" \| "reject" \| "pause" \| "resume" \| "end", "reason": "..." }` |
| `GET /admin/advertising/creatives/{id}/events` | Append-only review trail |
| `GET /admin/advertising/summary` | Counts by live, scheduled, pending, paused, ended |

Creation body:

```json
{
  "advertiser": "Northstar Tools",
  "headline": "Run the shop without the spreadsheet",
  "body": "A workspace for small teams that need invoices, stock, and receipts in one place.",
  "ctaLabel": "See the workspace",
  "destination": "https://example.com/northstar-tools",
  "format": "NATIVE_CARD",
  "placements": ["campaign-feed-inline"],
  "categories": [],
  "regions": [],
  "priority": 50,
  "startsAt": "2026-10-01T00:00:00.000Z",
  "endsAt": "2026-12-31T23:59:59.000Z"
}
```

Validation:

- `advertiser` 2-60; `headline` 8-72; `body` 20-160; `ctaLabel` 2-24.
- `destination` is `https://` with no credentials, or a single-slash Inverge
  path. `javascript:`, `data:`, `http:`, `//`, and backslashes are rejected.
- `format` must be allowed by every chosen placement.
- `priority` integer 0-100. `endsAt` strictly after `startsAt`.
- `categories` must be known discovery categories; `regions` are lowercased
  ISO codes.
- `kind` is server-set. A client cannot create `THIRD_PARTY`.

Lifecycle (same matrix as the web domain):

```
DRAFT          -> submit   -> PENDING_REVIEW
PENDING_REVIEW -> approve  -> APPROVED
PENDING_REVIEW -> reject   -> REJECTED      (reason >= 10 chars)
APPROVED       -> pause    -> PAUSED
PAUSED         -> resume   -> APPROVED
APPROVED       -> end      -> ENDED
PAUSED         -> end      -> ENDED
REJECTED       -> submit   -> PENDING_REVIEW
ENDED          -> (terminal)
```

Every action appends `AdvertisementReviewEvent` in the same transaction. An
out-of-status action is `409 AD_TRANSITION_NOT_ALLOWED`; a rejection without a
reason is `422 AD_REASON_REQUIRED`. Approval records `approvedById`/`approvedAt`.

## Cache contract

No cache exists today. When one is added:

| Key | Value | TTL | Invalidate |
|---|---|---|---|
| `v1:ads:gen` | generation counter | none | every lifecycle or edit write |
| `v1:ads:slots:{gen}:{placements}:{pageKind}:{category\|*}:{region\|*}:{dayBucket}` | public slot response | 60 s ±10% | generation bump |
| `v1:ads:creative:{id}:public` | public creative projection | 60 s ±10% | generation bump |

- Read at most once per request; a Redis error is a miss, never a 500.
- Admin routes are never cached.
- No `KEYS`/`SCAN`. A generation bump is the only invalidation.
- Public responses include `asOf`; they are not live inventory.
- Because there is no cache layer, cache-invalidation behaviour is untested and
  must not be claimed. The web preview likewise has no cache.

## Privacy and retention

Extends [analytics-privacy.md](./analytics-privacy.md) with one scoped
exception: this endpoint accepts anonymous advertising events. It still forbids
IP addresses, user agents, cookies, account ids, wallet addresses, and free text.
`sessionId` is a random per-tab value, expires with the session, and is never
joined to a user. Raw `AdvertisementEvent` rows are retained 90 days; daily
aggregates are retained 25 months. Deleting a user does not touch these rows
because they carry no user identifier; a session purge job deletes expired rows.

Personalised third-party advertising is not served by this API. It is a web
adapter behind its own consent purpose, and enabling it requires a privacy
review, not just a flag.

## Rate limits

| Route | Budget |
|---|---|
| `GET /advertising/slots` | 300/min per IP |
| `POST /advertising/events` | 30/min per `sessionId` + 120/min per IP |
| Admin reads | 120/min per user |
| Admin writes | 30/min per user |

Limiter outage: reads degrade to an in-process limiter; event ingestion fails
closed with `503`, because an unbounded write path is worse than a dropped
beacon.

## OpenAPI and status

These routes are **not** in `openapi.json`. When implemented:

1. Add controllers and DTOs, run `pnpm openapi:emit`.
2. Add route tests, including permission and lifecycle failures.
3. Apply the migration on a scratch database first.
4. Update this status line, the README table, and
   `inverge-web/docs/ADVERTISING.md` in the same release.

Until then, the honest statement is: advertising is a labelled web preview with
no server persistence, no billing, and no operational analytics.
