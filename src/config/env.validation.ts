import { z } from 'zod';

// Provider selection keeps vendors swappable (docs/phase0-refined-plan.md §3).
// "stub" runs fully offline for local dev.
/** The value shipped in the schema so local dev starts without setup. */
export const DEFAULT_SESSION_JWT_SECRET = 'change-me-in-production';

// `z.coerce.boolean()` treats the string "false" as true, which would make a
// `REDIS_ENABLED=false` deployment silently connect anyway. Parse the documented
// spellings explicitly and reject anything else.
const booleanFlag = z.preprocess(
  (value) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
).transform((value) => value === true || value === 'true' || value === '1');

export const envSchema = z
  .object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  // Redis is optional infrastructure: reads fall back to Postgres and queues are
  // skipped when it is disabled. Set false on a box that must not dial Redis at
  // all (unit/e2e tests, a web-only instance).
  REDIS_ENABLED: booleanFlag.default(true),
  QUEUE_ENABLED: booleanFlag.default(true),

  // Comma-separated browser origins. Empty means same-origin only (the web app
  // reaches the API through its own server, so cross-origin is opt-in).
  CORS_ORIGINS: z.string().default(''),
  // Number of reverse proxies in front of the API. Only the resolved req.ip is
  // used for rate-limit keys; raw X-Forwarded-For is never trusted.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  JSON_BODY_LIMIT: z.string().default('1mb'),

  RATE_LIMIT_ENABLED: booleanFlag.default(true),
  METRICS_ENABLED: booleanFlag.default(true),
  METRICS_TOKEN: z.string().optional(),
  // json in production, pretty elsewhere unless explicitly set.
  LOG_FORMAT: z.enum(['json', 'pretty']).optional(),
  LOG_LEVEL: z.enum(['verbose', 'debug', 'log', 'warn', 'error']).default('log'),
  LOG_HASH_SALT: z.string().default('inverge-log'),

  // Product analytics retention (docs/api/analytics-privacy.md): raw events 90 days,
  // daily aggregates 25 months. There is no public browser ingestion route; views
  // arrive through the signed service-to-service route below. The nightly
  // maintenance job enforces these bounds.
  ANALYTICS_RAW_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  ANALYTICS_AGGREGATE_RETENTION_MONTHS: z.coerce
    .number()
    .int()
    .min(1)
    .max(120)
    .default(25),

  // Service-to-service view ingest. Off by default: the web server must be
  // configured with the same secret before the route accepts anything.
  ANALYTICS_INGEST_ENABLED: booleanFlag.default(false),
  ANALYTICS_INGEST_SECRET: z.string().min(32).optional(),
  ANALYTICS_INGEST_CLOCK_SKEW_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(900)
    .default(300),
  ANALYTICS_INGEST_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(1024 * 1024)
    .default(64 * 1024),
  ANALYTICS_READ_ENABLED: booleanFlag.default(true),

  WALLET_PROVIDER: z.enum(['stub', 'privy', 'web3auth']).default('stub'),
  FLATFEE_PROVIDER: z.enum(['stub', 'paystack']).default('stub'),
  KYC_PROVIDER: z.enum(['stub', 'didit']).default('stub'),
  NOTIFICATION_PROVIDER: z.enum(['stub', 'herald']).default('stub'),
  // Idea quality scorer (FR-271). "stub" = deterministic completeness checks only;
  // "claude" adds AI checks (thin-content/plagiarism/coherence) — Phase 1.
  QUALITY_PROVIDER: z.enum(['stub', 'claude']).default('stub'),
  // AI moderation classifier (FR-1003 Layer 2). "stub" = deterministic keyword rules;
  // "ai" calls the Anthropic-compatible endpoint below.
  MODERATION_PROVIDER: z.enum(['stub', 'ai']).default('stub'),

  // Anthropic-compatible LLM (may point at DeepSeek via ANTHROPIC_BASE_URL). Used by the
  // AI moderation adapter. Keys live in .env only (gitignored) — never commit them.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),

  PRIVY_APP_ID: z.string().optional(),
  PRIVY_APP_SECRET: z.string().optional(),
  PRIVY_JWKS_URL: z.string().optional(),
  PRIVY_TOKEN_ISSUER: z.string().default('privy.io'),

  // MetaMask Embedded Wallets / Web3Auth (WALLET_PROVIDER=web3auth). The client
  // id is the token audience; without it a token minted for another project
  // would verify, so it is required at exchange time. No client secret is needed
  // for JWKS verification — never put one in this service.
  WEB3AUTH_CLIENT_ID: z.string().optional(),
  // v11 SDKs (the web app pins @web3auth/modal 11.4.x) mint social id tokens with
  // `iss: "web3auth.io"` — a bare host, not a URL — signed by keys published at
  // the citadel-service JWKS. The pre-v11 contract documented on
  // docs.metamask.io (`iss: https://api-auth.web3auth.io`, `/jwks`) does not own
  // those keys, so pointing the defaults at it rejects every real login with
  // "Invalid Web3Auth identity token". The issuer is therefore validated as a
  // non-empty string, not a URL, and both values stay overridable per deployment.
  WEB3AUTH_JWKS_URL: z
    .string()
    .url()
    .default('https://api.web3auth.io/citadel-service/.well-known/jwks.json'),
  WEB3AUTH_TOKEN_ISSUER: z.string().min(1).default('web3auth.io'),

  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_WEBHOOK_SECRET: z.string().optional(),

  // Didit KYC/AML (KYC_PROVIDER=didit, FR-103–105). Two workflows: a plain KYC one for
  // idea-validation identity (grants the VERIFIED pre-pledge tier) and a KYC+AML one for
  // funds handlers (creators / threshold backers). Keys/secret live in .env only.
  DIDIT_API_KEY: z.string().optional(),
  DIDIT_BASE_URL: z.string().url().default('https://verification.didit.me/v3'),
  DIDIT_KYC_WORKFLOW_ID: z.string().optional(), // identity only (no AML)
  DIDIT_KYC_AML_WORKFLOW_ID: z.string().optional(), // identity + AML screening
  DIDIT_KYB_WORKFLOW_ID: z.string().optional(), // business KYB (registry + docs + UBOs + AML)
  DIDIT_WEBHOOK_SECRET: z.string().optional(), // secret_shared_key for HMAC verification
  // Only set for up to 24h while rotating DIDIT_WEBHOOK_SECRET: verifies `*-Previous` headers.
  DIDIT_WEBHOOK_SECRET_PREVIOUS: z.string().optional(),
  DIDIT_CALLBACK_URL: z.string().url().optional(), // where the user returns after verifying

  // Verification policy (FR-103 / FR-104). Threshold values live in PlatformParam;
  // these control the verification domain itself.
  VERIFICATION_POLICY_VERSION: z.string().default('2026-10-27'),
  // A KYB workflow that does not run KYB_KEY_PEOPLE has not checked directors/UBOs.
  // Keep true unless the provider workflow is known to verify key people elsewhere.
  DIDIT_KYB_REQUIRE_KEY_PEOPLE: booleanFlag.default(true),
  VERIFICATION_RETRY_MAX_PER_DAY: z.coerce.number().int().min(1).max(50).default(5),
  VERIFICATION_RECONCILE_AFTER_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(15),
  VERIFICATION_RECONCILE_INTERVAL_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(10),
  VERIFICATION_RECONCILE_BATCH: z.coerce.number().int().min(1).max(200).default(25),
  VERIFICATION_RECONCILE_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5),
  VERIFICATION_AUTHORIZATION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(900),

  HERALD_GATEWAY_URL: z.string().optional(),
  HERALD_API_KEY: z.string().optional(),

  FEE_PAYER_SECRET_KEY: z.string().optional(),
  SOLANA_RPC_URL: z.string().optional(),

  // Campaign escrow deployment (FR-303/FR-305). `disabled` refuses to prepare a
  // deployment; there is no adapter that fabricates a confirmed transaction.
  ESCROW_CHAIN_PROVIDER: z.enum(['disabled', 'solana-rpc']).default('disabled'),
  // The only programme this API will verify a deployment against. A client value
  // is never read; an operator override is an allowlist of exactly one.
  ESCROW_PROGRAM_ID: z
    .string()
    .min(32)
    .max(44)
    .default('38rarxmrSL3rjCN2bwdDfQNLtpYRgLGp96xfkPXv39S1'),
  SOLANA_CLUSTER: z.enum(['devnet', 'mainnet-beta']).default('devnet'),
  // Finalized by default: a deployment unlocks funding, so a weaker commitment
  // would let a reorged-away transaction look permanent.
  SOLANA_COMMITMENT: z.enum(['confirmed', 'finalized']).default('finalized'),
  // JSON map of TokenType -> SPL mint. USDC defaults per cluster are built in;
  // cNGN has no canonical mint and must be configured explicitly.
  SOLANA_TOKEN_MINTS: z.string().optional(),
  SOLANA_USDC_MINT: z.string().optional(),

  // Fee policy for a deployment. `flat_fee` links an existing SUCCEEDED
  // APPLICATION_FEE charge (the FR-311 rail). The escrow programme has no
  // instruction that collects a platform fee, so `not_required` is the only mode
  // that is truthful without a contract change.
  CAMPAIGN_DEPLOYMENT_FEE_MODE: z
    .enum(['not_required', 'flat_fee'])
    .default('not_required'),
  CAMPAIGN_DEPLOYMENT_FEE_USD: z.coerce.number().positive().default(10),

  SESSION_JWT_SECRET: z.string().min(1).default(DEFAULT_SESSION_JWT_SECRET),

  // FR-901: break-glass / bootstrap superadmins. Comma-separated emails and/or Privy DIDs
  // that always pass the AdminGuard regardless of their DB role — used to seed the first
  // admin, who then grants others via PATCH /admin/users/:id/role. Empty by default.
  ADMIN_ALLOWLIST: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    // A production boot with the documented default would let anyone forge a
    // session for any user id. Fail at startup, not silently at runtime.
    if (
      env.NODE_ENV === 'production' &&
      env.SESSION_JWT_SECRET === DEFAULT_SESSION_JWT_SECRET
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_JWT_SECRET'],
        message: 'SESSION_JWT_SECRET must be set to a real secret in production',
      });
    }

    // Mainnet is a deliberate deployment, never something a local `pnpm start`
    // can reach by leaving an env var at its default.
    if (env.SOLANA_CLUSTER === 'mainnet-beta' && env.NODE_ENV !== 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SOLANA_CLUSTER'],
        message: 'SOLANA_CLUSTER=mainnet-beta is only allowed with NODE_ENV=production',
      });
    }

    // A configured RPC without a provider switch (or the reverse) is a
    // half-configured deployment. Refuse to boot rather than silently disabling
    // the workflow.
    if (env.ESCROW_CHAIN_PROVIDER === 'solana-rpc' && !env.SOLANA_RPC_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SOLANA_RPC_URL'],
        message: 'SOLANA_RPC_URL is required when ESCROW_CHAIN_PROVIDER=solana-rpc',
      });
    }

    // A production boot that cannot verify a provider callback must not start: an
    // unverified webhook is a shadow approval path. Dev may run without a secret, in
    // which case the endpoint rejects every callback and reconciliation is the only sync.
    if (env.NODE_ENV === 'production' && env.KYC_PROVIDER === 'didit') {
      for (const key of [
        'DIDIT_API_KEY',
        'DIDIT_WEBHOOK_SECRET',
        'DIDIT_KYC_WORKFLOW_ID',
        'DIDIT_KYC_AML_WORKFLOW_ID',
        'DIDIT_KYB_WORKFLOW_ID',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when KYC_PROVIDER=didit in production`,
          });
        }
      }
    }

    // Enabling ingest without a secret would leave the route unable to
    // authenticate a caller; fail at boot rather than at the first request.
    if (env.ANALYTICS_INGEST_ENABLED && !env.ANALYTICS_INGEST_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ANALYTICS_INGEST_SECRET'],
        message: 'ANALYTICS_INGEST_SECRET is required when ingest is enabled',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}
