# Discussions

Two comment threads exist, one per public entity. They share a response shape
(`{ data, page }` with an opaque cursor) and an author projection, but not a
table: an idea thread is the validation conversation (FR-273) and a campaign
thread is the funding conversation (FR-701).

## Idea discussion

| Method | Path | Access |
|---|---|---|
| `GET` | `/ideas/:idOrSlug/comments` | Public, for any idea that is not a `DRAFT` |
| `POST` | `/ideas/:idOrSlug/comments` | Bearer session; only while the idea is `VALIDATING` or `THRESHOLD_MET` |
| `DELETE` | `/ideas/:idOrSlug/comments/:commentId` | Author or the idea's creator |
| `POST` / `DELETE` | `/ideas/:idOrSlug/comments/:commentId/like` | Bearer session, one like per user |
| `PATCH` | `/ideas/:idOrSlug/comments/:commentId/highlight` | The idea's creator |

An unpublished idea answers `404`, not an empty page. A converted or archived
idea keeps its thread readable as history.

## Campaign discussion

| Method | Path | Access |
|---|---|---|
| `GET` | `/campaigns/:idOrSlug/comments` | Public, only for `ACTIVE`, `FUNDED`, `FAILED` or `COMPLETED` |
| `POST` | `/campaigns/:idOrSlug/comments` | Bearer session |
| `DELETE` | `/campaigns/:idOrSlug/comments/:commentId` | Author or the campaign creator |

`idOrSlug` accepts the campaign id or the source idea's slug, the same pair the
public campaign page uses. `DRAFT`, `IN_REVIEW`, `REJECTED` and `CANCELLED`
campaigns answer `404`, including to a guessed id.

Campaign comments are flat in this release. The create DTO has no `parentId`,
so a reply field is rejected rather than accepted and discarded.

## Author projection

Every comment carries:

```json
{
  "author": {
    "id": "opaque-account-id",
    "displayName": "Ada Obi",
    "avatarUrl": null,
    "isCreator": false
  }
}
```

The author is always the authenticated session user. No request body may name
an author id. The projection never includes an email, wallet address, role or
KYC state; a missing display name stays `null` and the client renders a neutral
label.

## Pagination

`limit` defaults to 50 and is capped at 100. The cursor is opaque and bound to
the endpoint, the entity's internal id and the sort order:

- idea: `highlighted`, `likeCount`, `createdAt`, `id` (all descending)
- campaign: `createdAt`, `id` (descending)

Reusing an idea cursor on a campaign (or another idea) answers `400
INVALID_CURSOR`.

## Moderation and rate limits

Every create is screened through `ModerationService.screenSafe` as a
`comment` case. The result is advisory (NFR-17/D1): it records a
`ModerationCase` linked to the idea or campaign and never blocks the post or
changes its visibility.

Both create routes use the `comments` rate-limit policy (10/minute, burst 3, per
user). A banned account cannot mint a session, so it cannot reach either route.
