import { z } from 'zod';

// Provider selection keeps vendors swappable (docs/phase0-refined-plan.md §3).
// "stub" runs fully offline for local dev.
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  WALLET_PROVIDER: z.enum(['stub', 'privy']).default('stub'),
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

  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_WEBHOOK_SECRET: z.string().optional(),

  // Didit KYC/AML (KYC_PROVIDER=didit, FR-103–105). Two workflows: a plain KYC one for
  // idea-validation identity (grants the VERIFIED pre-pledge tier) and a KYC+AML one for
  // funds handlers (creators / threshold backers). Keys/secret live in .env only.
  DIDIT_API_KEY: z.string().optional(),
  DIDIT_BASE_URL: z.string().default('https://verification.didit.me/v3'),
  DIDIT_KYC_WORKFLOW_ID: z.string().optional(), // identity only (no AML)
  DIDIT_KYC_AML_WORKFLOW_ID: z.string().optional(), // identity + AML screening
  DIDIT_KYB_WORKFLOW_ID: z.string().optional(), // business KYB (registry + docs + UBOs + AML)
  DIDIT_WEBHOOK_SECRET: z.string().optional(), // secret_shared_key for HMAC verification
  DIDIT_CALLBACK_URL: z.string().optional(), // where the user returns after verifying

  HERALD_GATEWAY_URL: z.string().optional(),
  HERALD_API_KEY: z.string().optional(),

  FEE_PAYER_SECRET_KEY: z.string().optional(),
  SOLANA_RPC_URL: z.string().optional(),

  SESSION_JWT_SECRET: z.string().min(1).default('change-me-in-production'),

  // FR-901: break-glass / bootstrap superadmins. Comma-separated emails and/or Privy DIDs
  // that always pass the AdminGuard regardless of their DB role — used to seed the first
  // admin, who then grants others via PATCH /admin/users/:id/role. Empty by default.
  ADMIN_ALLOWLIST: z.string().default(''),
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
