# Creator Studio assistant

Phase 1 is a field-scoped idea assistant. It proposes text for one draft field and
never writes to the idea: the creator accepts, edits, regenerates or discards the
proposal, and saving stays an explicit action.

The API owns authentication, entitlement, quota, ownership, input size, provider
selection, schema validation and metering. The web app talks to same-origin BFF
routes (`/api/ideas/:id/assistant`, `/api/ai/access`,
`/api/ai/access-requests`), which forward the HttpOnly session to the API.

## API surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/ai/access` | Entitlement, configured flag, today's usage and caps |
| `POST` | `/api/v1/ai/access-requests` | Request a grant (idempotent; an admin decides) |
| `POST` | `/api/v1/ideas/:ideaId/assistant` | Propose text for one owned draft field |
| `GET` | `/api/v1/admin/ai/access-requests` | Admin list, optional `?status=PENDING` |
| `PATCH` | `/api/v1/admin/ai/access-requests/:id` | Admin approve/reject (`APPROVED` or `REJECTED`) |

Request body for the assistant:

```json
{
  "action": "improve",
  "target": "problem",
  "text": "The current text of that field",
  "context": { "title": "…", "targetUser": "…" },
  "baseRevision": "client revision echoed back",
  "clientRequestId": "uuid-v4"
}
```

`action` is `improve`, `shorten`, `expand` or `critique`. `target` is one of
`title`, `summary`, `problem`, `targetUser`, `currentAlternative`, `solution`,
`risks`. The response contains `proposal` (null for a critique), `notes`,
`assumptions`, `baseRevision` and `meta` (model, prompt version, token counts,
latency). It does not contain an idea write.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `AI_PROVIDER` | `disabled` | `disabled`, `stub` or `anthropic` |
| `AI_API_KEY` | – | Required when `AI_PROVIDER=anthropic`; never falls back to `ANTHROPIC_API_KEY` |
| `AI_BASE_URL` | – | DeepSeek: `https://api.deepseek.com/anthropic` |
| `AI_MODEL` | `deepseek-flash` | Assistant model; independent of `ANTHROPIC_MODEL` |
| `AI_TIMEOUT_MS` | `20000` | 1s–60s |
| `AI_MAX_OUTPUT_TOKENS` | `1200` | 64–4000 |
| `AI_MAX_INPUT_CHARS` | `6000` | Target text plus context |
| `AI_DAILY_REQUESTS_PER_USER` | `30` | UTC day |
| `AI_DAILY_TOKENS_PER_USER` | `60000` | Input + output tokens |

`stub` is deterministic offline JSON for tests and local UI work. Production boot
rejects `AI_PROVIDER=stub`. `disabled` leaves every assistant route at
`503 AI_NOT_CONFIGURED`; the manual builder is unaffected. `anthropic` speaks the
Anthropic Messages protocol; DeepSeek's compatible endpoint is
`https://api.deepseek.com/anthropic` and its canonical Flash model id is
`deepseek-flash`.

Keys belong in `.env` only. `.env` is gitignored; `.env.example` documents names
and never contains a value.

## Entitlement and quota

There is no client-side `isPremium` flag and `CreatorProfile.tier` is not an
entitlement. `AiAccessGrant` is one row per user (`ai.assistant` is the only
feature today) and is
admin-approved (D-055). Admins are entitled without a grant. A user may request
access when the grant is absent, rejected or expired; a pending request is not
re-created.

Every attempt appends an `AiUsageEvent` (feature, prompt version, model, request
id, token counts, latency, status). The daily request and token caps are checked
before the provider call and re-checked under the same accounting path. Exceeding
a cap returns `429 AI_QUOTA_EXCEEDED`.

## Errors

| Code | Status | Meaning |
| --- | --- | --- |
| `AI_NOT_CONFIGURED` | 503 | Provider disabled or missing key |
| `AI_ENTITLEMENT_REQUIRED` | 403 | No active grant |
| `AI_INPUT_TOO_LARGE` | 400 | Text plus context over `AI_MAX_INPUT_CHARS` |
| `AI_QUOTA_EXCEEDED` | 429 | Daily request or token cap reached |
| `AI_TIMEOUT` | 504 | Provider exceeded `AI_TIMEOUT_MS` |
| `AI_INVALID_OUTPUT` | 502 | Provider answer failed the strict schema |
| `AI_UNAVAILABLE` | 502 | Provider transport/auth failure |
| `IDEA_NOT_FOUND` | 404 | No owned idea with that id |

## Live smoke test (opt-in)

Unit and e2e tests force `AI_PROVIDER=stub`; they never call a provider. A live
call spends real tokens, so run it only with explicit approval and a disposable
test account.

1. Put a key in `AI_API_KEY` and confirm `AI_PROVIDER`, `AI_BASE_URL` and
   `AI_MODEL`. `ANTHROPIC_*` configures the moderation adapter only. Start the API
   and web app against the same database.
2. Sign in as an admin (entitled without a grant) or approve an `AiAccessGrant`
   for the test user through `PATCH /api/v1/admin/ai/access-requests/:id`.
3. Create a draft in the idea builder (the assistant needs a real idea id), open a
   field, and use **Improve**.
4. Confirm: the proposal appears without changing the field; **Use this text**
   changes only that field; **Restore original** puts the prior text back; a
   second browser tab editing the same field does not get overwritten.
5. Confirm one `AiUsageEvent` row and one `AiAccessGrant` decision are visible in
   the database, and that `GET /api/v1/ai/access` reflects today's usage.

Do not record the key, the raw prompt or the full provider response in logs or
fixtures. Provider pricing is account- and model-specific and is not encoded in
this repository; confirm it in the provider console before raising the daily
caps.
