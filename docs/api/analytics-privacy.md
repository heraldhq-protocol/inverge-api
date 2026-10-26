# Analytics and privacy

Status: **implemented for Phase 1**. Server-observed views, step attempts and
confirmed domain signals are collected; owner/admin reports are request-gated.
There is no public browser ingest route and no consent banner, because Phase 1
adds no non-essential tracking. Phase 2 (device, region, referrer/UTM, returning
visitors, bot filtering) is still **target** and needs the approval described
below before any code ships.

## Product questions first

An event is added only when it answers a named question (for example: "which
campaign step loses creators?"). If no decision depends on the event, it is not
collected.

| Event | Answers | Properties |
|---|---|---|
| `page_viewed` | Which product surfaces are used? | closed `pageKey`, `source` |
| `idea_viewed` | Which ideas attract attention? | `ideaId`, `source` (`feed`/`search`/`direct`), `position` |
| `idea_signal` | Which signals predict conversion? | `ideaId`, `signalType` |
| `feedback_submitted` | Does structured feedback correlate with conversion? | `ideaId` |
| `campaign_viewed` | Does discovery reach campaigns? | `campaignId`, `source`, `position` |
| `campaign_step_started` | Where does the creator flow drop? | `campaignId`, `step` |
| `campaign_step_completed` | Same | `campaignId`, `step`, `durationMs` |
| `contribution_started` | Funnel entry | `campaignId` |
| `contribution_confirmed` | Conversion | `campaignId`, `amount` (minor units), `currency` |
| `search_performed` | What is missing from the catalogue? | `queryLength`, `resultCount`, `filterKeys` |

`search_performed` stores the query length and the number of results, not the
query text: a search box is where people type names, addresses and wallet
addresses. A page view stores a key from a closed list, never a URL, route
parameter or query string.

`idea_signal` and `feedback_submitted` are confirmed outcomes written by the API
after the business row commits. A click, render or optimistic UI state is never
enough to produce them. Names such as `idea_supported`, `prepledge_created` and
`campaign_backing_completed` are rejected if a caller sends them to the ingest
route.

## What is never collected

- IP addresses, raw or hashed, in any analytics table, queue, payload or log.
  (The rate limiter hashes an address before using it as a Redis key; that key is
  operational, expires, and is never an analytics record.)
- User agents or device fingerprints.
- Email addresses, wallet addresses, provider subject ids, KYC documents.
- Free-text content: idea bodies, comments, pitches, search queries.
- Cross-site identifiers and third-party advertising pixels.

A country may be attached when the caller already resolved it. In Phase 1 the
Next.js server supplies a two-letter `countryCode`; the API does not read a
forwarding header and never stores an address. It is coarse: country only, never
a city or coordinates. Phase 2 must not expand this without the approval below.

## Identity

`userId` is stored only for authenticated events and is the internal id. Anonymous
events carry a first-party, session-scoped random id that expires with the session
and is never joined to a user later. Phase 1 has no automated account-deletion
endpoint; raw events expire after 90 days. A documented deletion/anonymisation
procedure is a Phase 2 prerequisite, not an optional extra.

## Retention

| Store | Retention |
|---|---|
| Raw events | 90 days by default (`ANALYTICS_RAW_RETENTION_DAYS`) |
| Daily aggregates | 25 whole months by default (`ANALYTICS_AGGREGATE_RETENTION_MONTHS`) |
| Funnels and dashboards | Derived from aggregates; no raw replay |

Existing platform tables (`IdeaSignal`, `FeedImpression` if added) are not
analytics exports. They keep their own documented retention.

## Access and failure

- Owners read basic reports for their own ideas and campaigns; an admin reads
  everything. Acquisition, geography and campaign-funnel reports need an approved
  `AnalyticsAccessGrant` (`analytics.premium`). Non-owners get `404`, not a hint
  that the resource exists. `CreatorTier` is not an entitlement.
- Writing is server-side only. Confirmed outcomes are written by the domain after
  commit; views and step attempts arrive through the HMAC-signed
  `POST /api/v1/internal/analytics/events` route. There is no public browser
  ingest endpoint. The one scoped exception is the advertising validator below,
  which is disabled by default and has no sink.
- A failed analytics write never fails the user action. It is logged and dropped.
- Events are written after the domain transaction commits. An event must never be
  the reason a contribution or campaign transition rolls back.
- An analytics report never returns a visitor-level row, a session id, an account
  id or a country-level history. Reports are aggregate only. The admin
  access-request list is an administration surface, not an analytics report.

## Consent

Phase 1 is first-party, server-observed and aggregate. It has no device
fingerprint, referrer, UTM, region-within-country or returning-visitor tracking,
so there is nothing to opt into and no banner.

Phase 2 audience measurement (device/browser/OS, region, referrer/UTM, returning
visitors, bot classification) requires an explicit opt-in, a consent record, a
retention/deletion procedure, an amendment to this document and review against
the Nigeria Data Protection Act and the international jurisdictions Inverge
serves. The project owner must approve that expansion before code ships. If the
product later adds anything else that is not strictly necessary (session replay,
third-party pixels, advertising), the same rule applies.

## Scoped exception: advertising measurement

Advertising measurement is a separate purpose with its own consent record
(`inverge:advertising-consent:v2`), not part of product analytics. The web build
exposes `POST /api/advertising/events` only when both the server and public
measurement flags are `true`, and the reader has explicitly allowed measurement.
The route is a validating boundary: it rejects bots, malformed events, stale or
future timestamps, oversize bodies, and floods, then returns `persisted: false`.
No event is written or logged today.

If the API later implements the sink described in
[advertising.md](./advertising.md), the rules are: no IP address, user agent,
cookie, account id, wallet address, or free text; a random per-tab session id as
the only subject; 90-day raw retention and 25-month aggregates; ad events are
never joined to campaign analytics, validation signals, or funding figures. The
same opt-in rule applies, and refusing measurement must not hide content.

Third-party personalised advertising is a second, independent consent purpose.
It is off by default, never requested before an explicit choice, and not served
by the API. Enabling it is a product and privacy decision, not an environment
flag alone.
