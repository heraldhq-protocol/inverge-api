import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';

export type StubProvider = 'wallet' | 'KYC' | 'flat-fee' | 'email';

/**
 * Defence in depth for the offline adapters (audit F-01). `validateEnv` already
 * refuses to boot a production process that selects one of them; this check also
 * covers a direct construction by a test helper or a future factory edit, so a
 * configuration mistake cannot silently turn a stub into a production provider.
 */
export function assertStubProviderAllowed(
  provider: StubProvider,
  config?: ConfigService<Env, true>,
): void {
  const nodeEnv = config
    ? config.get('NODE_ENV', { infer: true })
    : process.env.NODE_ENV;
  if (nodeEnv === 'production') {
    throw new Error(
      `Stub ${provider} provider is development/test-only and cannot be used when NODE_ENV=production`,
    );
  }
}
