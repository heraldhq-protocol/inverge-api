# Email verification

Status: **implemented; external delivery setup incomplete.** The API, migration,
UI and tests are in place. Resend accepts mail only from the shared
`onboarding@resend.dev` sender until a domain is verified, and that sender may
deliver only to the Resend account owner. A test message was accepted and landed
in spam. See [deployment/email.md](../deployment/email.md) before claiming
production delivery.

Email verification is **not** identity verification (KYC) or AML screening. It
proves mailbox control. The two states are stored and displayed separately.

## Data model

| Field | Meaning |
|---|---|
| `User.email` | Nullable, lower-case, trimmed address. The existing unique index applies to it, and a database `CHECK` keeps the normalised form invariant. |
| `User.emailVerifiedAt` | Authoritative ownership timestamp. `null` means unproven. |
| `User.emailVerified` | Legacy boolean mirror kept for older readers. `emailVerifiedAt` wins. |
| `User.pendingEmail` | A proposed replacement. It never replaces `email` until the new address is proven. |
| `User.pendingEmailRequestedAt` | When the change was requested. |
| `EmailVerificationChallenge` | One short-lived challenge: address, purpose (`SIGNUP`/`CHANGE`), keyed code hash, expiry, attempts, consumption/supersession/failure timestamps. |

Only a keyed hash is stored:
`HMAC-SHA256(EMAIL_CODE_SECRET, "<challengeId>:<code>")`. The plaintext code
exists only in the outbound message. It is never logged, returned by the API, or
written to an analytics event.

## Routes

All routes require `Authorization: Bearer <session>`.

| Route | Purpose | Success |
|---|---|---|
| `GET /api/v1/auth/email` | Current address, ownership state and any live challenge. | `200` `{ email, verified, verifiedAt, pendingEmail, pendingRequestedAt, challenge }` |
| `POST /api/v1/auth/email/request` | Send a code to an address. Body `{ email }`. | `200` `{ status: "code_sent", email, expiresAt, resendAvailableAt }` or `{ status: "already_verified", email }` |
| `POST /api/v1/auth/email/verify` | Consume a code. Body `{ email, code }`. | `200` `{ status: "verified", email, verifiedAt }` or `{ status: "already_verified", email }` |
| `POST /api/v1/auth/email/resend` | Reissue the active challenge. No body. | Same shape as `request`. |
| `DELETE /api/v1/auth/email/pending` | Abandon a pending change. | `200` `{ pendingEmail: null }` |

`request` for an address that is already verified and unchanged is an idempotent
`already_verified`, not an error.

## Error codes

| Status | `error.code` | Meaning |
|---|---|---|
| `400` | `EMAIL_INVALID` | Address is not usable after normalisation. |
| `400` | `EMAIL_CODE_INVALID` | No matching live challenge, or the code is wrong. Deliberately uniform. |
| `400` | `EMAIL_CODE_EXPIRED` | The challenge expired; request a new one. |
| `400` | `EMAIL_NO_ACTIVE_CODE` | Resend was called without a live challenge. |
| `409` | `EMAIL_UNAVAILABLE` | The code was correct but the address belongs to another account. Accounts are never merged automatically. |
| `429` | `EMAIL_TOO_MANY_ATTEMPTS` | The challenge reached its attempt cap. |
| `429` | `EMAIL_RESEND_COOLDOWN` | A code was sent too recently. Includes `retryAfterSeconds`. |
| `429` | `EMAIL_RATE_LIMITED` | The per-hour issuance cap was reached. |
| `502` | `EMAIL_DELIVERY_FAILED` | The provider rejected the message or timed out. The challenge is invalidated. |

The responses do not distinguish "address exists" from "address does not exist"
until the caller has proven control of the mailbox. That is intentional.

## Issuance rules

- Six digits from a cryptographically secure integer source, including leading
  zeroes.
- Default TTL 10 minutes (`EMAIL_VERIFICATION_CODE_TTL_SECONDS`).
- Default resend cooldown 60 seconds
  (`EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS`).
- Default five wrong attempts per challenge
  (`EMAIL_VERIFICATION_MAX_ATTEMPTS`), then the challenge is unusable.
- Default five issued challenges per user per hour
  (`EMAIL_VERIFICATION_MAX_PER_HOUR`). The route rate limiter is a second,
  independent bound.
- Issuing a new challenge supersedes every live challenge for the user.
- Consumption is a conditional update inside a transaction. Two concurrent
  verifications cannot both succeed; the loser sees `EMAIL_CODE_INVALID`.
- `pg_advisory_xact_lock(hashtext('email:<userId>'))` serialises issuance and
  verification across API replicas.
- A delivery failure marks the challenge failed and superseded. A `CHANGE` also
  clears `pendingEmail`, so a half-confirmed change cannot linger.
- Provider de-duplication uses `Idempotency-Key: email-verification/<challengeId>`.

## Provider addresses

Web3Auth social identity tokens currently do **not** carry a signed
`email_verified` claim, so their address is stored as **unverified** and becomes
the address the account is expected to confirm. The API:

- stores the provider address in `User.email` even without a signed claim, but
  leaves `emailVerifiedAt` null;
- never overwrites a different address already stored on the account; changing
  the address is an explicit, rare action (mostly a business-account need)
  handled through the `CHANGE` challenge;
- promotes an existing unverified address when the provider proves the same
  address;
- if the provider address already belongs to another account, stores no address
  and returns the provider value only as `suggestedEmail` for prefill.

X and wallet sign-ins may carry no address; those users capture one through
Inverge OTP. The stub adapter accepts a `#verified` suffix on its email fixture
(`stub:<id>:<email>#verified`) to exercise the provider-proven path in tests.

## Where confirmation is required

The guard is server-side; disabled buttons are not the boundary. Confirmation is
**not an onboarding gate**: a new account can finish its profile, reach the
dashboard, browse, and support ideas without it. Idea support and pre-pledges are
deliberately exempt so a person can signal demand before completing the step.

| Action | Requires verified email |
|---|---|
| Create, edit or publish an idea | Yes |
| Comment, like, highlight, delete a comment | Yes |
| Submit or withdraw a survey response; set survey questions | Yes |
| Purchase a boost | Yes |
| Submit a campaign or start its application fee | Yes |
| Link a wallet or change wallet role | Yes |
| Request premium analytics access | Yes |
| Start KYC/KYB, choose account type, authorise a contribution | Yes |
| Complete onboarding, update the creator profile, save feed interests | **No** |
| Sign in, reach the dashboard, support/unsupport an idea, pre-pledge/withdraw | **No** |
| Read public ideas, comments, campaigns, feed | No |

A guarded route returns `403 EMAIL_VERIFICATION_REQUIRED` when
`emailVerifiedAt` is null. `GET /auth/me` and `GET /auth/capabilities` expose
`emailVerified` and `requiresEmailVerification`; the web uses them for the
non-blocking shell prompt and settings status only. The server gate is the
authority.

## Migration notes

`prisma/migrations/20261029120000_email_verification`:

1. normalises existing addresses to lower-case/trimmed;
2. backfills `emailVerifiedAt = updatedAt` for legacy `emailVerified = true` rows;
3. adds `CHECK` constraints for normalised `email` and `pendingEmail`;
4. creates the challenge table, indexes and foreign key.

Step 1 intentionally fails on a case-insensitive duplicate instead of merging
accounts. Resolve the conflicting rows manually, then re-run. Do not delete one
of the accounts as an automated migration step.

## Tests

- `src/modules/auth/email/*.spec.ts` covers hashing, normalisation, rendering,
  issuance, cooldown, expiry, attempt limits, consumption, ownership conflicts,
  delivery failure and resend.
- `src/modules/auth/auth.service.spec.ts` covers trusted vs unproven provider
  email and the no-overwrite rule.
- `src/modules/auth/capabilities.spec.ts` covers the gate flags.
- `src/modules/auth/guards/email-verified.guard.spec.ts` covers the server gate.
- The web BFF tests mock `fetch`; no real email is sent by the test suite.
