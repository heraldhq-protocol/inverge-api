# inverge-api

Backend for **Inverge** — milestone-escrowed crowdfunding & idea validation on Solana, for African builders.

This repo is **Phase 0: idea validation**. Ideas, signals, structured feedback, paid boosts, and KYC scaffolding are live. Campaign / escrow / milestone tables exist but are **inert** (schema now, logic in Phase 1/2). See `../docs/phase0-refined-plan.md` for the full plan.

## Stack

- **NestJS 11** (CommonJS) + **Prisma v7** (driver adapter, `prisma-client` generator, CJS client) + **PostgreSQL** + **Redis/BullMQ** (infra ready)
- Auth via embedded-wallet provider (Privy reference adapter); short-lived session JWTs
- **Hexagonal ports** — every external vendor sits behind a port and is selected by env, so vendors stay swappable. `stub` adapters run fully offline.

## Vendors are swappable

The **port is the contract**; the adapter is the vendor. Select per env (`stub` = offline dev):

| Env | Options | Port |
|---|---|---|
| `WALLET_PROVIDER` | `stub` \| `privy` | embedded wallet + token verify |
| `FLATFEE_PROVIDER` | `stub` \| `paystack` | boosts + application fee |
| `KYC_PROVIDER` | `stub` \| `smile` (Phase 1) | creator/backer KYC |
| `NOTIFICATION_PROVIDER` | `stub` \| `herald` | notifications |

## Getting started

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL, provider flags

# Postgres + Redis (or point .env at your own)
docker compose up -d

pnpm prisma:generate          # generate the Prisma client
pnpm prisma:migrate           # create tables (migrate dev)
pnpm db:seed                  # seed platform params (boost prices, FR-204 thresholds)

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

## Key invariants (enforced structurally)

- **FR-206a** — paid boosts never touch validation metrics. `IdeaBoost` is a separate table; `Idea.{supporterCount,prePledgeTotal,feedbackScore}` are recomputed from signals/feedback only. No boost code path writes them.
- **FR-406** — the flat-fee rail (`FlatFeeModule`) is independent of any escrow/on-ramp flow.
- **FR-803** — `OnChainEvent` is written only by the indexer (Phase 2), never by business logic.
- **FR-204** — the validation gate blocks idea→campaign conversion until thresholds clear; thresholds are admin-tunable at runtime via `PATCH /admin/params`.

## Module map

`auth` · `wallets` (+ fee-payer skeleton) · `ideas` · `boosts` · `flat-fee` · `kyc` · `sync` (idea→campaign) · `platform-params` · `admin` · `notifications` · `queue` · `ports` (adapters) · `prisma`

## Scripts

| Script | Purpose |
|---|---|
| `pnpm start:dev` | Watch-mode dev server |
| `pnpm build` | Compile to `dist/` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm prisma:generate` / `:migrate` / `:studio` | Prisma client / migrations / studio |
| `pnpm db:seed` | Seed platform params |
