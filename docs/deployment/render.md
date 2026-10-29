# Render setup guide — `inverge-api`

Status: **guide only.** No Render service exists in this repository and no deployment was
performed during this audit. `render.yaml` is **absent**; every service must be created in
the dashboard (or you can commit a blueprint once the values below are agreed).

Repository: `github.com/<your-org>/inverge-api`
Deployment target: the NestJS API. The web app is not deployed to Render; the escrow
programme is not a Render service.

---

## 1. Service topology

| Service | Type | Purpose | Required |
|---|---|---|---|
| `inverge-postgres-staging` | Render Postgres (or an external managed Postgres) | Staging database | Yes |
| `inverge-redis-staging` | Render Key Value / Redis | Cache, rate limits, BullMQ | Yes for auth/admin/financial rate limits and queues |
| `inverge-api-staging` | Render Web Service (Node) | Staging API | Yes |
| `inverge-postgres` / `inverge-redis` / `inverge-api` | Same, production | Only after the launch gates in `docs/audit/release-readiness.md` | Later |

**Do not create a separate worker service.** BullMQ processors run in the API process
(`QueueModule` + feature modules). There is no worker entry point; a second service would
just run another API. If a dedicated worker is wanted later, that is a code change.

Create the database and Redis **in the same region** as the web service. The API talks to
them over Render's private network.

---

## 2. Web service settings

| Setting | Value | Evidence / reason |
|---|---|---|
| Repository | `<your-org>/inverge-api` | Separate repository |
| Branch | `main` | Local checkout is 7 commits behind `origin/main` |
| Root directory | repository root | `package.json`, `prisma/schema.prisma`, `src/main.ts` |
| Runtime | Node | No Dockerfile exists |
| Node version | `22` (verify in the build log) | CI runs Node 22 (`.github/workflows/ci.yml:36`); Prisma 7 supports it |
| Region | same as Postgres/Redis | Private networking and latency |
| Build command | see §2.1 | |
| Start command | `node dist/main` | `dist/main.js` is the compiled entry (verified locally) |
| Health check path | `/health/ready` | `src/modules/health/health.controller.ts:47`; outside `/api/v1` (`src/bootstrap.ts:15-19`) |
| Auto-deploy | on, from `main` | |
| Persistent disk | none | No local file storage is used |

### 2.1 Build and start commands

The API's `package.json` has **no `packageManager` and no `engines` field** (unlike the web
repo). A Render build that assumes npm will fail on `pnpm-lock.yaml`. Pin pnpm explicitly:

```bash
npm install -g pnpm@12.3.4 && pnpm install --frozen-lockfile && pnpm prisma:generate && pnpm build
```

Start:

```bash
node dist/main
```

Why each step is required:

- `pnpm install --frozen-lockfile` — reproduces `pnpm-lock.yaml`; no drift.
- `pnpm prisma:generate` — the Prisma client is generated into `src/generated/prisma`, which
  is gitignored (`.gitignore:11`). `nest build` compiles it into `dist/generated`. Skipping
  this step makes the build fail on missing imports.
- `pnpm build` — `nest build`, output `dist/main.js`.
- `NODE_ENV` must **not** be `production` during install/build if you rely on dev
  dependencies (`@nestjs/cli`, `prisma`, `ts-node`). Render installs dev dependencies by
  default for the build; do not set `NODE_ENV=production` as a build-time variable.

**Follow-up (recommended, not done):** add `"packageManager": "pnpm@12.3.4"` and
`"engines": { "node": ">=22 <23" }` to `inverge-api/package.json`. That lets Render's
Corepack path work without the global install, and matches the web repository's convention.
Also fix `pnpm-workspace.yaml`: its `allowBuilds` values are the literal string
`set this to true or false` instead of booleans. It installs today, but it is an unfilled
template and may silently skip Prisma/esbuild build scripts on a clean machine. Set explicit
booleans (`prisma: true`, `@prisma/engines: true`, `esbuild: true`).

### 2.2 Migrations and seed

There is no migration hook in the repository. Choose one of:

1. **Render pre-deploy command** (paid instances): `pnpm prisma:deploy`
2. **Manual, before each deploy** from a Render shell or a machine with `DATABASE_URL`
   pointed at staging: `pnpm prisma:deploy`.

Then seed once:

```bash
pnpm db:seed
```

The seed upserts platform parameters and taxonomy with `update: {}`, so re-running it does
not overwrite admin-tuned values.

Ordering: migrations must complete **before** the new API instance starts serving. A service
that boots against an old schema will fail its first query. If you cannot use a pre-deploy
command, deploy with the previous instance kept live, run migrations, then deploy.

Verified facts: 27 migrations exist under `prisma/migrations/`; `prisma migrate deploy` is
the documented production command (`package.json`, `README.md`). The full e2e job applies
them on a clean database in CI (`ci.yml:117-124`).

Not verified: that the current migration set applies cleanly to a brand-new Render Postgres
from this machine. Run it against the staging database and keep the output.

---

## 3. Environment variables

Use the generated staging file as the source:

```bash
# in inverge-api
node scripts/init-staging-env.mjs
```

It writes `inverge-api/.env.staging` and `inverge-web/.env.staging.local`, minting the JWT,
analytics HMAC, metrics token and log salt once. Both files are gitignored
(`.gitignore:13-18`). Fill every `__TODO_*__` marker from the provider dashboards, then copy
the values into Render's Environment tab. If your Render dashboard offers a bulk `.env`
import, use it; otherwise add variables one by one. Never upload the file to a public place.

### 3.1 Required for the service to boot

| Variable | Staging value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Enables production checks. Do **not** use `development` on a reachable host |
| `DATABASE_URL` | Render Postgres **internal** URL | Secret |
| `REDIS_URL` | Render Redis **internal** URL | Secret if it embeds a password |
| `SESSION_JWT_SECRET` | generated | Unique to staging; boot fails if left at the default or shorter than 32 characters |
| `REDIS_ENABLED` | `true` | |
| `QUEUE_ENABLED` | `true` | Set as a real environment variable: it is read before `.env` is loaded |

### 3.2 Required for the staging feature set

| Variable | Staging value | Notes |
|---|---|---|
| `TRUST_PROXY_HOPS` | `1` | Render terminates TLS; rate-limit keys depend on it |
| `WALLET_PROVIDER` | `web3auth` | |
| `WEB3AUTH_CLIENT_ID` | staging client id | Must equal the web's `NEXT_PUBLIC_WEB3AUTH_CLIENT_ID` |
| `KYC_PROVIDER` | `didit` | |
| `DIDIT_API_KEY` | staging key | Secret |
| `DIDIT_KYC_WORKFLOW_ID` | identity-only workflow | |
| `DIDIT_KYC_AML_WORKFLOW_ID` | identity + AML workflow | |
| `DIDIT_KYB_WORKFLOW_ID` | business KYB workflow | |
| `DIDIT_WEBHOOK_SECRET` | staging webhook secret | Secret |
| `DIDIT_CALLBACK_URL` | `https://<staging-web>/d/settings/verification` | A page that exists; the old `/kyc/callback` example never existed |
| `ADMIN_ALLOWLIST` | operator email or provider id | Bootstraps the first admin |
| `EMAIL_PROVIDER` | `resend` | `stub` is rejected when `NODE_ENV=production` |
| `RESEND_API_KEY` | sending-only key | Secret; domain-restricted |
| `EMAIL_FROM` | sender on a verified domain | Not `onboarding@resend.dev` outside local testing |
| `EMAIL_FROM_NAME` | `Inverge` | |
| `EMAIL_REPLY_TO` | monitored mailbox | Optional but recommended |
| `EMAIL_CODE_SECRET` | 32+ random characters | Secret; unique per environment |
| `ANALYTICS_INGEST_ENABLED` | `true` | |
| `ANALYTICS_INGEST_SECRET` | generated | Secret; identical to the web |
| `METRICS_TOKEN` | generated | Secret; otherwise `/metrics` is public |
| `LOG_HASH_SALT` | generated | |
| `LOG_FORMAT` | `json` | |
| `CORS_ORIGINS` | empty | Correct for a web-only deployment |

> With `KYC_PROVIDER=didit` and `NODE_ENV=production`, the API **will not boot** until all
> five Didit values are present. Create the three workflows first. This is deliberate
> fail-closed behaviour (`src/config/env.validation.ts:235-251`).
>
> Email follows the same rule: with `NODE_ENV=production` and
> `EMAIL_PROVIDER=resend`, boot fails until `RESEND_API_KEY` and `EMAIL_FROM` are set,
> and `EMAIL_CODE_SECRET` must be at least 32 characters. The current Resend account has
> no verified domain, so arbitrary recipients cannot receive mail yet. See
> [email.md](email.md).

### 3.3 Payment rail

`FLATFEE_PROVIDER=paystack` with a **test** key (`sk_test_...`) is the staging default.
`PAYSTACK_WEBHOOK_SECRET` is required because staging runs `NODE_ENV=production`; the API
refuses to boot without it. If you do not have a test key yet, do not switch staging to
`FLATFEE_PROVIDER=stub` — production configuration rejects it (F-01). Use a non-production
environment for offline work.

Both boosts and the campaign application fee reach this rail. An authenticated
creator calls `POST /campaigns/:id/application-fee`; the API charges the configured
NGN price through the selected provider, stores the checkout URL on the charge, and
binds the charge to the campaign in its metadata before returning the URL. A
successful webhook makes the FR-311 submit gate pass. The charge is non-refundable,
and a second request resumes the existing pending checkout or returns the succeeded
charge instead of charging again (audit F-02 resolved 2026-10-28). The web wizard
calls this route through its server-side BFF; the browser never receives the
provider secret or chooses the amount.

### 3.4 Solana / escrow

Keep `ESCROW_CHAIN_PROVIDER=disabled` for the first staging deploy. `SOLANA_RPC_URL` may be
set to `https://api.devnet.solana.com`. Turning the provider on before the programme is
deployed produces `CHAIN_NOT_CONFIGURED` (503) — see the deployment report §10 for the
keypair/programme-id mismatch that blocks that step.

### 3.5 Not required / do not set

| Variable | Why |
|---|---|
| `PORT` | Render injects it |
| `FEE_PAYER_SECRET_KEY` | Declared but unread; `FeePayerService` throws `NotImplemented` |
| `PRIVY_*` | Legacy adapter; the current web client uses Web3Auth |
| Notification gateway | No external notification gateway exists; in-app rows use the offline stub. Transactional email is separate (`EMAIL_PROVIDER`). |
| `ANTHROPIC_API_KEY` | Only needed if `MODERATION_PROVIDER=ai` |
| `DIRECT_URL` | Only needed behind a pooler |

---

## 4. Webhooks to register after the first deploy

The service URL is not known until Render creates it. Once it does:

| Provider | URL | Secret to configure there |
|---|---|---|
| Didit | `https://<service>.onrender.com/api/v1/verification/webhook` | `DIDIT_WEBHOOK_SECRET` |
| Didit (legacy facade) | `https://<service>.onrender.com/api/v1/kyc/webhook` | same |
| Paystack | `https://<service>.onrender.com/api/v1/flat-fee/webhook` | `PAYSTACK_WEBHOOK_SECRET` (or the secret key) |

Both routes verify HMAC over the raw body, re-fetch the authoritative decision/transaction,
and deduplicate through `WebhookReceipt`. A wrong secret returns 401 and the provider retries.
Provider dashboards must use `/api/v1`; the old unprefixed paths 404.

Health and docs:

- `GET /health/live` → `{ status: "ok" }` (process only)
- `GET /health/ready` → 200 with `checks.database: "up"`; 503 when Postgres is down
- `GET /docs` → Swagger UI (public in production; see §7)
- `GET /metrics` → requires `Authorization: Bearer <METRICS_TOKEN>` when set

---

## 5. Deployment order

1. Create the Postgres and Redis instances; record their internal URLs.
2. Create the web service with the build/start commands and the environment from §3.
3. Run `pnpm prisma:deploy` against staging; then `pnpm db:seed`.
4. Deploy the API; watch the boot log for `Invalid environment variables`, then
   `Prisma connected`.
5. Verify `/health/live` and `/health/ready`.
6. Register the Didit and Paystack webhook URLs.
7. Point the Vercel Preview `INVERGE_API_URL` at this service.
8. Run the staging checks in `docs/deployment/testing-checklist.md`.

Do not enable `ESCROW_CHAIN_PROVIDER=solana-rpc`, real payments, or `SOLANA_CLUSTER=mainnet-beta`
in staging.

---

## 6. Cold starts and timeouts

- Render free instances sleep after a period of inactivity (platform behaviour; verify on
  your plan). A sleeping API means the first request pays a cold start.
- The web's read client times out at **5 s** (`inverge-web/src/lib/api/server.ts:44`); the
  auth exchange times out at **10 s** (`src/app/api/auth/session/route.ts:37`).
- Didit and Paystack treat a slow/failed callback as retryable, but a cold start can lose the
  first delivery.
- For a staging environment used for webhook testing, use an always-on instance or keep it
  warm. This is an operational recommendation, not a code defect.

---

## 7. Known gaps that affect Render

| Gap | Impact | Evidence |
|---|---|---|
| ~~Stub security providers~~ | **Resolved 2026-10-28 (Phase A).** Production boot rejects stub wallet/KYC/flat-fee providers; each stub refuses every operation in production | `src/config/env.validation.ts:230-248`, `src/ports/stub-guard.ts`; audit F-01 |
| ~~`/kyc/dev-complete` reachable~~ | **Resolved 2026-10-28.** The route is a non-disclosing 404 unless the environment is non-production and the provider is the stub | `src/modules/kyc/kyc.controller.ts:75-100` |
| ~~`WEB3AUTH_CLIENT_ID` not boot-validated~~ | **Resolved 2026-10-28.** Boot fails when web3auth is selected without it | `src/config/env.validation.ts:254-259` |
| `/metrics` is public by default | Telemetry disclosure | `src/common/telemetry/metrics.controller.ts:32-56` |
| `/docs` Swagger is always mounted | API surface disclosure | `src/main.ts:16` |
| No `render.yaml` | No reproducible infrastructure; manual drift between staging and production | repository root |
| No `packageManager`/`engines` in `package.json` | Render build depends on a hand-written pnpm install step | `package.json` |
| `allowBuilds` values are placeholder strings | Clean builds may skip Prisma/esbuild postinstall steps | `pnpm-workspace.yaml:1-7` |
| No separate worker/cron | Background work stops if the API stops; no independent scaling | `src/modules/queue/queue.module.ts` |
| No backup/restore or retention policy configured | NDPA/privacy and recovery risk | audit F-19 |
| Web admin is denied in production | KYC/campaign review cannot be operated from the web | audit F-05 |

The remaining rows are still operational and security gaps, but the production boot path no
longer permits the stub auth/KYC/payment modes that were the worst class of risk.

---

## 8. Verification commands (safe to run after deploy)

```bash
# Process is alive
curl -fsS https://<service>.onrender.com/health/live

# Database reachable (503 if not)
curl -fsS https://<service>.onrender.com/health/ready

# API contract is served
curl -fsS -o /dev/null -w '%{http_code}\n' https://<service>.onrender.com/docs

# Metrics require the token once set
curl -fsS -o /dev/null -w '%{http_code}\n' https://<service>.onrender.com/metrics          # expect 401
curl -fsS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $METRICS_TOKEN" \
  https://<service>.onrender.com/metrics                                                   # expect 200

# A public read that needs no session
curl -fsS 'https://<service>.onrender.com/api/v1/ideas?limit=1' | head -c 400
```

Expected: `live` returns `{"status":"ok",...}`; `ready` returns `checks.database: "up"` and
`checks.redis: "up"`; `/docs` is 200; `/metrics` is 401 without the token and 200 with it.

None of these calls uses real funds or personal data.
