# Admin audit and roadmap

Audit date: **2026-11-11**. Repository state: `inverge-web` (Next.js 16) and
`inverge-api` (NestJS + Prisma) as present in this worktree.

## Documents

| Document | Purpose |
| --- | --- |
| [`admin-audit.md`](./admin-audit.md) | Evidence-based matrix of every admin route, API status, permission model, tests and gaps. Includes access-control findings and the P0–P3 summary. |
| [`admin-missing-features.md`](./admin-missing-features.md) | Proposed features grouped into six areas, each with an eleven-field brief. |
| [`admin-api-integration-plan.md`](./admin-api-integration-plan.md) | Endpoint-by-endpoint plan, marked Existing or Proposed, with the shared data layer and migration sequence. |
| [`admin-demo-mode.md`](./admin-demo-mode.md) | The `ADMIN_DEMO_MODE` contract, safety guarantees, fixture inventory, and the Playwright plan. |
| [`admin-auth.md`](./admin-auth.md) | Dedicated admin authentication: identity, session contract, threat model, API shapes, cutover and extraction plan. **Phase 1 implemented** (schema, migration, pure modules); no HTTP surface or web slice yet. |

## Headline findings

1. **The admin UI is a well-labelled prototype.** Seven of nine admin route groups render
   typed fixtures and write to `localStorage`. Only verification review calls the real API.
2. **The backend is further ahead than the UI.** Campaign review, programme administration,
   platform params, boost prices, users, analytics, email and moderation endpoints exist and
   are unused by `/admin`.
3. **The most dangerous page is `/admin/payments`.** It presents fixture prize and sponsor
   totals on a page an operator would reasonably read as a ledger.
4. **Milestone claims and objections have no review surface at all.** `MilestoneClaim`,
   `MilestoneObjection` and the unused `ReviewerRuling` model exist, and creators can submit
   claims. This is the largest product gap.
5. **Access control has two paths.** A real `ADMIN` session is authoritative through the API.
   Preview auth can also render the fixture shell in development. Demo mode makes the second
   path explicit, default-off, and impossible in production.

## P0–P3 summary

### P0 — fix before calling the admin workspace operational

- Explicit demo mode, default off, rejected in production, visible DEMO DATA banner. **Done.**
- Dedicated admin authentication, separate from wallet/social product accounts. **Phase 1
  implemented in [`admin-auth.md`](./admin-auth.md): schema, migration and pure credential modules.
  The HTTP surface, web slice and cutover are still open.** Today a product sign-in is always
  `role: USER`, so no normal account can open `/admin` without a DB promotion or the allowlist.
- Do not call verification APIs or render compliance controls in demo mode. **Done for demo;
  actor-based hiding is still open.**
- Campaign review decisions must reach `POST /admin/campaigns/:id/review`.
- `/admin/payments` must stop showing unlabelled fixture money.
- Milestone claim and objection review.

### P1 — operational workspace

- API-backed campaign review reads and writes.
- API-backed programme list, create/edit, entries, judging, results.
- Users and roles page; suspension endpoint.
- Platform params and boost-price page.
- Global audit projection.
- Verification capability gating and paging.
- Contributions and escrow read model.

### P2 — completeness

- Advertising API and admin.
- Idea/content moderation queue.
- Analytics admin and access requests.
- Email editorial admin.
- Notification broadcast.
- Media moderation.

### P3 — polish

- Taxonomy write.
- Saved views, bulk actions, exports.
- Cross-domain search.

Detailed reasoning and evidence are in [`admin-audit.md`](./admin-audit.md) §8.

## Phased delivery plan

| Phase | Content | Exit criteria |
| --- | --- | --- |
| 0 | Shared server-side admin client and result type | No bearer token in the browser; missing API URL renders a configured error |
| 1 | Campaign review over the API | Two browsers agree; conflicts surface; local store removed from the real path |
| 2 | Payments page relabel/removal | No unlabelled fixture money anywhere |
| 3 | Programme list and create/edit | A created programme is publicly readable |
| 4 | Programme entries, judging, prizes, sponsors, results | Full programme run without local state |
| 5 | Users, params, boost prices, global audit | Privileged changes are UI-driven and audited |
| 6 | Milestone rulings | Claims queue with reasoned, append-only rulings |
| 7 | Contributions/escrow read model, verification hardening | Reconciliation view; no automated money movement |
| 8 | Advertising, moderation, analytics, email, notifications | Each domain complete or its page removed |

Each phase must be independently revertible and must leave demo mode untouched.

**Parallel track — admin authentication.** The phases above assume a working admin session. They
can proceed with the legacy path, but the dedicated identity in
[`admin-auth.md`](./admin-auth.md) must land before the workspace is called operational and before
the UI/repo split. Its cutover is flag-gated, so it does not block campaign-review wiring.

## Files changed in this pass

Documentation:

- `docs/admin/README.md`
- `docs/admin/admin-audit.md`
- `docs/admin/admin-missing-features.md`
- `docs/admin/admin-api-integration-plan.md`
- `docs/admin/admin-demo-mode.md`

Implementation:

- `inverge-web/src/features/admin/lib/demo-mode.ts` — pure flag resolver and error type.
- `inverge-web/src/features/admin/lib/demo-mode.test.ts` — unit coverage (written; worker unrun).
- `inverge-web/src/proxy.ts` — let demo-mode admin requests reach the layout instead of being
  redirected to product sign-in (found by the browser pass).
- `inverge-web/src/features/admin/demo/dataset.ts` — typed central fixture entry point.
- `inverge-web/src/features/admin/components/admin-demo-unavailable.tsx` — demo notice for
  compliance surfaces.
- `inverge-web/src/features/programmes/server/access.ts` — demo branch and `demo` flag on
  the access result.
- `inverge-web/src/features/programmes/components/admin-shell.tsx` — DEMO DATA banner,
  sidebar and pill wording.
- `inverge-web/src/features/programmes/components/admin-navigation.tsx` — stable
  `data-testid` hooks for desktop and mobile navigation.
- `inverge-web/src/app/admin/verification/page.tsx` — refuse API calls in demo mode.
- `inverge-web/src/app/admin/verification/[id]/page.tsx` — same for case detail and resolve.
- `inverge-web/src/app/admin/{page,audit/page,payments/page,programmes/page,programmes/[id]/page,programmes/new/page,campaigns/page,campaigns/[id]/page}.tsx`
  — read fixtures through `getAdminDemoDataset()` instead of importing preview modules
  directly.
- `inverge-web/src/lib/env/schema.ts` — `ADMIN_DEMO_MODE` validation and production
  rejection.
- `inverge-web/src/lib/env/schema.test.ts` — schema coverage (written, unrun).
- `inverge-web/.env.example` — documented flag.

No production environment, payment, escrow, KYC provider, email provider or chain code was
modified.

## Verification record

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `cd inverge-web && pnpm typecheck` | **Passed**: `next typegen` succeeded and `tsc --noEmit` emitted no errors. |
| Format | `pnpm exec prettier --write <changed files>` | Applied; files formatted. |
| Lint | `npx eslint "src/app/admin" "src/features/admin" "src/lib/env/schema.ts"` | **Passed**: no findings. |
| Unit | `npx vitest run src/features/admin/lib/demo-mode.test.ts src/lib/env/schema.test.ts --pool=threads --no-file-parallelism` | **Partial**: `src/lib/env/schema.test.ts` ran and 5/5 tests passed; the second file's worker timed out (`Timeout waiting for worker to respond`) and the run exited 1. Vitest 5 is unreliable under the installed Node `v22.14.0`; the repo requires Node `>=24.21.0 <25`. |
| API unit (admin auth) | `cd inverge-api && node ./node_modules/jest/bin/jest.js --runInBand src/modules/admin-auth src/config/env.validation.spec.ts` | **Passed**: 5 suites, 82 tests. Covers Argon2id, RFC 6238 vectors, replay, token hashing, AES-GCM, env validation. |
| API typecheck (admin auth) | `cd inverge-api && node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **Partial**: new files are clean; the only diagnostic is pre-existing `_programme-fixture.ts` (`criterionId` not in `TieBreakRule`). |
| API migration | `prisma migrate status`; then the SQL piped to `docker exec -i inverge-postgres psql` inside `BEGIN … ROLLBACK` | **Not applied**: host port 5432 is held by a native PostgreSQL process, so the container is unreachable from the host. The SQL generated from Prisma's diff applies cleanly and rolls back, but `_prisma_migrations` is unchanged. |
| Build | `pnpm build` | Not run; Node version is outside the engine range and a production build would also require the configured env. |
| Playwright | `pnpm exec playwright test` | **Not run**: `@playwright/test` install failed under a Windows file lock on `next`. No config/spec was committed. |
| Browser smoke | scripted Edge run using cached `playwright-core@1.65.0`, `ADMIN_DEMO_MODE=true pnpm dev` | **Passed** (2026-11-13): seven admin routes, DEMO DATA banner, seven desktop nav links, verification demo notice, mobile 390×844, no horizontal overflow, no real console/page errors. Smoke only, not the full 13-scenario suite. |

No check is reported as passed unless it ran. The remaining gaps are the unexecuted
`demo-mode.test.ts`, the full Vitest suite, the production build, the committed Playwright
suite/specs, and scenarios 5–13 of the browser plan (the smoke pass covered the seven routes and
mobile shell, not the interactions).

## Unresolved product questions

1. Should verification review live under `/compliance` rather than `/admin`? It uses
   `COMPLIANCE_REVIEWER`, a different role from `ADMIN`.
2. What exactly is `/admin/payments`? Sponsor invoices, prize fulfilment, escrow balances and
   contribution receipts are different ledgers.
3. Is one global append-only audit table required, or is a read-only projection over the
   existing three acceptable?
4. Who may review campaigns: platform admins only, or organisers for their own programme?
5. What is the `ADMIN_ALLOWLIST` break-glass policy, and must its use appear in the audit log?
6. Should preview auth be retired once demo mode is the only fixture path?
7. Should demo mode ever be available on a shared staging deployment? Current answer: no.

## Next three tasks

1. Wire campaign review reads and writes to the existing API (Phase 1).
2. Relabel or remove `/admin/payments` (Phase 2).
3. Raise the local Node version to the engine range, then run the unit suite and the
   Playwright demo scenarios.
