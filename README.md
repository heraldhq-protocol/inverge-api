# inverge-api

Backend for **Inverge** — milestone-escrowed crowdfunding & idea validation on Solana, for African builders.

This repo is **Phase 0: idea validation**. Live today: ideas, a structured pitch + quality scoring, supporter/pre-pledge signals with weighted "estimated interest", creator-built surveys + comments, paid boosts, creator insights, a policy-moderation harness, and full **identity verification (KYC / AML / KYB)** via Didit. Campaign / escrow / milestone tables exist but are **inert** (schema now, logic in Phase 1/2) — note
that the *web* campaign screens are already built against a written contract and waiting on them, see
**Open backlog**. See `../docs/phase0-refined-plan.md` for the full plan.

## Stack

- **NestJS 11** (CommonJS) + **Prisma v7** (driver adapter, `prisma-client` generator, CJS client) + **PostgreSQL** + **Redis/BullMQ** (metric snapshots + async screening)
- Auth via an embedded-wallet provider — **MetaMask Embedded Wallets (Web3Auth)** for the web
  client, with Privy kept as a legacy adapter — verified server-side against the provider's JWKS;
  short-lived session JWTs
- **Hexagonal ports** — every external vendor sits behind a port and is selected by env, so vendors stay swappable. `stub` adapters run fully offline.

## Vendors are swappable

The **port is the contract**; the adapter is the vendor. Select per env (`stub` = offline dev):

| Env | Options | Port |
|---|---|---|
| `WALLET_PROVIDER` | `stub` \| `privy` \| `web3auth` | embedded wallet + token verify |
| `FLATFEE_PROVIDER` | `stub` \| `paystack` | boosts + application fee |
| `KYC_PROVIDER` | `stub` \| `didit` | identity verification (KYC / AML / KYB) |
| `EMAIL_PROVIDER` | `stub` \| `resend` | transactional email / verification codes |
| `QUALITY_PROVIDER` | `stub` \| `claude` | idea quality scoring (FR-271) |
| `MODERATION_PROVIDER` | `stub` \| `ai` | policy classifier (FR-1003) |
| `AI_PROVIDER` | `disabled` \| `stub` \| `anthropic` | Creator Studio assistant (see `docs/ai-assistant.md`) |

The moderation classifier and the Creator Studio assistant share `AI_API_KEY`, `AI_BASE_URL` and `AI_MODEL`. Set `AI_API_KEY` when either `MODERATION_PROVIDER=ai` or `AI_PROVIDER=anthropic`.

## Identity verification — KYC / AML / KYB (Didit)

One provider serves both products; the **purpose** selects the Didit workflow (set the workflow ids + webhook secret in `.env` — see `.env.example`):

| Purpose | Workflow | Result | Used for |
|---|---|---|---|
| `IDEA_VALIDATION` | KYC (ID + liveness + face) | `kycStatus` | grants the VERIFIED pre-pledge tier |
| `CAMPAIGN_CREATOR` / `BACKER_THRESHOLD` | KYC + AML | `kycStatus` + `amlStatus` | funds handlers (FR-103 / FR-104) |
| `BUSINESS_VERIFICATION` | KYB (registry + docs + directors/UBOs + AML) | `kybStatus` + business `amlStatus` | a business that creates / backs campaigns |

- **Two eligibility bars:** *identity-verified* = KYC VERIFIED (enough for the idea-validation tier); *funds-eligible* = KYC/KYB VERIFIED **and** AML CLEAR. A user may be funds-eligible as an individual **or** as a business.
- **One verification domain owns the decision.** `/verification/*` is the current surface: `state`, `eligibility`, hosted `session`s, business KYB, `contributions/authorize`, the provider `webhook`, and the compliance-review admin routes. It stores normalised `VerificationCase` rows plus an append-only `VerificationEvent` history; provider strings live only in the adapter. `/kyc/*` and `/kyb/*` remain as a compatibility facade with the old payload shapes (their `reasons` is the new `blockers`).
- **Business ≠ representative.** A business account is funds-eligible only when KYB, business AML, key people **and** the account holder's personal identity are all approved, so switching to a business account cannot bypass the personal check.
- **Webhook security:** `/verification/webhook` (and legacy `/kyc/webhook`) verifies the signature against the raw body / canonical form per header scheme, bounds the timestamp, re-fetches the decision from the provider, and deduplicates on the provider event reference, so a spoofed, replayed or out-of-order callback cannot set a false status. Heavy work is queued when `QUEUE_ENABLED`; a reconciliation sweep covers missed callbacks with bounded, jittered retries and then escalates to a human.
- **Gates:** campaign submission (`POST /campaigns/:id/submit`) and the FR-104 cumulative backer threshold (`POST /verification/contributions/authorize`, serialised per user with an advisory lock) both call this domain. Refusals carry a stable `code` (see `verification-errors.ts`) so the web never parses prose.
- **AML records** are retained off-chain (NFR-19); raw identity documents are never stored (NFR-12) — only provider refs, statuses, feature codes and screening aggregates. A non-clear screening routes to the compliance queue; it never auto-declines, and only a permission-controlled reviewer can resolve it, with a recorded reason.
- Surfaces: `/verification/*` (creator + compliance) with `/kyc/*` and `/kyb/*` kept for older clients. AML sanctions also feed the moderation harness (an AML-FLAGGED submitter is held).

## Getting started

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL, provider flags, DIDIT_* (if using didit)

# Postgres + Redis (or point .env at your own)
docker compose up -d

pnpm prisma:generate          # generate the Prisma client
pnpm prisma:migrate           # create tables (migrate dev)
pnpm db:seed                  # seed platform params (boost prices, FR-204 thresholds, kyc threshold)

pnpm start:dev                # http://localhost:3000/api/v1 — OpenAPI docs at /docs
```

> Note: `prisma migrate dev` does not always auto-run the seed under Prisma v7 — run `pnpm db:seed` explicitly after the first migration.

The API is versioned in the path. Every route lives under `/api/v1`; the committed
contract is `docs/api/openapi.json` and the conventions (errors, auth, pagination,
caching, rate limits) are documented in [`docs/api/README.md`](docs/api/README.md).
Provider webhook URLs must include the prefix.

## Email verification

Account emails are nullable and carry a separate ownership timestamp. The API
issues a single-use six-digit code (10-minute TTL, hashed at rest, resend
cooldown, attempt and hourly caps) and gates authored actions on it. Idea support
and pre-pledges stay open. See [`docs/api/email-verification.md`](docs/api/email-verification.md)
for routes, error codes and the guard matrix, and
[`docs/deployment/email.md`](docs/deployment/email.md) for Resend/DNS setup and
the current delivery caveat.

Production requires `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, a sender on a
verified domain, and a 32+ character `EMAIL_CODE_SECRET`. Local development uses
`EMAIL_PROVIDER=stub`, which writes rendered messages to `.local/email-outbox/`
and never logs the code.

## Auth in stub mode

No provider needed for local dev (`WALLET_PROVIDER=stub`). Exchange a stub token for a session:

```bash
curl -X POST localhost:3000/api/v1/auth/session \
  -H 'Content-Type: application/json' \
  -d '{"accessToken":"stub:did-alice:alice@example.com"}'
# -> { user, sessionToken, suggestedEmail }   then send: Authorization: Bearer <sessionToken>
#
# The stub email fixture is unverified. Append #verified to simulate a provider
# that signed an email_verified claim:
#   "stub:did-alice:alice@example.com#verified"
```

With `KYC_PROVIDER=stub`, `GET /api/v1/kyc/dev-complete?ref=<ref>&user=<id>` simulates a finished verification so the whole flow runs offline.

## Key invariants (enforced structurally)

- **FR-206a** — paid boosts never touch validation metrics. `IdeaBoost` is a separate table; `Idea.{supporterCount,prePledgeTotal,feedbackScore}` are recomputed from signals/survey responses only. No boost code path writes them.
- **FR-406** — the flat-fee rail (`FlatFeeModule`) is independent of any escrow/on-ramp flow.
- **FR-803** — `OnChainEvent` is written only by the indexer (Phase 2), never by business logic.
- **FR-204** - the validation gate blocks idea→campaign conversion until thresholds clear; thresholds are admin-tunable at runtime via `PATCH /api/v1/admin/params` (audited).
- **FR-1007** — AML tipping-off: a sanctions-related hold shows a generic external reason; full detail stays internal.

## Open backlog

`docs/web-ui-api-gaps.md` — nineteen additive gaps raised by the `inverge-web` product screens (idea
feed, idea detail, the campaign catalogue, campaign detail and the creator campaign flow), with
proposed shapes, the invariants each must respect, the tests each needs, an at-a-glance table and a
suggested order. Items 1 and 2, public creator identity and a comment author projection, currently
**block web work that is otherwise ready to build**. `AGENTS.md` carries the repo conventions and the
Prisma v7 / Windows gotchas.

**The campaign UI is built and none of it calls this API.** The web app has a campaign catalogue, a
seven-tab detail page and a five-step creator flow, all running on fixtures behind one flag, written
against `inverge-web/docs/campaign-data-contract.md`. Gap item 6 (`GET /campaigns`, `GET
/campaigns/:id`) turns them on. Before implementing anything campaign-shaped, read that contract's §2a
on how the money splits — the working-capital tranche is fixed at 20% of the **target**,
and every milestone weight is a share of the **raise less that tranche**, with the last
milestone absorbing the remainder. Getting it backwards is a money bug rather than a
rendering one (gap item 18, web D-045).

## Module map

`auth` (+ admin RBAC guard) · `wallets` (+ fee-payer skeleton) · `ideas` · `boosts` · `flat-fee` · `kyc` (KYC/AML **+ KYB**) · `metrics` (pre-pledge weighting, snapshots, insights) · `moderation` (policy harness + dedup) · `quality` (FR-271 scoring) · `survey` (surveys + comments) · `sync` (idea→campaign) · `platform-params` (+ audit) · `admin` · `notifications` · `queue` · `ports` (adapters) · `prisma`

## Testing

Unit tests run fully offline (stub adapters + mocks). E2E runs against real Postgres + Redis and forces the stub identity provider.

```bash
pnpm test            # unit (219 tests)
pnpm test:e2e        # e2e vs real Postgres/Redis (77 tests)
```

## Scripts

| Script | Purpose |
|---|---|
| `pnpm start:dev` | Watch-mode dev server |
| `pnpm build` | Compile to `dist/` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` / `test:watch` / `test:e2e` | Unit / watch / end-to-end suites |
| `pnpm prisma:generate` / `:migrate` / `:deploy` / `:studio` | Prisma client / migrations / studio |
| `pnpm db:seed` | Seed platform params |
