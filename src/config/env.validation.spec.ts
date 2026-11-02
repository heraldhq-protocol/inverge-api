import { DEFAULT_SESSION_JWT_SECRET, validateEnv } from './env.validation';

const base = {
  DATABASE_URL: 'postgresql://inverge:inverge@localhost:5432/inverge',
};

const realSecret = 'b7f4c2a1d8e6f0a3c5b9d2e7f1a8c4b6';

/** A production configuration in which every enabled provider is real. */
const productionBase = {
  ...base,
  NODE_ENV: 'production',
  SESSION_JWT_SECRET: realSecret,
  WALLET_PROVIDER: 'web3auth',
  WEB3AUTH_CLIENT_ID: 'inverge-client-id',
  KYC_PROVIDER: 'didit',
  DIDIT_API_KEY: 'didit-key',
  DIDIT_WEBHOOK_SECRET: 'didit-webhook-secret',
  DIDIT_KYC_WORKFLOW_ID: 'wf-kyc',
  DIDIT_KYC_AML_WORKFLOW_ID: 'wf-kyc-aml',
  DIDIT_KYB_WORKFLOW_ID: 'wf-kyb',
  FLATFEE_PROVIDER: 'paystack',
  PAYSTACK_SECRET_KEY: 'sk_test_example',
  PAYSTACK_WEBHOOK_SECRET: 'paystack-webhook-secret',
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test_example',
  RESEND_WEBHOOK_SECRET: 'whsec_dGVzdC13ZWJob29rLXNlY3JldA==',
  EMAIL_FROM: 'no-reply@inverge.test',
  EMAIL_CODE_SECRET: 'test-email-code-secret-at-least-32-characters',
  EMAIL_UNSUBSCRIBE_SECRET: 'test-unsubscribe-secret-at-least-32-characters',
  PUBLIC_APP_URL: 'https://inverge.test',
  PUBLIC_API_URL: 'https://api.inverge.test',
};

describe('validateEnv — SESSION_JWT_SECRET', () => {
  it('rejects the documented default in production', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /SESSION_JWT_SECRET/,
    );
  });

  it('rejects the default even when it is set explicitly', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        SESSION_JWT_SECRET: DEFAULT_SESSION_JWT_SECRET,
      }),
    ).toThrow(/SESSION_JWT_SECRET/);
  });

  it('rejects a production secret shorter than 32 characters', () => {
    expect(() =>
      validateEnv({
        ...productionBase,
        SESSION_JWT_SECRET: 'too-short',
      }),
    ).toThrow(/at least 32 characters/);
  });

  it('accepts a real secret in production', () => {
    expect(
      validateEnv({
        ...productionBase,
        SESSION_JWT_SECRET: realSecret,
      }).SESSION_JWT_SECRET,
    ).toBe(realSecret);
  });

  it('keeps the development default so local setup stays zero-config', () => {
    expect(validateEnv({ ...base }).SESSION_JWT_SECRET).toBe(
      DEFAULT_SESSION_JWT_SECRET,
    );
  });

  it('rejects an empty secret in every environment', () => {
    expect(() => validateEnv({ ...base, SESSION_JWT_SECRET: '' })).toThrow(
      /SESSION_JWT_SECRET/,
    );
  });
});

describe('validateEnv — production provider safety (F-01)', () => {
  it('accepts a fully configured production deployment', () => {
    const env = validateEnv(productionBase);
    expect(env.NODE_ENV).toBe('production');
    expect(env.WALLET_PROVIDER).toBe('web3auth');
    expect(env.KYC_PROVIDER).toBe('didit');
    expect(env.FLATFEE_PROVIDER).toBe('paystack');
  });

  it.each([
    ['WALLET_PROVIDER', { WALLET_PROVIDER: 'stub' }],
    ['KYC_PROVIDER', { KYC_PROVIDER: 'stub' }],
    ['FLATFEE_PROVIDER', { FLATFEE_PROVIDER: 'stub' }],
  ] as const)('rejects %s=stub in production', (key, override) => {
    expect(() => validateEnv({ ...productionBase, ...override })).toThrow(
      new RegExp(`${key}=stub is not allowed in production`),
    );
  });

  it('rejects the default stub selection in production when nothing is configured', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: 'production',
        SESSION_JWT_SECRET: realSecret,
      }),
    ).toThrow(/WALLET_PROVIDER=stub|KYC_PROVIDER=stub|FLATFEE_PROVIDER=stub/);
  });

  it('accepts stubs outside production so offline development and tests work', () => {
    const env = validateEnv({
      ...base,
      NODE_ENV: 'development',
      WALLET_PROVIDER: 'stub',
      KYC_PROVIDER: 'stub',
      FLATFEE_PROVIDER: 'stub',
    });
    expect(env.WALLET_PROVIDER).toBe('stub');
    expect(env.KYC_PROVIDER).toBe('stub');
    expect(env.FLATFEE_PROVIDER).toBe('stub');
  });

  it('accepts stubs under NODE_ENV=test', () => {
    expect(
      validateEnv({
        ...base,
        NODE_ENV: 'test',
        WALLET_PROVIDER: 'stub',
        KYC_PROVIDER: 'stub',
        FLATFEE_PROVIDER: 'stub',
      }).NODE_ENV,
    ).toBe('test');
  });
});

describe('validateEnv — credentials for enabled providers', () => {
  it('requires WEB3AUTH_CLIENT_ID when web3auth is selected', () => {
    expect(() =>
      validateEnv({
        ...productionBase,
        WEB3AUTH_CLIENT_ID: undefined,
      }),
    ).toThrow(/WEB3AUTH_CLIENT_ID/);
  });

  it('requires Privy app credentials when privy is selected', () => {
    expect(() =>
      validateEnv({
        ...productionBase,
        WALLET_PROVIDER: 'privy',
        PRIVY_APP_ID: undefined,
        PRIVY_APP_SECRET: undefined,
      }),
    ).toThrow(/PRIVY_APP_ID|PRIVY_APP_SECRET/);
  });

  it('accepts privy in production when both app credentials are present', () => {
    const env = validateEnv({
      ...productionBase,
      WALLET_PROVIDER: 'privy',
      PRIVY_APP_ID: 'app-id',
      PRIVY_APP_SECRET: 'app-secret',
    });
    expect(env.WALLET_PROVIDER).toBe('privy');
  });

  it('requires DIDIT_API_KEY when didit is selected', () => {
    expect(() =>
      validateEnv({
        ...productionBase,
        DIDIT_API_KEY: undefined,
      }),
    ).toThrow(/DIDIT_API_KEY/);
  });

  it.each([
    'DIDIT_WEBHOOK_SECRET',
    'DIDIT_KYC_WORKFLOW_ID',
    'DIDIT_KYC_AML_WORKFLOW_ID',
    'DIDIT_KYB_WORKFLOW_ID',
  ] as const)('requires %s for a production Didit deployment', (key) => {
    expect(() =>
      validateEnv({
        ...productionBase,
        [key]: undefined,
      }),
    ).toThrow(new RegExp(key));
  });

  it('boots with paystack selected but no credentials provisioned', () => {
    const env = validateEnv({
      ...productionBase,
      PAYSTACK_SECRET_KEY: undefined,
      PAYSTACK_WEBHOOK_SECRET: undefined,
    });
    expect(env.FLATFEE_PROVIDER).toBe('paystack');
    expect(env.PAYSTACK_SECRET_KEY).toBeUndefined();
  });

  it('does not require credentials for advisory integrations that are disabled', () => {
    const env = validateEnv({
      ...productionBase,
      QUALITY_PROVIDER: 'stub',
      MODERATION_PROVIDER: 'stub',
      ANTHROPIC_API_KEY: undefined,
    });
    expect(env.QUALITY_PROVIDER).toBe('stub');
  });

  it('requires Resend credentials when email delivery is enabled', () => {
    expect(() =>
      validateEnv({
        ...productionBase,
        RESEND_API_KEY: undefined,
      }),
    ).toThrow(/RESEND_API_KEY/);
    expect(() =>
      validateEnv({
        ...productionBase,
        EMAIL_FROM: undefined,
      }),
    ).toThrow(/EMAIL_FROM/);
  });

  it('rejects the stub email provider in production', () => {
    expect(() =>
      validateEnv({
        ...productionBase,
        EMAIL_PROVIDER: 'stub',
      }),
    ).toThrow(/EMAIL_PROVIDER=stub/);
  });

  it('rejects the development email pepper in production', () => {
    expect(() =>
      validateEnv({
        ...productionBase,
        EMAIL_CODE_SECRET: 'dev-only-email-code-secret-change-me',
      }),
    ).toThrow(/EMAIL_CODE_SECRET/);
  });

  it('requires the Resend webhook secret in production', () => {
    expect(() =>
      validateEnv({
        ...productionBase,
        RESEND_WEBHOOK_SECRET: undefined,
      }),
    ).toThrow(/RESEND_WEBHOOK_SECRET/);
  });

  it('rejects a developer host in production email links', () => {
    expect(() =>
      validateEnv({
        ...productionBase,
        PUBLIC_APP_URL: 'http://localhost:3000',
      }),
    ).toThrow(/PUBLIC_APP_URL/);
    expect(() =>
      validateEnv({
        ...productionBase,
        PUBLIC_API_URL: 'http://localhost:3000',
      }),
    ).toThrow(/PUBLIC_API_URL/);
  });

  it('rejects the development unsubscribe secret in production', () => {
    expect(() =>
      validateEnv({
        ...productionBase,
        EMAIL_UNSUBSCRIBE_SECRET: 'dev-only-email-unsubscribe-secret-change-me',
      }),
    ).toThrow(/EMAIL_UNSUBSCRIBE_SECRET/);
  });

  it('requires a sender postal address before editorial sending is enabled', () => {
    expect(() =>
      validateEnv({
        ...productionBase,
        EDITORIAL_EMAILS_ENABLED: 'true',
      }),
    ).toThrow(/EMAIL_COMPANY_ADDRESS/);
  });
});

describe('validateEnv — escrow/provider coupling', () => {
  it('still requires SOLANA_RPC_URL when the chain adapter is enabled', () => {
    expect(() =>
      validateEnv({
        ...base,
        ESCROW_CHAIN_PROVIDER: 'solana-rpc',
      }),
    ).toThrow(/SOLANA_RPC_URL/);
  });

  it('still refuses mainnet outside production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'development',
        SOLANA_CLUSTER: 'mainnet-beta',
      }),
    ).toThrow(/mainnet-beta/);
  });
});
