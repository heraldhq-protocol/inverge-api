# Pagination, filtering and sorting

Status: **implemented** for `GET /ideas` and `GET /campaigns`. The ranked feed and
comment threads are still bounded reads without a cursor (see “Today”).

## Cursor pagination

Collections return:

```json
{
  "data": [ ... ],
  "page": {
    "limit": 24,
    "nextCursor": "eyJ2IjoxLCJrIjpbIjIwMjYtMTAtMjFUMTI6MDA6MDAuMDAwWiIsImNtMSJdLCJmIjoiYTNmMiJ9",
    "hasMore": true,
    "total": null,
    "totalKind": "omitted"
  }
}
```

`nextCursor` is opaque. Do not decode, construct or compare cursors. Pass it
unchanged as `?cursor=`.

The cursor encodes the last item's sort value and id, plus a hash of the active
filter/sort. A cursor presented with different filters is rejected with
`400 INVALID_CURSOR` rather than returning a mixed result set.

### Rules

- `limit` default 24, maximum 50 for discovery; admin tables default 50, maximum 100.
- Every sort has a unique tie-breaker (`id`); otherwise items can repeat or vanish
  between pages.
- `skip` is not accepted on a cursor route. A client that needs a page restarts
  from the first page instead of deep-offsetting.
- `total` is `null` when a count would be expensive. When present it carries
  `totalKind: "exact" | "estimated"` and, for estimates, `asOf`.
- Discovery never runs `COUNT(*)`. Admin tables may, because their volume is bounded.

### Sorting by a volatile aggregate

`most-backed` changes while a client pages. It uses the same `(totalRaised, id)`
keyset and is documented as “as of the request”: a campaign whose raised amount
moves backwards can be missed or repeated between pages. A periodically refreshed
ranking projection is the eventual fix.

`most-delivered` was **removed**. It counted approved milestone claims and was
sorted in memory after the page had already been cut, which reordered one page
rather than the collection. It returns `400` until a denormalized released-claim
counter exists.

## Filters

- Filters are explicit query parameters, never a JSON blob.
- Unknown parameters are rejected (`forbidNonWhitelisted`), so a typo cannot
  silently return the unfiltered set.
- Booleans accept `true`, `false`, `1` or `0`. Anything else is a validation
  error; `?mine=false` is `false`.
- Repeated values (`?category=a&category=b`) mean OR within a field; different
  fields mean AND.
- Enum filters are validated against a closed list; an unknown value is a 400, not
  an empty page.

## Today

| Route | Current | Notes |
|---|---|---|
| `GET /ideas` | `limit` (default 24, max 50) + `cursor` | Keyset on `(createdAt, id)`, newest first. The featured/promoted in-memory re-sort was removed: it only reordered the current page. `promoted`/`boostTier` are still returned for the badge. |
| `GET /campaigns` | `limit` + `cursor` | Keyset on `(createdAt, id)`, `(deadline, id)` or `(totalRaised, id)`. `most-delivered` was removed. |
| `GET /feed` | fixed candidate pool, no cursor | Ranked output has no stable sort value yet; the pool is bounded. |
| `GET /ideas/:id/comments` | `take: 300`, no cursor | Bounded today; a thread cursor is still to be designed around highlighted/liked ordering. |
| `GET /admin/users` | `take` only | Bounded today, grows with the user table. |

The list envelope (`{ data, page }`) is emitted by these two routes. Their
OpenAPI entries still carry no response schema; typed response DTOs are the next
contract step.

## Performance expectations

- A page query is index-backed: `(filter columns, sort column, id)`.
- No list route may load a full related aggregate (milestones, claims, idea body)
  for a card. List projections are explicit `select`s.
- A cold page should stay under 100 ms at the 95th percentile on staging data; a
  cached page under 20 ms. These are targets until measured (see the audit plan).
