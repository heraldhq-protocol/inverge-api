# Notifications

Status: **implemented (Stage 4)**. Persisted in-app notifications with retryable
delivery. The read API is under `/api/v1/me/notifications`; there is no public
notification surface.

## Routes

| Route | Purpose |
|---|---|
| `GET /api/v1/me/notifications` | Cursor page for the signed-in user. `limit` (default 24, max 50), `cursor`, `unreadOnly` (`true`/`false`/`1`/`0`). |
| `GET /api/v1/me/notifications/unread-count` | Badge count (`{ count }`). |
| `PATCH /api/v1/me/notifications/:id/read` | Marks one row read. Idempotent; another user's id is `404`. |
| `POST /api/v1/me/notifications/read-all` | Marks every unread row read (`{ updated }`). |

All four require a session (`PrivyAuthGuard`) and use the `dashboard` rate-limit
policy (60/min, burst 20, per user). The list uses the standard `{ data, page }`
envelope and keyset pagination on `(createdAt, id)` descending; the cursor is
fingerprinted to the user and `unreadOnly`, so it cannot be replayed across
accounts or filters.

## Write path

`NotificationsService.notify()` writes the row first and dispatches second:

1. Insert `Notification` with `userId`, `template`, `data`, and an optional
   `dedupeKey`. A duplicate `dedupeKey` (`P2002`) is a no-op.
2. If queues are enabled, enqueue the `notification-dispatch` job on the shared
   `inverge-jobs` queue with a stable `jobId` (`notification:<id>`) and five
   exponential-backoff attempts.
3. If the enqueue fails, dispatch inline once. If queues are disabled entirely
   (tests, a web-only replica), dispatch inline.
4. The worker calls the notification port and records `dispatchedAt`,
   `dispatchAttempts` and `lastDispatchError`. A vendor failure throws so BullMQ
   retries; an already-dispatched row is a no-op.

The domain action never fails because a notification could not be written or
delivered: the failure is logged, and the durable row (when it exists) can be
retried.

`WAITLIST_CONVERSION` uses `WAITLIST_CONVERSION:<campaignId>:<userId>` so a
replayed campaign conversion does not alert a supporter twice.

## Data

`data` is template input only (`ideaId`, `campaignId`, numeric/string fields).
Do not put emails, wallet addresses, KYC payloads, free text or provider
responses in it. The row has no IP address, user agent or session identifier.

## Configuration

| Variable | Effect |
|---|---|
| `QUEUE_ENABLED` | `false` registers no Worker; the service dispatches inline. |
| `NOTIFICATION_PROVIDER` | `stub` (offline log) or `herald` (reference adapter). |
| `REDIS_URL` | Queue transport. The queue is optional infrastructure. |

The only notification adapter is the offline stub. It records the dispatch and
logs the template/user id; it does not send email or wallet push. There is no
external notification gateway in this repository.

## Verification

- `src/modules/notifications/notifications.service.spec.ts` — persist before
  enqueue, duplicate dedupe key, inline fallback, vendor failure recorded without
  failing the caller, worker retry contract, pagination, ownership `404`,
  idempotent read, read-all.
- `test/notifications.e2e-spec.ts` — session required, caller isolation, newest
  first, unread filter and badge, invalid boolean, cursor walk, idempotent
  single read, cross-user `404`, read-all.

The e2e suite needs the `20261022234500_notifications` migration applied. It passed
6/6 against a disposable PostgreSQL 16 container with every committed migration
applied; the local Windows developer database still needs `prisma migrate deploy`
after its service is started.

## Deferred

- No real delivery adapter; `dispatchedAt` means the stub adapter call resolved,
  not that a person read an in-app row.
- No user preference or unsubscribe model yet. Muting belongs with the read model
  once the web exposes settings.
- No admin trigger to replay a failed notification; a failed job is retained in
  BullMQ (`removeOnFail: 1000`).
