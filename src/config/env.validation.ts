import { z } from 'zod';

// Provider selection keeps vendors swappable (docs/phase0-refined-plan.md §3).
// "stub" runs fully offline for local dev; production rejects the stub wallet,
// KYC and flat-fee adapters (audit F-01).
/** The value shipped in the schema so local dev starts without setup. */
export const DEFAULT_SESSION_JWT_SECRET = 'change-me-in-production';
/** Dev/test only; production rejects this value for the email code pepper. */
export const DEFAULT_EMAIL_CODE_SECRET = 'dev-only-email-code-secret-change-me';

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

  // Creator Studio assistant (premium). `disabled` keeps every AI route at 503
  // AI_NOT_CONFIGURED; `stub` is deterministic offline output for development and
  // tests only; `anthropic` calls the compatible endpoint above (DeepSeek works).
  // These credentials are separate from the moderation ANTHROPIC_* values.
  AI_PROVIDER: z.enum(['disabled', 'stub', 'anthropic']).default('disabled'),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(20_000),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(4_000).default(1_200),
  // Total characters accepted across the selected field plus its context.
  AI_MAX_INPUT_CHARS: z.coerce.number().int().min(200).max(20_000).default(6_000),
  AI_DAILY_REQUESTS_PER_USER: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(30),
  AI_DAILY_TOKENS_PER_USER: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(1_000_000)
    .default(60_000),

  // Media storage (docs/media/phase-1-audit.md). One provider is selected by env,
  // exactly like the other vendor ports. `disabled` is the safe default: every
  // media operation fails closed with 503 MEDIA_STORAGE_NOT_CONFIGURED rather
  // than pretending an upload succeeded.
  //
  // `s3` is documented but not implemented in this milestone. Selecting it is a
  // boot error instead of a runtime surprise.
  MEDIA_STORAGE_PROVIDER: z.enum(['disabled', 'supabase', 's3']).default('disabled'),
  // Supabase project URL, e.g. https://abcdefgh.supabase.co (no trailing path).
  SUPABASE_URL: z.string().url().optional(),
  // Server-only. Never expose this to the browser and never send it to the web
  // app: the browser only ever receives a short-lived signed upload target.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  MEDIA_BUCKET: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'MEDIA_BUCKET must be a lowercase hyphenated name')
    .default('inverge-media'),
  MEDIA_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(7200).default(900),
  MEDIA_READ_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  // Images only in this milestone. Video upload is deferred (see the audit 6):
  // demo and presentation videos are YouTube/Vimeo links rendered in the hero,
  // which keeps long recordings off our storage and out of the request path.
  MEDIA_IMAGE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(16 * 1024)
    .max(25 * 1024 * 1024)
    .default(10 * 1024 * 1024),
  // Comma-separated allowlist. SVG is intentionally absent: it is a script
  // carrier and this service has no sanitiser.
  MEDIA_ALLOWED_IMAGE_TYPES: z
    .string()
    .default('image/jpeg,image/png,image/webp'),
  MEDIA_DAILY_UPLOAD_LIMIT: z.coerce.number().int().min(1).max(500).default(40),
  // How long a PENDING upload may exist before cleanup may remove it.
  MEDIA_PENDING_RETENTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),

  // YouTube metadata resolution (official Data API only; user URLs are never
  // fetched). Without a key a valid reference is still stored and rendered from
  // its parsed id, with no invented title, channel name or duration.
  YOUTUBE_METADATA_ENABLED: booleanFlag.default(false),
  YOUTUBE_API_KEY: z.string().optional(),
  YOUTUBE_API_BASE_URL: z
    .string()
    .url()
    .default('https://www.googleapis.com/youtube/v3'),
  YOUTUBE_TIMEOUT_MS: z.coerce.number().int().min(500).max(15_000).default(4_000),

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

  // Transactional email (email verification). Resend is the production adapter;
  // `stub` writes to a gitignored local outbox and is rejected in production.
  EMAIL_PROVIDER: z.enum(['stub', 'resend']).default('stub'),
  RESEND_API_KEY: z.string().optional(),
  // Bare sender address, e.g. no-reply@mail.example.com. The display name is
  // separate so the address can be validated on its own.
  EMAIL_FROM: z.string().optional(),
  EMAIL_FROM_NAME: z.string().default('Inverge'),
  EMAIL_REPLY_TO: z.string().optional(),
  // HMAC pepper for six-digit codes. Codes are never stored in plaintext.
  EMAIL_CODE_SECRET: z.string().min(1).default(DEFAULT_EMAIL_CODE_SECRET),
  EMAIL_VERIFICATION_CODE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(600),
  EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: z.coerce
    .number()
    .int()
    .min(15)
    .max(600)
    .default(60),
  EMAIL_VERIFICATION_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5),
  EMAIL_VERIFICATION_MAX_PER_HOUR: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5),
  EMAIL_DELIVERY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(30_000)
    .default(10_000),

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
    } else if (
      env.NODE_ENV === 'production' &&
      env.SESSION_JWT_SECRET.trim().length < 32
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_JWT_SECRET'],
        message: 'SESSION_JWT_SECRET must be at least 32 characters in production',
      });
    }

    // F-01: the offline adapters authenticate arbitrary tokens / identities /
    // payment references. Allowing any of them in production is a full bypass
    // of authentication, KYC or the paid rails, so refuse the boot rather than
    // rely on an adapter-level check alone.
    if (env.NODE_ENV === 'production') {
      if (env.AI_PROVIDER === 'stub') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AI_PROVIDER'],
          message:
            'AI_PROVIDER=stub is not allowed in production; use anthropic or disabled',
        });
      }
      for (const [key, value] of [
        ['WALLET_PROVIDER', env.WALLET_PROVIDER],
        ['KYC_PROVIDER', env.KYC_PROVIDER],
        ['FLATFEE_PROVIDER', env.FLATFEE_PROVIDER],
        ['EMAIL_PROVIDER', env.EMAIL_PROVIDER],
      ] as const) {
        if (value === 'stub') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key}=stub is not allowed in production; select a real provider and configure its credentials`,
          });
        }
      }
    }

    // An explicitly selected provider must have everything it needs to verify a
    // caller. A missing value would otherwise fail at the first request (or, for
    // a webhook secret, leave a payment callback unverifiable), which is a boot
    // error rather than a runtime surprise.
    if (env.WALLET_PROVIDER === 'web3auth' && !env.WEB3AUTH_CLIENT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WEB3AUTH_CLIENT_ID'],
        message: 'WEB3AUTH_CLIENT_ID is required when WALLET_PROVIDER=web3auth',
      });
    }
    if (env.WALLET_PROVIDER === 'privy') {
      for (const key of ['PRIVY_APP_ID', 'PRIVY_APP_SECRET'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when WALLET_PROVIDER=privy`,
          });
        }
      }
    }
    // Paystack credentials are deliberately not a boot requirement. A deployment
    // may select the rail before the keys are provisioned and still serve the rest
    // of the API; the adapter fails closed until they arrive — createCharge throws
    // and parseWebhook rejects every callback when neither key is set. Setting
    // PAYSTACK_WEBHOOK_SECRET explicitly is still the supported production
    // configuration (the adapter otherwise falls back to the API key).
    if (env.KYC_PROVIDER === 'didit' && !env.DIDIT_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DIDIT_API_KEY'],
        message: 'DIDIT_API_KEY is required when KYC_PROVIDER=didit',
      });
    }

    // Email verification cannot work without a deliverable sender. A missing
    // key would turn every request into a 502 at runtime; fail at boot instead.
    if (env.EMAIL_PROVIDER === 'resend') {
      for (const key of ['RESEND_API_KEY', 'EMAIL_FROM'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when EMAIL_PROVIDER=resend`,
          });
        }
      }
    }
    if (env.EMAIL_FROM && !env.EMAIL_FROM.includes('@')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_FROM'],
        message: 'EMAIL_FROM must be a bare email address',
      });
    }
    if (env.EMAIL_REPLY_TO && !env.EMAIL_REPLY_TO.includes('@')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_REPLY_TO'],
        message: 'EMAIL_REPLY_TO must be a bare email address',
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      (env.EMAIL_CODE_SECRET === DEFAULT_EMAIL_CODE_SECRET ||
        env.EMAIL_CODE_SECRET.trim().length < 32)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_CODE_SECRET'],
        message:
          'EMAIL_CODE_SECRET must be a unique secret of at least 32 characters in production',
      });
    }

    // The assistant's stub is deterministic canned output. Shipping it to
    // production would present offline placeholder text as a real model answer.
    if (env.NODE_ENV === 'production' && env.AI_PROVIDER === 'stub') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_PROVIDER'],
        message:
          'AI_PROVIDER=stub is not allowed in production; use anthropic or disabled',
      });
    }
    if (env.AI_PROVIDER === 'anthropic' && !env.AI_API_KEY?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_API_KEY'],
        message: 'AI_API_KEY is required when AI_PROVIDER=anthropic',
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

    // Media storage: a selected provider must be fully configured, and a
    // provider that does not exist in this milestone must not be selectable.
    if (env.MEDIA_STORAGE_PROVIDER === 's3') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MEDIA_STORAGE_PROVIDER'],
        message:
          'MEDIA_STORAGE_PROVIDER=s3 is not implemented yet; use supabase or disabled (docs/media/s3-migration.md)',
      });
    }
    if (env.MEDIA_STORAGE_PROVIDER === 'supabase') {
      for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when MEDIA_STORAGE_PROVIDER=supabase`,
          });
        }
      }
    }
    if (env.YOUTUBE_METADATA_ENABLED && !env.YOUTUBE_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YOUTUBE_API_KEY'],
        message: 'YOUTUBE_API_KEY is required when YOUTUBE_METADATA_ENABLED=true',
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
