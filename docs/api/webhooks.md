# Webhooks

Status: **partly implemented**. Two provider callbacks exist with a durable inbox
and replay policy. There is no outbound webhook product or delivery log.

## Inbound (implemented)

| Provider | Route (v1) | Verification | Idempotency |
|---|---|---|---|
| Paystack (application fees) | `POST /api/v1/flat-fee/webhook` | `x-paystack-signature` HMAC over the raw body | `WebhookReceipt` on `PAYSTACK:<reference>:<status>` |
| Didit (verification, entity, transaction) | `POST /api/v1/webhooks/didit` | `X-Signature-V2` / `X-Signature` / `X-Signature-Simple` HMAC over the raw body, then freshness on the signed body `timestamp` | `WebhookReceipt` on `DIDIT:<event_id>`; `DiditWebhookEvent` ledger |
| Resend (email delivery) | `POST /api/v1/webhooks/resend` | Svix `svix-signature` HMAC-SHA256 over `id.timestamp.rawBody`, then a 300 s timestamp tolerance | `WebhookReceipt` on `RESEND:<svix-id>`; status merge on `EmailDelivery` |

Resend events update the email delivery ledger (`DELIVERED`, `BOUNCED`,
`COMPLAINED`, `DELAYED`, `FAILED`) and add a `HARD_BOUNCE` or `COMPLAINT`
suppression. Status is monotonic: a late `delivered` never reopens a bounce, and a
hard bounce wins even if the send was previously marked delivered. `email.opened`
and `email.clicked` are acknowledged and ignored. See `docs/email-system.md`.

The legacy Didit routes (`/api/v1/verification/webhook` and `/api/v1/kyc/webhook`)
remain mounted as aliases. All three handlers read `req.rawBody`, which is why the
application is created with `rawBody: true`. A signature computed over re-serialised
JSON is not a signature; the raw bytes are the only valid input.

Supported Didit families: `status.updated`, `data.updated`, `user.status.updated`,
`user.data.updated`, `business.status.updated`, `business.data.updated`,
`activity.created`, `transaction.created`, `transaction.status.updated`. Session
events update `VerificationCase`; entity, activity and transaction events are written
to `DiditWebhookEvent` for durable state and audit. The ledger stores no raw body,
only its SHA-256 and non-identifying routing metadata.

### Rules that must hold

1. **Verify before applying.** A body that fails verification returns `401` and is
   never applied. `X-Signature-V2` necessarily parses JSON to reproduce Didit's
   canonical form, but no parsed field is trusted until a signature matches.
2. **Freshness comes from the signed body.** Didit's `X-Timestamp` header is not
   covered by any signature; a replay can refresh it. Reject when
   `abs(now - body.timestamp) > 300`.
3. **Re-fetch the authoritative decision** (Didit session events) or the transaction
   (Paystack) before changing local state. A webhook is a notification, not a proof.
4. **Be idempotent.** Providers retry. Applying the same event twice must not
   double-credit a fee or move a KYC status twice. Didit keys on `event_id`; the
   fallback is resource id + status + webhook type.
5. **Respond fast.** Acknowledge with `200` after the durable write. Slow work
   (notifications, analytics) is queued, not awaited.
6. **Never trust the payload's user.** Resolve the local record from the provider
   reference, then verify the user it belongs to.
7. **No secrets or identity data in logs.** A rejected delivery logs its event id,
   byte length and a truncated SHA-256 for correlation, never the body.

### Version note

These routes moved to `/api/v1` in the same change that introduced the prefix.
Provider dashboards must be updated to the new URL before deploying; a callback to
the old path will 404 and the provider will retry until it gives up.

### Durable inbox (implemented)

The handlers call `WebhookInboxService.run()` **after** signature verification
and **before** applying the event. The receipt is the unit of replay:

| Column | Why |
|---|---|
| `provider`, `dedupeKey` | Unique per normalized event. Paystack uses the charge reference and status; Didit uses `event_id`. |
| `payloadHash` | SHA-256 of the raw body for support correlation. The body itself is never stored, so KYC documents and account data never enter the table. |
| `eventType` | Normalized status only. |
| `status` | `PENDING` → `PROCESSING` → `PROCESSED` or `IGNORED`; a thrown apply sets `FAILED`. |
| `attempts`, `lastError`, `lockedAt` | Retry and crash diagnostics. The error is truncated to 500 characters. |

The claim is a compare-and-set `updateMany`: exactly one concurrent retry moves
the row to `PROCESSING`; the others return `{ inProgress: true }` without applying.
A row already `PROCESSED` or `IGNORED` returns `{ replayed: true }` without
reapplying. A `FAILED` row can be retried by the next provider delivery. A
`PROCESSING` row whose worker died is reclaimable after five minutes.

The unique `(provider, dedupeKey)` constraint is the concurrency backstop; a
create race falls back to the existing row. Effects must still be idempotent at the
domain layer — the inbox prevents double-apply, it does not replace the domain
checks.

## Outbound (not built)

There is no public webhook subscription product. When one is added:

- Endpoints are registered per user or per organisation and are visible/revocable.
- Payloads are signed with a per-endpoint secret (`X-Inverge-Signature:
  t=<timestamp>,v1=<hmac>`), and the signature covers the timestamp and the exact
  body.
- Delivery is at-least-once with exponential backoff and a bounded retry window.
  Receivers must dedupe on the event id.
- A delivery log records status codes and timings, never the secret.
- Events describe committed state only. A `contribution.pending` event is not sent
  from a button click; it is sent when the indexer or provider confirms.
- An endpoint that fails consistently is disabled after warning the owner, rather
  than retried forever.

## Queue behaviour

Background work runs on BullMQ. The connection is lazy (`lazyConnect: true`), so an
unreachable Redis does not hang process start; the first job operation surfaces the
failure. Queue handlers must be idempotent for the same reason webhooks must be:
BullMQ guarantees at-least-once, not exactly-once.

## Things that are deliberately absent

- No inbound webhook for chain events. Chain state enters through the indexer only
  (FR-803); a public endpoint that writes `OnChainEvent` would break that invariant.
- No provider callback that can move escrow funds. The program does that, not this
  API.
