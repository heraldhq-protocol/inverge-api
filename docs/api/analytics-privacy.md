# Analytics and privacy

Status: **target**. No analytics pipeline exists in either repository today. There
is also no consent banner, because there is nothing to consent to yet. This
document fixes the rules before the first event is written.

## Product questions first

An event is added only when it answers a named question (for example: "which
campaign step loses creators?"). If no decision depends on the event, it is not
collected.

| Event | Answers | Properties |
|---|---|---|
| `idea_viewed` | Which ideas attract attention? | `ideaId`, `source` (`feed`/`search`/`direct`), `position` |
| `idea_signal` | Which signals predict conversion? | `ideaId`, `signalType` |
| `campaign_viewed` | Does discovery reach campaigns? | `campaignId`, `source`, `position` |
| `campaign_step_started` | Where does the creator flow drop? | `campaignId`, `step` |
| `campaign_step_completed` | Same | `campaignId`, `step`, `durationMs` |
| `contribution_started` | Funnel entry | `campaignId` |
| `contribution_confirmed` | Conversion | `campaignId`, `amount` (minor units), `currency` |
| `search_performed` | What is missing from the catalogue? | `queryLength`, `resultCount`, `filterKeys` |

`search_performed` stores the query length and the number of results, not the
query text: a search box is where people type names, addresses and wallet
addresses.

## What is never collected

- IP addresses, raw or hashed. No `ip`, no `ipHash`, no geolocation from IP.
- User agents or device fingerprints.
- Email addresses, wallet addresses, provider subject ids, KYC documents.
- Free-text content: idea bodies, comments, pitches, search queries.
- Cross-site identifiers and third-party advertising pixels.

A country may be attached when the edge already resolved it (a CDN header). It is
coarse: country only, never a city or coordinates.

## Identity

`userId` is stored only for authenticated events and is the internal id. A
deletion request removes or anonymises events for that user. Anonymous events
carry a session-scoped random id that expires with the session and is never joined
to a user later.

## Retention

| Store | Retention |
|---|---|
| Raw events | 90 days |
| Daily aggregates | 25 months |
| Funnels and dashboards | Derived from aggregates; no raw replay |

Existing platform tables (`IdeaSignal`, `FeedImpression` if added) are not
analytics exports. They keep their own documented retention.

## Access and failure

- Reading analytics requires `ADMIN`; writing is server-side only. There is no
  public ingest endpoint.
- A failed analytics write never fails the user action. It is logged and dropped.
- Events are written after the domain transaction commits. An event must never be
  the reason a contribution or campaign transition rolls back.

## Consent

Analytics is first-party and aggregate. If the product later adds anything that
is not strictly necessary (session replay, third-party pixels, advertising), it
requires explicit opt-in and this document must be updated first.
