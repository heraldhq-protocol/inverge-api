# Settings API

The settings screen reads one account-scoped aggregate and writes three focused
preferences. Every route requires a session (`Authorization: Bearer …`); the web
app reaches them through its BFF, never with a browser-held token.

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/me/settings` | Profile, email state, feed scope, notification preferences, verification summary, wallet link and recent support requests |
| `PUT` | `/me/settings/feed` | Topics, broad region and promoted-placement preference |
| `PUT` | `/me/settings/notifications` | Email delivery preferences |
| `POST` | `/me/settings/requests` | Data-export or account-deletion review request |
| `PATCH` | `/auth/me/profile` | Profile fields, including the new public `location` |
| `GET` | `/auth/email` | Current address, verification state, pending change and active challenge |
| `POST` | `/auth/email/request` | Send a six-digit code to an address |
| `POST` | `/auth/email/verify` | Consume a six-digit code |
| `POST` | `/auth/email/resend` | Re-send the active code after the cooldown |
| `DELETE` | `/auth/email/pending` | Cancel a pending email change |

## Invariants

- The aggregate never returns a provider subject, KYC reference, document,
  signing key or wallet private material.
- Email changes are two-phase: the new address is stored only in
  `pendingEmail` until a code proves mailbox control. Account merging never
  happens automatically.
- Codes are six digits, stored only as an HMAC with a server-side pepper, expire
  after the configured TTL, are single-use, and are bounded by per-user hourly
  and attempt limits.
- `showPromoted=false` removes paid placement from that account's feed. It does
  not change any organic score.
- Notification preferences gate **email** delivery only. The in-app row is still
  written, so preferences never hide account history.
- A deletion request is auditable and human-reviewed. It is not an immediate
  hard delete: active contributions, refunds and campaign obligations must be
  resolved first.

## Feed region

`region` is one of `global`, `africa`, `west-africa`. `global` stores no region
tilt. `africa` is a broad tilt over the Africa-focused catalogue.
`west-africa` expands to the recognised West African markets in the ranker; it
remains a bounded multiplier, never a filter.

## Email delivery

`EMAIL_PROVIDER=resend` sends both verification codes and notification email.
`EMAIL_PROVIDER=stub` writes the rendered message to `.local/email-outbox` and
is refused when `NODE_ENV=production`. The web app labels a preview session as
read-only and does not claim a save.

## Verification

- `src/modules/settings/settings.service.spec.ts` — aggregate projection, region
  mapping, duplicate-request handling.
- `src/modules/auth/email/email-verification.service.spec.ts` — issuance,
  hashing, cooldown, attempts, change and delivery failure.
- `src/ports/notification/notification-email.spec.ts` — template rendering and
  HTML escaping.
