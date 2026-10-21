# Webhooks

Status: **partly implemented**. Two provider callbacks exist; there is no outbound
webhook product, no retry queue and no delivery log.

## Inbound (implemented)

| Provider | Route (v1) | Verification | Idempotency |
|---|---|---|---|
| Paystack (application fees) | `POST /api/v1/flat-fee/webhook` | `x-paystack-signature` HMAC over the raw body | Provider reference |
| Didit (KYC/AML/KYB) | `POST /api/v1/kyc/webhook` | HMAC over the raw body, headers passed to the adapter | Provider session/decision id |

Both handlers read `req.rawBody`, which is why the application is created with
`rawBody: true`. A signature computed over re-serialised JSON is not a signature;
the raw bytes are the only valid input.

### Rules that must hold

1. **Verify before parsing.** A body that fails verification returns `401` and is
   never applied.
2. **Re-fetch the authoritative decision** (Didit) or the transaction (Paystack)
   before changing local state. A webhook is a notification, not a proof.
3. **Be idempotent.** Providers retry. Applying the same event twice must not
   double-credit a fee or move a KYC status twice. Use the provider event or
   reference id as the key.
4. **Respond fast.** Acknowledge with `200` after the durable write. Slow work
   (notifications, analytics) is queued, not awaited.
5. **Never trust the payload's user.** Resolve the local record from the provider
   reference, then verify the user it belongs to.
6. **No secrets in logs.** Log the provider event id and outcome, not the body.

### Version note

These routes moved to `/api/v1` in the same change that introduced the prefix.
Provider dashboards must be updated to the new URL before deploying; a callback to
the old path will 404 and the provider will retry until it gives up.

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
