# Pagination, filtering and sorting

Status: **target**. Current list endpoints use `skip`/`take` (see the “Today”
section). The cursor contract below is what the client will be built against.

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
- `skip` is deprecated once a route supports cursors, and is capped (no deep
  offsets). It will be removed.
- `total` is `null` when a count would be expensive. When present it carries
  `totalKind: "exact" | "estimated"` and, for estimates, `asOf`.
- Discovery never runs `COUNT(*)`. Admin tables may, because their volume is bounded.

### Sorting by a volatile aggregate

`most-backed` and `most-delivered` change while a client pages. They are served
from a periodically refreshed ranking projection, not `ORDER BY` over a live join.
Until that projection exists, those sorts use the same `(sortValue, id)` keyset and
are documented as “as of the last refresh”.

## Filters

- Filters are explicit query parameters, never a JSON blob.
- Unknown parameters are rejected (`forbidNonWhitelisted`), so a typo cannot
  silently return the unfiltered set.
- Booleans accept only `true` or `false`. The current `@Type(() => Boolean)` parse
  (where `?mine=false` becomes `true`) is scheduled for replacement.
- Repeated values (`?category=a&category=b`) mean OR within a field; different
  fields mean AND.
- Enum filters are validated against a closed list; an unknown value is a 400, not
  an empty page.

## Today (offset, to be replaced)

| Route | Current | Problem |
|---|---|---|
| `GET /ideas` | `skip`/`take` (max 50), then in-memory re-sort for featured | A re-sort after the page is cut makes ordering inconsistent across pages |
| `GET /campaigns` | `skip`/`take` (max 100), `most-delivered` sorted in memory | Same |
| `GET /feed` | fixed candidate pool (`take: 300`), no cursor | No way to continue past the pool |
| `GET /admin/users` | `take` only | Bounded today, unbounded growth |

## Performance expectations

- A page query is index-backed: `(filter columns, sort column, id)`.
- No list route may load a full related aggregate (milestones, claims, idea body)
  for a card. List projections are explicit `select`s.
- A cold page should stay under 100 ms at the 95th percentile on staging data; a
  cached page under 20 ms. These are targets until measured (see the audit plan).
