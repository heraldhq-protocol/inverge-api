# Real-time updates

Status: **decision recorded; nothing is implemented**. There is no WebSocket
server, no SSE endpoint, and no long-lived connection code in either repository.

## Decision

Do **not** add WebSockets or SSE in the current stage. Serve dynamic surfaces with
request-time rendering plus polling where freshness matters, and reconcile against
authoritative state before any financial action.

This is a choice, not an omission. The evidence:

1. **No real-time product requirement is live.** The campaign detail page has a
   funding counter, but contributions cannot be made yet: there is no escrow
   program, no indexer and no contribution endpoint. A live counter would animate
   fixture data.
2. **Correctness already comes from reconciliation, not push.** Chain-owned state
   must be re-read before a tranche release or refund. A socket message can never
   be the authority, so a socket would add a second path to the same data without
   removing the authoritative read.
3. **Scale does not justify it.** A campaign page is not a chat room; the data
   changes on the order of seconds to minutes, and polling one endpoint per open
   page is cheaper than holding a connection and fanning out invalidations.
4. **Operational cost is real.** Sticky sessions or a Redis pub/sub fan-out,
   reconnect/backoff on the client, auth on the upgrade request, and a new class of
   failure during deploys. None of that buys a user-visible improvement today.

## What to do instead

| Surface | Approach |
|---|---|
| Campaign funding total | Server-render the indexed projection with `asOf`; client polls every 15 s only while the tab is visible |
| Milestone status changes | Poll on the campaign detail route; invalidate on the user's own mutation |
| Notifications | Poll a summary endpoint on focus; no badge over a socket |
| Admin review queue | Poll every 30 s; SSE only if an admin explicitly needs sub-second intake |
| Contribution confirmation | Never optimistic. Poll the indexed status until confirmed, then reconcile with a chain read |

TanStack Query is installed for the client cache and polling lifecycle. Its
`refetchInterval` with `refetchIntervalInBackground: false` is the mechanism; no
custom socket layer is introduced.

## When SSE would become justified

Revisit when **all** of these are true:

- A real, measured staleness problem exists (users act on figures older than a
  minute and get a wrong outcome), not an assumed one.
- The authoritative read is fast enough that push is the only gain, and the pushed
  value is advisory with an `asOf`.
- The deployment supports long-lived connections (proxy timeouts, no per-request
  CPU billing surprise), and auth on connect is solved.

SSE before WebSockets: it is one-way, survives HTTP infrastructure, and reconnects
with `Last-Event-ID`. WebSockets only if bidirectional interaction (presence,
collaborative editing) becomes a requirement — neither is in scope.

## If push is added later

- The stream carries an event id and `asOf`; the client fetches authoritative state
  after any gap.
- Authorisation is checked on connect and re-checked on every event the connection
  is entitled to; a role change closes the stream.
- No user-specific payload is put on a shared channel.
- A dropped connection is a normal state with a visible "reconnecting" indicator,
  never a silent stale number.
