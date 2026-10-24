# Discovery taxonomy

Status: **implemented** — `GET /taxonomy`, nullable assignments on ideas and
campaigns, and seeded reference data.

## The list

The canonical taxonomy is the 15-parent, 154-subcategory list accepted by
`inverge-web/docs/DECISIONS.md` D-038. The web module
`inverge-web/src/features/campaigns/lib/taxonomy.ts` remains the product source;
`inverge-api/src/modules/taxonomy/taxonomy.data.ts` mirrors it and is the list the
API validates writes against.

Slugs are stable public identifiers. Labels are presentation data and are never
derived from slugs at runtime, so correcting a label cannot move a published URL.
`taxonomy.ts` asserts at module load that category slugs, category/subcategory
pairs and labels within a parent are unique.

Changing the taxonomy is a two-repository change:

1. update the web module and its tests;
2. mirror the entry in `taxonomy.data.ts`;
3. run `pnpm db:seed` so the reference tables and `GET /taxonomy` agree.

There is no cross-repository drift check yet. That is a known gap, not an
automation that exists.

## Read route

`GET /api/v1/taxonomy` is public and returns categories in display order:

```json
{
  "data": [
    {
      "slug": "food",
      "label": "Food",
      "publicIdeaCount": 4,
      "subcategories": [
        { "slug": "farms", "label": "Farms", "publicIdeaCount": 3 }
      ]
    }
  ]
}
```

`publicIdeaCount` uses the same visibility rule as `GET /ideas`: the idea is
`VALIDATING` or `THRESHOLD_MET` **and** `DISCOVERABLE` or `FEATURED`. Draft,
converted and link-only ideas are not counted, so a category chip cannot advertise
an unlisted idea. Counts are derived from `Idea` on every read (FR-203); there is
no stored counter to drift.

The parent count includes ideas assigned only at the parent level. A subcategory
slug is only unique within its parent (`comics/events` and `theater/events` both
exist), so child counts are grouped by the pair.

## Assignments

`Idea` and `Campaign` carry two nullable columns:

- `taxonomyCategorySlug`
- `taxonomySubcategorySlug`

Both are null when the honest fit is none. The child may only be set with a
parent, and only under that parent. `POST /ideas` and `PATCH /ideas/:id` accept:

```json
{ "taxonomy": { "category": "food", "subcategory": "farms" } }
```

Omit `taxonomy` on `PATCH` to leave the assignment unchanged; send `null` to
clear it. A campaign inherits its idea's pair at conversion
(`POST /ideas/:id/convert`), so there is one assignment to keep honest rather than
two that can disagree.

`GET /ideas`, `GET /ideas/:id`, `GET /campaigns` and `GET /campaigns/:id` project
the pair as:

```json
{ "taxonomy": { "category": "food", "subcategory": "farms" } }
```

The raw slug columns are not exposed.

## Filters

`GET /ideas` and `GET /campaigns` accept:

- `taxonomyCategory` — a category slug from the canonical list;
- `taxonomySubcategory` — a child slug; requires `taxonomyCategory` and must
  belong to it.

These are independent of the legacy `category` filter. `Idea.category` is the
broad builder bucket (`software`, `agritech`, …) and is not this taxonomy; no new
discovery surface should read it as one.

Invalid pairs return `400` with the error envelope. The cursor fingerprint
includes both filters, so a cursor cannot be reused across a different taxonomy
selection.

## Reference data

`TaxonomyCategory` and `TaxonomySubcategory` are seeded from `taxonomy.data.ts` by
`prisma/seed.ts`. The seed upserts by stable slug, applies label/order changes, and
deletes rows the canonical list no longer contains.

Assignments intentionally carry **no foreign key** to these tables. Write
validation uses the canonical list, so an API instance can serve while reference
data is being reseeded, and a taxonomy edit cannot block an unrelated write. The
trade-off is that a direct database write can create an orphan slug; application
code never does, and `toTaxonomyProjection` degrades an unknown stored pair to
`null` rather than inventing a label.
