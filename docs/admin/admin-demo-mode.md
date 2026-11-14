# Admin demo mode

- **Flag:** `ADMIN_DEMO_MODE`
- **Default:** off
- **Allowed values:** `true` | `false` (unset = off)
- **Production:** rejected by the environment schema and by the access gate
- **Scope:** `/admin/*` in `inverge-web` only
- **Status:** implemented; browser verification not run (see §6)

## 1. Why this exists

The admin workspace is mostly fixtures and browser-local stores. That was honest in
development but implicit: any non-production build with `INVERGE_AUTH_MODE=preview`
synthesised a `platform_admin` identity and rendered the full fixture shell. Nothing
distinguished "this is a demo" from "this is an operator looking at stale data", and the
verification pages inside the same shell *do* call the real API.

Demo mode replaces that implicit path with one explicit, testable capability.

## 2. Guarantees

| Guarantee | How it is enforced |
| --- | --- |
| Off by default | `resolveAdminDemoMode` returns `{ enabled: false }` when the flag is unset, empty or `false`. |
| Explicit | Only the exact string `true` enables it. |
| Rejected in production | `src/lib/env/schema.ts` fails validation when `NODE_ENV=production` and the flag is `true`; `resolveAdminDemoMode` throws as defence in depth. |
| No silent fallback | Malformed values (`1`, `yes`, `TRUE`, `on`) throw `AdminDemoModeError`; they are never read as "off". |
| Server-enforced | The flag is read from `process.env` by server modules. It is not `NEXT_PUBLIC_*` and never reaches the browser bundle. |
| Visible | The shell renders a persistent **DEMO DATA** banner (`data-testid="admin-demo-banner"`), a sidebar "Demo access" card, and a "Demo · not persisted" pill. |
| No real writes | Demo mode takes precedence over a session, so the demo shell cannot inherit a real admin identity. Every API-backed admin page must check `adminDemoModeEnabled()` before calling the API. |
| No simulated regulated state | Verification review is replaced with an unavailable notice. There are no demo KYC cases, payments, contributions, escrow, email sends or chain events. |

## 3. Behaviour matrix

| `NODE_ENV` | `ADMIN_DEMO_MODE` | Session | Result |
| --- | --- | --- | --- |
| any | unset / `false` | none | Redirect to sign-in. |
| any | unset / `false` | non-admin | Access-denied screen naming the required role. |
| any | unset / `false` | `ADMIN` | Authorised admin shell; API-backed pages work. |
| any | unset / `false` | preview (dev only) | Preview shell; local writes only. |
| development / test | `true` | any or none | Demo shell, demo operator identity, DEMO DATA banner, no admin API calls. |
| production | `true` | any | Environment validation fails; the app does not boot. |
| any | malformed | any | Environment validation fails; the access gate also denies with the configuration message. |

Demo mode deliberately outranks a signed-in session. A developer who is also a real admin
still gets the demo shell, because mixing a real identity with fixture data is exactly the
ambiguity this flag removes. Turn the flag off to act as the real admin.

## 4. What demo mode does not do

- It does not seed a database.
- It does not impersonate a real user.
- It does not approve KYC, move money, send email, or touch the chain.
- It does not make the fixture decisions authoritative. The campaign review store remains
  `localStorage`; the banner says so.
- It does not enable a shared staging environment. Preview/staging should use real auth and
  seeded records.

## 5. Fixture inventory

`src/features/admin/demo/dataset.ts` is the single typed entry point:

```ts
type AdminDemoDataset = {
  advertisingCreatives: readonly AdCreative[];
  auditEntries: readonly AuditEntry[];
  campaigns: readonly Campaign[];
  programmes: readonly Programme[];
};
```

The records stay in their owning feature modules, so a fixture cannot drift from its domain
type. Deliberately absent from the dataset: KYC cases, payment ledgers, contributions,
escrow state, email deliveries and chain events.

Current scale: 11 campaigns, 5 programmes, 3 seeded campaign review statuses
(`in-review`, `changes-requested`, `not-submitted`), and the advertising creatives used by
the public slots.

Every fixture-reading admin route resolves its records through `getAdminDemoDataset()`:
overview, campaign queue, campaign detail, programmes list, programme workspace, new
programme (duplicate source), audit, and payments. The advertising workspace is the one
exception: its browser store is hydrated once from `previewAdCreatives`, which is the same
array the dataset exposes, so the inventory is still described centrally even though the
page does not pass it as a prop.

## 6. Verification

### 6.1 Commands and results

| Command | Result | Note |
| --- | --- | --- |
| `npx vitest run src/features/admin/lib/demo-mode.test.ts src/lib/env/schema.test.ts --pool=threads --no-file-parallelism` | **Partial** | `src/lib/env/schema.test.ts` ran, 5/5 passed. The `demo-mode.test.ts` worker timed out (`Timeout waiting for worker to respond`) and the run exited 1. Vitest 5 is unreliable under the installed Node `v22.14.0`; `inverge-web/package.json` requires `>=24.21.0 <25`. |
| `pnpm typecheck` | **Passed** | `next typegen` generated route types; `tsc --noEmit` emitted no errors. |
| `pnpm exec prettier --write <changed files>` | Applied | Files formatted. |
| `pnpm exec eslint "src/app/admin" "src/features/admin" "src/lib/env/schema.ts"` | **Passed** | Completed with no findings before the proxy fix. A later single-file ESLint run timed out; not reported as passed. |
| Playwright package | **Not installed** | `pnpm add -D @playwright/test` failed under a Windows file lock on `next`. The cached `playwright-core@1.65.0` was used directly instead. |
| Browser smoke | **Passed** (2026-11-13) | `ADMIN_DEMO_MODE=true pnpm dev`, then a scripted Edge run (cached `playwright-core@1.65.0`): all seven admin routes returned 200 with the DEMO DATA banner, seven desktop nav links, no real console/page errors, and the verification route showed the demo-unavailable notice. Mobile 390×844 had the banner, mobile nav and no horizontal overflow. This is a smoke pass, not the full 13-scenario suite. |

### 6.1a Proxy exception found by the browser pass

`src/proxy.ts` redirected every protected path without a session cookie to `/auth` before the
layout could call `getProgrammeAdminAccess()`. Demo mode was therefore unreachable without a
preview sign-in, despite its documented precedence. The proxy now lets `/admin` and `/admin/*`
through the early redirect when `adminDemoModeEnabled()` is true; the layout remains the
authorisation decision, and the resolver still fails closed in production and on malformed
values.

### 6.2 Unit coverage that was written

`src/features/admin/lib/demo-mode.test.ts` covers: unset, empty, `false`, `true` in
development, `true` in test, malformed values, `true` in production, and the
`adminDemoModeEnabled` wrapper.

`src/lib/env/schema.test.ts` adds: demo accepted outside production, rejected in production,
and a malformed value rejected. It ran successfully under the partial Vitest invocation in §6.1
(5/5). The `demo-mode.test.ts` cases remain unexecuted until the Node version is raised to the
repository's engine range.

### 6.3 Browser scenarios

Thirteen scenarios, split into demo UI and real API integration. Accessible selectors first;
`data-testid` only where an accessible name is ambiguous.

| # | Group | Scenario | Primary selector |
| --- | --- | --- | --- |
| 1 | Demo UI | `/admin` shows the DEMO DATA banner and the demo identity | `getByTestId("admin-demo-banner")`, `getByRole("status")` |
| 2 | Demo UI | Navigation contains all seven sections with the current one marked | `getByRole("navigation", { name: "Admin sections" })`, `aria-current="page"` |
| 3 | Demo UI | Overview shows fixture counts and the "Not connected" list | headings "Operating overview", "Not connected" |
| 4 | Demo UI | Campaign queue lists campaigns by review state | `getByTestId("admin-nav-campaigns")` then row heading |
| 5 | Demo UI | Opening a campaign shows pitch, milestones, disclosures and preconditions | heading role with the campaign title |
| 6 | Demo UI | A change request with a short reason is rejected client-side | radio group "Review decision", alert text |
| 7 | Demo UI | A valid decision is recorded locally and says it was not sent to the API | `getByRole("status")` containing "not been sent to the API" |
| 8 | Demo UI | Audit page shows fixture entries and the role matrix | heading "Role permissions" |
| 9 | Demo UI | Advertising approval moves a creative to approved and appends a local event | creative row + "Approve" button |
| 10 | Demo UI | Programme wizard creates a local draft; list shows it after reload | heading "Programmes", draft title |
| 11 | Demo UI | `/admin/verification` shows the demo-unavailable notice | `getByTestId("admin-demo-unavailable")` |
| 12 | Demo UI | Mobile 390×844: banner, mobile nav and content remain usable | `browser_resize` equivalent viewport |
| 13 | Real API | With the flag off and an `ADMIN` session: verification queue, case detail and resolve call the API; decision conflicts surface | `getByRole("alert")`, network log |

Scenarios 1–12 require only the web app and the demo flag. Scenario 13 requires a running
API, PostgreSQL, Redis and an `ADMIN` (or `COMPLIANCE_REVIEWER`) session; it must not run
against demo data.

### 6.4 Typecheck result

Run from `inverge-web`:

```powershell
pnpm typecheck
```

Result: **passed** on 2026-11-11. `next typegen && tsc --noEmit` completed with no
diagnostics. This is a type-level check only; it does not prove the demo branch renders or
that the banner is visible.

## 7. Playwright setup (smallest viable)

Playwright is absent. Do not claim a run until these steps succeed.

```powershell
# from inverge-web
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

`playwright.config.ts` (root of `inverge-web`):

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        env: { ADMIN_DEMO_MODE: "true" },
      },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
```

Run:

```powershell
# demo UI suite
$env:ADMIN_DEMO_MODE="true"; pnpm exec playwright test e2e/admin/demo.spec.ts

# real API suite (separate project/file; never demo mode)
$env:ADMIN_DEMO_MODE="false"; $env:INVERGE_API_URL="http://localhost:3001"; pnpm exec playwright test e2e/admin/api.spec.ts
```

Add `e2e/` and `playwright-report/` to `.gitignore` only if the team does not want test
artifacts committed; the specs themselves should be committed.

### 7.1 Selector contract

Stable hooks added for these tests:

| Selector | Location |
| --- | --- |
| `admin-demo-banner` | `AdminShell` demo banner |
| `admin-demo-unavailable` | verification pages in demo mode |
| `admin-nav-overview` … `admin-nav-audit` | desktop admin navigation |
| `admin-nav-mobile-overview` … `admin-nav-mobile-audit` | mobile admin navigation |

Everything else should use roles, labels and visible text. Do not add `data-testid` to every
element; it becomes a second, untyped API.

## 8. Operating it

```powershell
# enable locally
$env:ADMIN_DEMO_MODE = "true"
pnpm dev
# open http://localhost:3000/admin
```

```powershell
# disable
Remove-Item Env:ADMIN_DEMO_MODE
```

On Vercel/Render, do not set the variable at all. If it is set to `true` in a production
environment, the build/start fails with an `ADMIN_DEMO_MODE` validation error.

## 9. Removing demo mode later

Demo mode is a bridge, not a destination. Remove it when:

1. Campaign review and programme operations read and write the API.
2. Verification has its own capability-gated surface.
3. The remaining fixture pages are either API-backed or deleted.

At that point delete `features/admin/lib/demo-mode.ts`, the dataset module, the banner
branch in `AdminShell`, the verification guards, the env field and the tests.

## 10. Open questions

1. Should demo mode also pin the fixture dataset version, so a screenshot can be reproduced
   after fixtures change? Current answer: no, fixtures are static and typed.
2. Should preview auth be folded into demo mode? Both grant fixture access in development.
   Keeping two paths is the remaining ambiguity in `admin-audit.md` A-01.
3. Should the demo banner state the record counts it is showing? It would make the boundary
   obvious, but couples the shell to the dataset. Not done.
