# Errors

Status: **implemented** (`ApiExceptionFilter`, registered globally through
`APP_FILTER` so tests and production behave identically).

## Envelope

Every non-2xx response has exactly this shape:

```json
{
  "error": {
    "code": "CAMPAIGN_NOT_FOUND",
    "message": "Campaign not found.",
    "requestId": "6f1a1c1e-6f7a-4a3b-8c2d-1e2f3a4b5c6d",
    "details": [
      { "code": "VALIDATION", "message": "take must not be greater than 100" }
    ]
  }
}
```

| Field | Guarantee |
|---|---|
| `code` | Stable, `SCREAMING_SNAKE_CASE`. Safe to branch on. |
| `message` | Human text. May change; do not parse it. |
| `requestId` | Matches the `x-request-id` response header. Quote it in a bug report. |
| `details` | Optional. Validation entries, or route-specific context. |

`details` is deliberately `unknown`: validation returns an array of
`{ code, message }`, while a domain rejection may return an object such as
`{ blockers: [...] }`. Clients must narrow before use.

## Status mapping

| Status | Default code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Malformed request or validation failure |
| 401 | `UNAUTHENTICATED` | Missing, expired or invalid session |
| 403 | `FORBIDDEN` | Authenticated but not allowed |
| 404 | `NOT_FOUND` | Resource does not exist or is not visible |
| 405 | `METHOD_NOT_ALLOWED` | Wrong verb |
| 409 | `CONFLICT` | Unique constraint or idempotency reuse |
| 413 | `PAYLOAD_TOO_LARGE` | Body over the configured limit |
| 422 | `UNPROCESSABLE_ENTITY` | Syntactically valid, rejected by a business rule |
| 429 | `TOO_MANY_REQUESTS` | Rate limit exceeded; see `Retry-After` (not yet emitted) |
| 500 | `INTERNAL_ERROR` | Unexpected failure; details are logged, never returned |
| 502/503/504 | `BAD_GATEWAY` / `SERVICE_UNAVAILABLE` / `GATEWAY_TIMEOUT` | Dependency failure |

A route may supply a more specific code (for example `CAMPAIGN_NOT_FOUND`) by
throwing an `HttpException` whose response object includes `code`. Until every
service adopts explicit codes, the status default applies.

## In the contract

`docs/api/openapi.json` declares an `ErrorResponse` schema and attaches it as the
`default` response of every operation. A generated client can therefore type a
failure instead of only a success. `default` is used rather than enumerating
`400`/`401`/`403`/... per route because the filter is global and the set of
statuses a given route can return differs; the envelope itself does not.

## Validation errors

`ValidationPipe` rejects unknown fields (`forbidNonWhitelisted: true`). Each failed
rule becomes one `details` entry:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Request validation failed.",
    "requestId": "...",
    "details": [
      { "code": "VALIDATION", "message": "take must not be greater than 100" }
    ]
  }
}
```

## What is never returned

- Stack traces, SQL, Prisma error codes or provider payloads.
- Tokens, cookies, keys, KYC documents or raw webhook bodies.
- Whether an email or wallet belongs to an account, unless the caller already
  proved it owns that identifier.

Unexpected failures log the stack with the request id; the client receives only
`INTERNAL_ERROR` and the id.

## Client guidance

1. Branch on `code`, not `message`.
2. Treat an unknown `code` as a generic failure for that status.
3. Retry `5xx` and `429` with backoff; never retry a `4xx` unchanged.
4. Log `requestId` when showing a failure, so support can trace one request.
