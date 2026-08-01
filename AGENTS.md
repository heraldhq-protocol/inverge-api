# Agent context — inverge-api

Read `README.md` first: stack, swappable vendor ports, the KYC/AML/KYB model, getting started, and the
structurally enforced invariants (FR-206a, FR-406, FR-803, FR-204, FR-1007). This file holds what the
README does not: the open backlog and the gotchas that have cost time in this repo before.

## Open work

- **`docs/web-ui-api-gaps.md`** — nineteen additive API gaps raised by the `inverge-web` product
  screens, with proposed shapes, the invariants each must respect, the tests each needs, an
  at-a-glance table and a suggested order. Items 1 and 2 (public creator identity, comment author
  projection) are **blocking web work that is otherwise ready to build**. Start there if you are
  picking up backend work with no other steer.
- **The campaign surfaces are built and running on fixtures.** `inverge-web` has a campaign catalogue,
  a seven-tab campaign detail page and a five-step creator flow, none of which call this API — not
  even `POST /ideas/:id/convert`, which is live. They are built against a written contract
  (`inverge-web/docs/campaign-data-contract.md`), so item 6 turns them on by changing one file. Two
  things in that contract are worth reading before you implement anything campaign-shaped:
  - **Milestone state is derived, not stored** (contract §3), and
  - **the escrow split uses two different bases** (contract §2a, gap item 18): the working-capital
    tranche is a share of `targetAmount`, every milestone tranche is a share of
    `totalRaised - upfront`, and the two sum to exactly `totalRaised`. Pegging the upfront to the
    raise pays a campaign that overfunded ten times over more before verification than its whole plan
    was worth. Settle this before the escrow programme hard-codes something else.
- KYC/AML follow-ups (prod webhook registration, FR-103/104 gate call-sites on campaigns and
  contributions, ongoing AML monitoring, admin IN_REVIEW review actions, geo/wallet L1 gates) are
  tracked outside this repo in the session backlog, not here.

## Conventions that are load-bearing

- **Pure logic is separated from services and unit-tested in isolation.** `pledge-weighting.ts`,
  `insights-compute.ts`, `moderation-routing.ts`, `survey-validation.ts`, `shingle.ts` are the pattern:
  no I/O, no Nest decorators, exhaustively tested. New scoring, routing or derivation logic goes in a
  pure module, not inside a service method.
- **Every external vendor sits behind a port** in `src/ports/` and is selected by env, with a `stub`
  adapter that runs fully offline. Do not import a vendor SDK outside its adapter.
- **Validation metrics are recomputed, never incremented in place**, and no boost or payment code path
  may touch them (FR-206a). This is structural: keep it that way.
- **`OnChainEvent` is written only by the indexer** (FR-803). Business logic never writes it.
- Off-chain moderation output is advisory (NFR-17) and never auto-rejects (D1).
- Vendor credentials live in `.env` only. `.env` is gitignored and must stay that way; never commit a
  key, and never put one in a doc or a commit message.

## Gotchas verified in this repo

- **Prisma v7 migrate flow.** `--to-schema-datamodel` was removed; `--from-config-datasource` is a bare
  flag. Full flow: `migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script >
  prisma/migrations/<ts>_<name>/migration.sql`, then `migrate deploy`. Chaining diff with generate has
  timed out and written an **empty** migration that `deploy` still recorded as applied; if that
  happens, delete the orphan `_prisma_migrations` row with raw SQL (`migrate resolve --rolled-back`
  will not touch a non-failed migration), regenerate the diff, and deploy again.
- **Standalone Prisma scripts need a driver adapter.** `new PrismaClient({ adapter: new PrismaPg({
  connectionString: process.env.DATABASE_URL }) })`, importing the client from
  `dist/generated/prisma/client.js` with `dotenv/config` loaded. v7 rejects adapterless construction.
- **`prisma migrate dev` does not reliably run the seed** under v7. Run `pnpm db:seed` explicitly.
- **Windows: `pnpm exec` / `pnpm <cmd>` can hit EBUSY** renaming `pnpm-lock.yaml` while an editor holds
  it. Call binaries directly instead: `node ./node_modules/@nestjs/cli/bin/nest.js build`,
  `node ./node_modules/prisma/build/index.js ...`, `node ./node_modules/tsx/dist/cli.mjs ...`.
- **`nest build` output shifts to `dist/src/`** if any `.ts` file sits unexcluded at the project root
  (rootDir creep). `tsconfig.build.json` excludes `_*.ts`, `prisma.config.ts` and `prisma/` for that
  reason; keep dev helpers named `_*.ts` and keep them excluded.
- **Registering a BullMQ queue makes the app connect to Redis at boot.** The snapshot scheduler's
  `onModuleInit` is deliberately resilient (try/catch plus a short timeout) so a Redis-down box cannot
  crash boot. Preserve that if you add queues.
- Commit in small segments, one logical change each, and do not add a Claude co-author trailer.
