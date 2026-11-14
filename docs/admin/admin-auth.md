# Dedicated admin authentication — design and threat model

- **Status:** Phase 2 implemented. Schema, migrations and the credential modules exist, plus the
  `/admin-auth` login/MFA/session routes and `AdminSessionGuard`. The existing `/admin/*`
  controllers are not cut over yet and the web slice is still open.
- **Decision owner:** product/security.
- **Related:** `admin-audit.md` (A-01, A-05), `admin-missing-features.md` (A-2), `admin-demo-mode.md`.
- **Chosen direction:** email + password + mandatory TOTP, flag-gated coexistence with the current
  product-session path, then cut over before any repo split.

### Implementation status (Phases 1-2)

| Piece | Location | State |
| --- | --- | --- |
| Prisma models + enums | `inverge-api/prisma/schema.prisma` | Valid; client generated |
| Phase 1 migration SQL | `prisma/migrations/20261113120000_admin_auth/migration.sql` | Applies cleanly in a rolled-back transaction together with Phase 2; **not applied or recorded** |
| Challenge model + migration | `prisma/migrations/20261114090000_admin_challenges/migration.sql` | Single-use, 5-minute, hashed, IP-bound challenge; SQL validated the same way |
| Password hashing | `src/modules/admin-auth/password.ts` | Argon2id, 64 MiB / t=3 / p=1 via `@node-rs/argon2@2.2.2` |
| TOTP | `src/modules/admin-auth/totp.ts` | RFC 6238 vectors, ±1 step, replay guard |
| Tokens / recovery codes | `src/modules/admin-auth/tokens.ts` | Opaque session/challenge tokens, HMAC identifiers |
| TOTP at-rest encryption | `src/modules/admin-auth/secret-box.ts` | AES-256-GCM, versioned payload |
| Env contract | `src/config/env.validation.ts` | Enforced mode fails boot without key material |
| Login / MFA / me / logout | `src/modules/admin-auth/admin-auth.{controller,service}.ts` | Implemented; generic 401s, audit events, session issued only after both factors |
| Session guard + capabilities | `src/modules/admin-auth/admin-session.guard.ts`, `capabilities.ts` | Resolves the admin row on every request; role-derived capability list |
| Rate limiting | `rate-limit.policies.ts`, `rate-limit.interceptor.ts` | `auth` bucket for login/MFA; `admin` bucket for me/logout, keyed by admin id |
| Unit tests | `src/modules/admin-auth/*.spec.ts`, `src/common/rate-limit/*.spec.ts` | 93 tests / 8 suites pass with `jest --runInBand --forceExit src/modules/admin-auth src/common/rate-limit` |

The hashing dependency was accepted: `@node-rs/argon2` ships prebuilt binaries and needs no build
toolchain. `Algorithm` is an ambient `const enum` in its typings, which `isolatedModules` forbids
reading, so the module uses the numeric Argon2id id with a comment. The scrypt fallback in §6 is not
implemented.

## 1. Why a separate system

The admin surface currently rides on the product session:

| Step | Code | Behaviour |
| --- | --- | --- |
| Early redirect | `inverge-web/src/proxy.ts` | `/admin` without a product session cookie → `/auth`. |
| Web gate | `src/app/admin/layout.tsx` → `getProgrammeAdminAccess()` | Allows a live session only when the API's `/auth/me` says `role === "ADMIN"`; allows a local preview identity only outside production. |
| Account creation | `inverge-api/src/modules/auth/auth.service.ts:92` | Every wallet/social sign-in is created with `role: 'USER'`. |
| API gate | `AdminGuard` after `PrivyAuthGuard` | DB `ADMIN` or `ADMIN_ALLOWLIST`, evaluated against the product session. |

Consequences observed in practice:

- A normal Web3Auth/MetaMask sign-in can never open `/admin`; there is no admin credential to
  present. The user either sees “Admin access required” (signed in as `USER`) or is redirected to
  `/auth` (no session).
- Admin authority is a role flag on a self-service account. Wallet possession is irrelevant to
  staff identity, account recovery is the product's recovery, and a shared cookie widens the blast
  radius of any product-session bug.
- `COMPLIANCE_REVIEWER` cannot be assigned through the public API (`UpdateUserRoleDto` only accepts
  `USER`/`ADMIN`), so compliance staffing depends on direct DB edits or the allowlist (A-05).

A dedicated system gives admins their own credential, session, revocation, audit trail and
offboarding. It also lets the admin UI and its auth slice move to a separate repository without
dragging product auth along.

## 2. Goals and non-goals

**Goals**

1. A person signs in at `/admin/sign-in` with an admin-only credential; no wallet, no social login.
2. Every `/admin` page and every admin API route re-checks an admin session server-side.
3. Admin sessions are short-lived, revocable, idle-limited, and independent of product sessions.
4. The first admin is created by an operator with infrastructure access, never through the web.
5. The auth slice is self-contained enough to extract with the admin app.
6. Legacy access remains available behind a flag during migration, then is removed.

**Non-goals**

- Changing product authentication, wallet linking, or the `User` table's role semantics.
- Adding SSO/OIDC or passkeys in the first delivery (documented as follow-ons).
- Moving money, changing KYC providers, or adding admin-triggered chain actions.
- Public self-registration, invitations by email, or password reset by email in the MVP.

## 3. Trust boundaries and assets

| Boundary | Crosses | Must hold |
| --- | --- | --- |
| Browser → web BFF (`/api/admin-auth/*`) | Admin password, TOTP code, session cookie | TLS, same-origin check, no credential in URLs or logs, HttpOnly cookie. |
| Web BFF → API (`/admin-auth/*`) | Admin token, credentials over the internal call | Service-to-service call uses the same public API base; token never reaches the browser. |
| API → PostgreSQL | Password/TOTP material, session hashes | Argon2id hashes, AES-GCM-encrypted TOTP secrets, SHA-256 token hashes, least-privilege DB role. |
| Admin session → privileged endpoints | Capability claims | API guard re-reads the admin row and capability on every request; the session token alone is not authority. |

**Assets:** admin credentials, TOTP seeds, recovery codes, admin session tokens, capability
decisions, audit records, and the admin-only endpoints (campaign decisions, programme management,
user roles, verification, advertising).

## 4. Threat model

| # | Threat | Control | Verification |
| --- | --- | --- | --- |
| T-01 | A product wallet/social session is replayed against `/admin` or `/admin/*` | Separate cookie name, separate guard, separate token table; admin endpoints reject product JWTs by shape and lookup | API test: product bearer token → 401 on `/admin/auth/me` and `/admin/*` |
| T-02 | Credential stuffing / reused passwords | Argon2id, per-account + per-IP rate limit, lockout with backoff, generic error text, dummy hash for unknown emails | Unit + integration tests for lockout, timing-safe path, enumeration |
| T-03 | Phishing a TOTP code | TOTP is phishable; accept as residual risk, add step-up re-auth for high-risk actions and plan passkeys | Documented residual; step-up test on role change |
| T-04 | TOTP replay | Store `lastTotpStep` per admin, reject a step ≤ the last accepted one | Unit test with fixed clock |
| T-05 | Session theft via XSS | HttpOnly, `Secure` in production, `SameSite=Lax`, no local/session storage, CSP, short TTL, rotation on login and privilege change | Browser test reads `document.cookie` (empty) and cookie flags |
| T-06 | CSRF on BFF login/logout | `SameSite=Lax` plus `Origin`/`Sec-Fetch-Site` check on every state-changing route, mirroring `isSameOriginRequest` | Route test with a foreign Origin → 403 |
| T-07 | Privilege escalation through admin management | Only `SUPER_ADMIN` changes roles; cannot change own role; re-auth (password + TOTP) required; audit event; API re-check | Integration tests for self-change, non-super change, stale session |
| T-08 | Stolen DB reveals usable credentials | Argon2id; TOTP secrets encrypted with `ADMIN_TOTP_ENCRYPTION_KEY` (AES-256-GCM); recovery codes hashed; session tokens hashed | Schema review + unit test that plaintext never round-trips |
| T-09 | Brute-forcing the MFA step | Login returns a single-use challenge token (5 min, hashed at rest, bound to admin + IP hash); verify attempts limited; no session before both factors | Integration test: reused, expired, wrong-admin challenge |
| T-10 | Open redirect after sign-in | Accept only return paths starting with `/admin` and not `//`; reuse the existing sanitiser pattern | Unit test for `//evil`, absolute URLs, `/d` paths |
| T-11 | Offboarded admin retains access | Suspension revokes sessions immediately; TTL 20 min; idle 10 min; “revoke all sessions” action | Integration test: suspend → existing token 401 |
| T-12 | Staging/demo leaks a real admin path | DEMO mode never calls admin auth; fixtures contain no credentials; production boot rejects default secrets; no seeded admin | Env tests + demo-mode page test |
| T-13 | Audit cannot attribute an action | Every admin API call records `adminUserId` from the session; auth events are append-only | Integration test asserts event rows |

Residual risks to accept explicitly: TOTP phishing, a compromised admin browser after session
issue, and a compromised API host (which can read TOTP secrets). Passkeys and host isolation are
follow-ons, not MVP claims.

## 5. Identity model

### 5.1 `AdminUser`

An admin is **not** a `User` row. Product users remain backers/creators; admins are staff.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(cuid())` | |
| `email` | `String @unique` | Stored lower-cased and trimmed; no display casing assumptions. |
| `displayName` | `String` | Shown in the shell and audit. |
| `passwordHash` | `String` | Argon2id encoded string (`$argon2id$...`). |
| `passwordUpdatedAt` | `DateTime` | |
| `totpSecret` | `String` | AES-256-GCM ciphertext; never returned after enrolment. |
| `totpEnabledAt` | `DateTime?` | `null` until the first valid code. |
| `lastTotpStep` | `BigInt?` | Replay guard. |
| `role` | `AdminRole` | See §5.3. |
| `status` | `AdminStatus` | `ACTIVE` or `SUSPENDED`. |
| `failedLoginAttempts` | `Int @default(0)` | Reset on success. |
| `lockedUntil` | `DateTime?` | |
| `lastLoginAt` | `DateTime?` | |
| `createdAt` / `updatedAt` | `DateTime` | Repo convention. |

### 5.2 `AdminSession` and `AdminAuthEvent`

`AdminSession`: `id`, `adminUserId`, `tokenHash @unique`, `createdAt`, `lastUsedAt`, `expiresAt`,
`revokedAt?`, `revokedReason?`, `ipHash?`, `userAgentHash?`. Index `(adminUserId, expiresAt)` and
`(expiresAt)` for cleanup. Tokens are opaque 32-byte random values, prefixed `inv_adm_`, and only
their SHA-256 hash is stored. IP and user-agent hashes are HMAC-SHA256 with
`ADMIN_HASH_PEPPER`, so a database leak cannot be dictionary-matched to a known address or browser.

`AdminAuthEvent`: `id`, `adminUserId?`, `type` (`LOGIN_SUCCEEDED`, `LOGIN_FAILED`, `MFA_FAILED`,
`MFA_REPLAY_REJECTED`, `LOCKED_OUT`, `SESSION_REVOKED`, `PASSWORD_CHANGED`, `ROLE_CHANGED`,
`RECOVERY_USED`), `createdAt`, `ipHash?`, `userAgentHash?`, `metadata Json?`. Never store
passwords, codes, tokens or TOTP secrets. This is separate from the product audit fixture/projection
because it must exist before any admin action and must survive the product audit refactor.

`AdminRecoveryCode`: `id`, `adminUserId`, `codeHash`, `usedAt?`, `createdAt`. Ten codes per admin.

### 5.3 Roles and capabilities

Keep the role set small and map it onto the capability strings already used by the web feature
helpers where possible:

| Role | Capabilities |
| --- | --- |
| `SUPER_ADMIN` | everything, including admin management and role changes |
| `OPERATOR` | campaign review, programmes, advertising, payments read, audit read |
| `REVIEWER` | verification review, campaign review read, audit read |
| `READ_ONLY` | read-only projections |

The API resolves capabilities from the role on every request. The web uses the same list only to
hide controls; it never makes the decision.

## 6. Credential handling

- **Password policy:** minimum 12 characters, maximum 256; no composition rules. A breached-password
  check is deferred until a list is chosen — do not claim it exists. Argon2id with
  `m=64 MiB, t=3, p=1` via `@node-rs/argon2` (prebuilt, no build toolchain). The encoded hash carries
  its parameters, so the cost can be raised and rehashed on the next successful sign-in. The fallback
  if the dependency is ever removed is Node's built-in `crypto.scrypt` with `N=2^15, r=8, p=1`;
  record the change in `docs/DECISIONS.md`.
- **TOTP:** RFC 6238, HMAC-SHA1, 6 digits, 30-second step, ±1 step window, implemented with
  `node:crypto`. Enrolment is CLI-only in the MVP, so no unverified secret can be enrolled through
  the web.
- **Recovery codes:** ten single-use codes, 10 characters from an unambiguous alphabet, shown once
  at creation, stored as SHA-256 hashes. Using one requires email + code + a new password, then
  issues a fresh TOTP secret on next sign-in (or requires re-enrolment).
- **Bootstrap:** `pnpm admin:create --email <address>` runs locally against the API database,
  prompts for the password without echo, prints the TOTP secret/otpauth URI and recovery codes
  once. It refuses to run when `NODE_ENV=production` unless `--confirm-production` is passed with
  an explicit operator acknowledgement. No HTTP route can create the first admin.

## 7. Session contract

| Property | Value |
| --- | --- |
| Cookie name | `inverge_admin_session` (distinct from `inverge_session` and the preview cookie) |
| Cookie flags | `HttpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/` |
| Token | Opaque, 32 random bytes, `inv_adm_` prefix, stored as SHA-256 hash |
| Absolute TTL | 20 minutes |
| Idle timeout | 10 minutes (`lastUsedAt` updated at most once per minute) |
| Rotation | New token on login and after password/role change; old token revoked |
| Revocation | Logout, suspension, password change, “revoke all”, admin deletion |
| Transport to API | Web BFF sends `Authorization: Bearer <token>`; the browser never sees the token |

Why opaque rather than a JWT: instant revocation, no second signing secret to confuse with
`SESSION_JWT_SECRET`, and no audience-mixup class of bug. The cost is one indexed lookup per admin
request, which is acceptable for this surface.

The web BFF stores the token in the cookie and attaches it server-side, following the pattern in
`features/verification/server/api.ts`. The browser never reads the token, so XSS cannot copy it.

**CSRF:** every `/api/admin-auth/*` state-changing route checks `Origin` (or
`Sec-Fetch-Site: same-origin`) and returns 403 otherwise. The existing `isSameOriginRequest`
helper lives in product auth, so the implementation must move it to a shared
`src/lib/http/origin.ts` (or copy it into the slice) rather than import product auth. Login itself
is CSRF-relevant because it can sign a victim into an attacker's account; the check applies there
too.

**Return path:** `?next=` is accepted only when it starts with `/admin`, is not `//`, and contains
no scheme. Anything else falls back to `/admin`.

## 8. API surface (Phase 2)

All routes are under `AdminAuthController` at `/admin-auth`. The product `AuthController` and
`PrivyAuthGuard` are untouched.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| `POST` | `/admin-auth/login` | `{ email, password }` | `200 { challengeToken, expiresAt }`; no session. Generic `401` for unknown email, wrong password, suspended account or locked account. |
| `POST` | `/admin-auth/mfa` | `{ challengeToken, code }` | `200 { sessionToken, expiresAt, admin: { id, email, displayName, role, capabilities } }` |
| `GET` | `/admin-auth/me` | — | `200 { admin, expiresAt }` or `401` |
| `POST` | `/admin-auth/logout` | — | `204`; revokes the presented session |

The password change, revoke-all and admin-role routes remain Phase 3 work; they are deliberately
not mounted yet.

**Challenge token:** opaque, 5-minute TTL, single use, hashed at rest, bound to the admin id and
the requesting IP hash. A failed MFA attempt counts toward the challenge limit, and the challenge
is consumed after five tries. It is never accepted as a session. A second successful password
step invalidates any challenge already outstanding for that admin.

**Error shape:** the standard API envelope `{ error: { code, message, requestId } }`, with no
field-level detail. The stable codes are `INVALID_CREDENTIALS`, `MFA_INVALID` and
`SESSION_EXPIRED`; a locked or suspended account is reported as `INVALID_CREDENTIALS`.

**Migration hooks:** `AdminSessionGuard` is implemented and resolves the admin row on every
request, checking `status === "ACTIVE"`. It is not yet attached to `/admin/*` controllers; during
coexistence both guards stay registered and `ADMIN_AUTH_ENFORCED` decides whether a product
session alone is still accepted.

## 9. Web slice and routing

New, self-contained feature slice — no imports from `features/auth` or `features/programmes`
except generic UI primitives:

```
src/features/admin-auth/
  lib/contracts.ts        # request/response types shared with route handlers
  lib/routes.ts           # sign-in path, safe return-path helper
  server/session.ts       # read/write/clear admin cookie, token from API
  server/api.ts           # BFF → API calls, bearer token, timeout + result union
  server/guard.ts         # requireAdminSession(): redirect or throw
  components/sign-in-form.tsx
  components/sign-out-button.tsx
src/app/api/admin-auth/{login,mfa,logout,session}/route.ts
```

Routing change: the admin area moves into route groups so the sign-in page is outside the gate:

```
src/app/admin/(auth)/sign-in/page.tsx
src/app/admin/(workspace)/layout.tsx   # requireAdminSession() + AdminShell
src/app/admin/(workspace)/...          # existing pages move here unchanged
```

This is a mechanical move of the current pages. Until it happens, a path allowlist in the existing
`app/admin/layout.tsx` can exempt `/admin/sign-in`, but the route-group version is preferred
because it makes the boundary structural.

**Legacy coexistence:** `ADMIN_AUTH_MODE=legacy | dedicated` on the web.

| Mode | `/admin` gate | API `/admin/*` |
| --- | --- | --- |
| `legacy` (default until cutover) | Current `getProgrammeAdminAccess` | Current `AdminGuard`; product session accepted |
| `dedicated` | `requireAdminSession()` only | `AdminSessionGuard`; product session alone rejected |
| misconfigured/unknown | Deny and show a configuration error | Boot fails in production |

`ADMIN_DEMO_MODE` remains a third, separate path. Demo mode refuses admin auth entirely: it never
renders the sign-in form and never calls `/admin-auth/*`.

## 10. Cutover plan

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| 0 | This document + decisions on hashing dependency and cookie domain | Reviewed ✅ |
| 1 | API schema, migration, pure TOTP/password/token modules, unit tests | Unit tests pass ✅; migration not yet applied; no HTTP surface yet |
| 2 | `/admin-auth/login`, `/mfa`, `/me`, `/logout`; challenge + session guards; rate limit | Integration tests: happy path, wrong password, lockout, replay, expiry, revocation |
| 3 | Web slice, route groups, `/admin/sign-in`, BFF routes, `ADMIN_AUTH_MODE=dedicated` on staging | Playwright: sign-in, MFA, sign-out, gate, mobile |
| 4 | Move the existing admin controllers/pages to `AdminSessionGuard`; delete legacy path; remove preview admin branch | Product session on `/admin/*` → 401; repository grep shows no admin route importing product auth |
| 5 | Extract admin app + `features/admin-auth` + the admin API module into the dedicated repo | Contract doc and env matrix travel with the slice |

Rollback at every phase is switching `ADMIN_AUTH_MODE=legacy`; no data migration is destructive.
Phase 4 is the point of no return for the role flag, and requires at least one working
`SUPER_ADMIN` plus one tested recovery code before it merges.

## 11. Configuration

API:

| Variable | Required | Notes |
| --- | --- | --- |
| `ADMIN_AUTH_ENFORCED` | no | default `false`; `true` after Phase 4 |
| `ADMIN_TOTP_ENCRYPTION_KEY` | when enforced | 32-byte base64 key; boot fails if missing or the wrong length |
| `ADMIN_HASH_PEPPER` | when enforced | HMAC key for IP/user-agent hashes; at least 32 characters |
| `ADMIN_SESSION_TTL_MINUTES` | no | default 20 |
| `ADMIN_SESSION_IDLE_MINUTES` | no | default 10; must be shorter than the absolute TTL |
| `ADMIN_LOGIN_MAX_ATTEMPTS` | no | default 5 |
| `ADMIN_LOGIN_LOCK_MINUTES` | no | default 15 |
| `ADMIN_ALLOWLIST` | no | bootstrap-only during migration; must be emptied at Phase 4 |

Web:

| Variable | Required | Notes |
| --- | --- | --- |
| `ADMIN_AUTH_MODE` | production | `dedicated`; `legacy` is rejected in production after cutover |
| `ADMIN_DEMO_MODE` | no | unchanged; rejected in production |

`ADMIN_AUTH_MODE` (web gate) and `ADMIN_AUTH_ENFORCED` (API guard) are separate switches and must
be flipped in the same deployment; a web-only flip would show a sign-in form while the API still
accepts product sessions. Record both in the deployment runbook.

No secret is exposed through `NEXT_PUBLIC_*`. The admin app talks only to the BFF.

## 12. Test plan

**Pure/unit (API):** TOTP window and replay, password hash/verify, challenge expiry and single use,
token hashing, lockout transitions, env validation, return-path sanitiser.

Phase 1 covers TOTP, password hashing, token/recovery helpers, secret-box encryption and env
validation. Phase 2 adds challenge expiry/single use, lockout transitions, session resolution and
revocation, guard behaviour, capabilities and rate-limit classification. The return-path
sanitiser remains part of the web slice.

Result (2026-11-14): `jest --runInBand --forceExit src/modules/admin-auth src/common/rate-limit`
→ 8 suites, 93 tests passed. `tsc --noEmit` is clean in the Phase 2 worktree. The Phase 1 and
Phase 2 migration SQL applied cleanly together inside a `BEGIN ... ROLLBACK` transaction against
Docker Postgres; `_prisma_migrations` was left unchanged. No integration test against a migrated
database has been run yet.

**Integration (API, real Postgres):** login → MFA → me → logout; wrong password and unknown email
return identical bodies; lockout; challenge reuse; TOTP replay; suspended admin; revoked session;
product JWT rejected; role change requires super admin + re-auth; every outcome writes an event.

**Web:** gate redirects without a cookie; expired cookie clears and redirects; sign-in renders no
admin navigation; BFF routes reject foreign origins; demo mode renders the unavailable notice and
never calls the API; `legacy` mode still works until cutover.

**Playwright (once installed):**

1. `/admin` unauthenticated → `/admin/sign-in?next=/admin`.
2. Wrong password → generic error, no session cookie.
3. Valid password + wrong TOTP → still no session cookie.
4. Valid password + TOTP → `/admin`, DEMO banner absent, admin identity visible.
5. Reload keeps the session; idle expiry redirects.
6. Sign-out clears the cookie and returns to sign-in.
7. Product wallet session present but no admin session → denied, no admin content in the HTML.
8. Mobile 390×844 sign-in is usable and the cookie is HttpOnly.
9. Demo mode: sign-in page is not reachable and verification shows the unavailable notice.

Browser/cookie assertions must inspect `Set-Cookie` flags, not just the rendered page.

## 13. Repo-extraction checklist

- Slice has no import from `features/auth`, `features/programmes`, or the product shell.
- Contract types live in the slice, not in route files.
- The API module owns its guards, DTOs, pure helpers and env schema fragment.
- Env names are prefixed `ADMIN_` and documented in both apps.
- The sign-in page depends only on shared UI primitives (`components/ui`) and the slice.
- Extraction requires moving: `src/app/admin`, `src/features/admin*`,
  `features/campaigns/components/admin-*`, `features/programmes/components/admin-*`, and the API's
  `admin*` modules. The contract doc names every endpoint and cookie so the new repo can be built
  without reading the product app.

## 14. Open questions

1. Should `COMPLIANCE_REVIEWER` be an admin role or a separate reviewer identity with its own
   sign-in? The current API guard treats it as a user role.
2. Is a second factor mandatory for every admin, including read-only? Current proposal: yes.
3. Do we want an IP allowlist or VPN requirement for `SUPER_ADMIN`? It changes the threat model
   for T-03 and T-05.
4. Which email provider, if any, should send recovery notifications? The MVP deliberately avoids
   email; recovery is a code + CLI reset.
5. Is `ADMIN_ALLOWLIST` retained after cutover as a documented break-glass path, or deleted?
   Recommendation: delete it from the request path and keep a CLI bootstrap only.
6. Does the dedicated repo share the API deployment or get its own? The session contract is
   designed to survive either.
