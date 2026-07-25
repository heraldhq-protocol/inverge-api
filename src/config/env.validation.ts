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
  KYC_PROVIDER: z.enum(['stub', 'smile']).default('stub'),
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
  PRIVY_JWKS_URL: z.string().optional(),
  PRIVY_TOKEN_ISSUER: z.string().default('privy.io'),

  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_WEBHOOK_SECRET: z.string().optional(),

  SMILE_PARTNER_ID: z.string().optional(),
  SMILE_API_KEY: z.string().optional(),

  HERALD_GATEWAY_URL: z.string().optional(),
  HERALD_API_KEY: z.string().optional(),

  FEE_PAYER_SECRET_KEY: z.string().optional(),
  SOLANA_RPC_URL: z.string().optional(),

  SESSION_JWT_SECRET: z.string().min(1).default('change-me-in-production'),
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
