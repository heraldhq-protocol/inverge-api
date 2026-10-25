# Authentication

Status: **implemented**. Route names are historical: `PrivyAuthGuard` now verifies
Inverge sessions for every wallet provider (Web3Auth is the current one).

## Flow

```text
browser ──(provider id_token)──▶ Next.js BFF ──(POST /api/v1/auth/session)──▶ API
                                     │                                          │
                                     │◀── { sessionToken, user, creator } ──────┘
                                     │
                          HttpOnly cookie `inverge_session`
```

1. The wallet provider (Web3Auth) returns an `id_token` to the browser.
2. The browser posts it to the web app's own Route Handler (`POST /api/auth/session`).
   The provider token never reaches the API from the browser.
3. The API verifies the token against the provider's JWKS, upserts the user, records
   the attested wallet, and returns a one-hour HS256 session JWT.
4. The BFF writes the session into an HttpOnly, `SameSite=Lax` cookie and returns
   only `{ nextPath }` to the browser. Client JavaScript cannot read the token.

## Using the session

```http
GET /api/v1/auth/me HTTP/1.1
Authorization: Bearer <sessionToken>
```

The API verifies the signature and expiry, loads the user by `sub`, and attaches
it to the request. Every authenticated route re-checks ownership in its service;
a valid token is not authorisation by itself.

## Roles

| Role | Grants |
|---|---|
| Anonymous | Public reads (ideas, campaigns, creators, feed) |
| `USER` | Own profile, ideas, signals, feedback, comments, boosts, campaigns |
| `ADMIN` | `/api/v1/admin/*`, campaign review, platform parameters |

`ADMIN` is stored on the user row and may also be granted by the break-glass
`ADMIN_ALLOWLIST`. The allowlist exists to bootstrap the first administrator; it
matches provider user ids and allowlisted emails.

## Session properties

| Property | Value | Note |
|---|---|---|
| Algorithm | HS256 | Secret from `SESSION_JWT_SECRET` |
| Lifetime | 1 hour | No refresh endpoint yet; re-authenticate |
| Claims | `sub` only | Issuer/audience are not yet set |
| Storage | HttpOnly cookie (web) | Never `localStorage` |
| Revocation | None | A disabled account fails the per-request user lookup |

## Failure responses

| Situation | Status | `error.code` |
|---|---|---|
| Missing or malformed `Authorization` | 401 | `UNAUTHENTICATED` |
| Expired or invalid session | 401 | `UNAUTHENTICATED` |
| Valid session, insufficient role | 403 | `FORBIDDEN` |
| Provider token rejected at exchange | 401 | `UNAUTHENTICATED` |

## Security boundaries

- The API never trusts a client-supplied user id; identity comes from the verified
  `sub`.
- KYC/AML state is never accepted from the client. It is written only by the
  provider webhook or admin decision paths.
- The API holds no key that can move escrow funds. Refund claims are authorised by
  the on-chain program, not by this session.
- `GET /api/v1/auth/session` does not exist; the exchange is a `POST` because it
  mints a credential.
