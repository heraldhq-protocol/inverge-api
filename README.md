# inverge-api

Backend for **Inverge** — milestone-escrowed crowdfunding & idea validation on Solana, for African builders.

This repo is **Phase 0: idea validation**. Live today: ideas, a structured pitch + quality scoring, supporter/pre-pledge signals with weighted "estimated interest", creator-built surveys + comments, paid boosts, creator insights, a policy-moderation harness, and full **identity verification (KYC / AML / KYB)** via Didit. Campaign / escrow / milestone tables exist but are **inert** (schema now, logic in Phase 1/2). See `../docs/phase0-refined-plan.md` for the full plan.

## Stack

- **NestJS 11** (CommonJS) + **Prisma v7** (driver adapter, `prisma-client` generator, CJS client) + **PostgreSQL** + **Redis/BullMQ** (metric snapshots + async screening)
- Auth via embedded-wallet provider (Privy reference adapter); short-lived session JWTs
- **Hexagonal ports** — every external vendor sits behind a port and is selected by env, so vendors stay swappable. `stub` adapters run fully offline.

## Vendors are swappable

The **port is the contract**; the adapter is the vendor. Select per env (`stub` = offline dev):

| Env | Options | Port |
|---|---|---|
| `WALLET_PROVIDER` | `stub` \| `privy` | embedded wallet + token verify |
| `FLATFEE_PROVIDER` | `stub` \| `paystack` | boosts + application fee |
| `KYC_PROVIDER` | `stub` \| `didit` | identity verification (KYC / AML / KYB) |
| `NOTIFICATION_PROVIDER` | `stub` \| `herald` | notifications |
| `QUALITY_PROVIDER` | `stub` \| `claude` | idea quality scoring (FR-271) |
| `MODERATION_PROVIDER` | `stub` \| `ai` | policy classifier (FR-1003) |

## Identity verification — KYC / AML / KYB (Didit)

One provider serves both products; the **purpose** selects the Didit workflow (set the workflow ids + webhook secret in `.env` — see `.env.example`):

| Purpose | Workflow | Result | Used for |
|---|---|---|---|
| `IDEA_VALIDATION` | KYC (ID + liveness + face) | `kycStatus` | grants the VERIFIED pre-pledge tier |
| `CAMPAIGN_CREATOR` / `BACKER_THRESHOLD` | KYC + AML | `kycStatus` + `amlStatus` | funds handlers (FR-103 / FR-104) |
| `BUSINESS_VERIFICATION` | KYB (registry + docs + directors/UBOs + AML) | `kybStatus` + business `amlStatus` | a business that creates / backs campaigns |

- **Two eligibility bars:** *identity-verified* = KYC VERIFIED (enough for the idea-validation tier); *funds-eligible* = KYC/KYB VERIFIED **and** AML CLEAR. A user may be funds-eligible as an individual **or** as a business.
- **Webhook security:** `/kyc/webhook` verifies the HMAC signature *and* the service re-fetches the decision from the provider, so a spoofed callback can never set a false status. KYB decisions route to the `BusinessProfile` by ref.
- **AML records** are retained off-chain (NFR-19); raw identity documents are never stored (NFR-12) — only provider refs + status.
- Surfaces: `/kyc/*` (status, session, eligibility, admin AML screen + history) and `/kyb/*` (business status, session, eligibility, admin AML). AML sanctions also feed the moderation harness (an AML-FLAGGED submitter is held).

## Getting started

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL, provider flags, DIDIT_* (if using didit)

# Postgres + Redis (or point .env at your own)
docker compose up -d

pnpm prisma:generate          # generate the Prisma client
pnpm prisma:migrate           # create tables (migrate dev)
pnpm db:seed                  # seed platform params (boost prices, FR-204 thresholds, kyc threshold)

pnpm start:dev                # http://localhost:3000  — OpenAPI docs at /docs
```

> Note: `prisma migrate dev` does not always auto-run the seed under Prisma v7 — run `pnpm db:seed` explicitly after the first migration.

## Auth in stub mode

No Privy needed for local dev. Exchange a stub token for a session:

```bash
curl -X POST localhost:3000/auth/session \
  -H 'Content-Type: application/json' \
  -d '{"accessToken":"stub:did-alice:alice@example.com"}'
# -> { user, sessionToken }   then send: Authorization: Bearer <sessionToken>
```

With `KYC_PROVIDER=stub`, `GET /kyc/dev-complete?ref=<ref>&user=<id>` simulates a finished verification so the whole flow runs offline.

## Key invariants (enforced structurally)

- **FR-206a** — paid boosts never touch validation metrics. `IdeaBoost` is a separate table; `Idea.{supporterCount,prePledgeTotal,feedbackScore}` are recomputed from signals/survey responses only. No boost code path writes them.
- **FR-406** — the flat-fee rail (`FlatFeeModule`) is independent of any escrow/on-ramp flow.
- **FR-803** — `OnChainEvent` is written only by the indexer (Phase 2), never by business logic.
- **FR-204** — the validation gate blocks idea→campaign conversion until thresholds clear; thresholds are admin-tunable at runtime via `PATCH /admin/params` (audited).
- **FR-1007** — AML tipping-off: a sanctions-related hold shows a generic external reason; full detail stays internal.

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
