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
  EMAIL_FROM: 'no-reply@mail.inverge.test',
  EMAIL_CODE_SECRET: 'email-code-secret-for-tests-0000000000',
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
    expect(() =>
      validateEnv({ ...base, SESSION_JWT_SECRET: '' }),
    ).toThrow(/SESSION_JWT_SECRET/);
  });
});

describe('validateEnv — Web3Auth token contract', () => {
  it('defaults to the issuer/JWKS pair v11 SDKs actually sign with', () => {
    const env = validateEnv({ ...base });
    // @web3auth/modal 11.4.x mints `iss: "web3auth.io"`; the documented
    // api-auth.web3auth.io pair does not publish those signing keys.
    expect(env.WEB3AUTH_TOKEN_ISSUER).toBe('web3auth.io');
    expect(env.WEB3AUTH_JWKS_URL).toBe(
      'https://api.web3auth.io/citadel-service/.well-known/jwks.json',
    );
  });

  it('accepts a bare-host issuer, which a URL-only schema would reject', () => {
    expect(() =>
      validateEnv({
        ...base,
        WEB3AUTH_TOKEN_ISSUER: 'web3auth.io',
        WEB3AUTH_JWKS_URL: 'https://api-auth.web3auth.io/jwks',
      }),
    ).not.toThrow();
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
    ['EMAIL_PROVIDER', { EMAIL_PROVIDER: 'stub' }],
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

  it.each(['RESEND_API_KEY', 'EMAIL_FROM'] as const)(
    'requires %s when Resend is selected',
    (key) => {
      expect(() =>
        validateEnv({ ...productionBase, [key]: undefined }),
      ).toThrow(new RegExp(key));
    },
  );

  it('requires a production email code secret', () => {
    expect(() =>
      validateEnv({
        ...productionBase,
        EMAIL_CODE_SECRET: 'dev-only-email-code-secret-change-me',
      }),
    ).toThrow(/EMAIL_CODE_SECRET/);
  });

  it('does not require credentials for integrations that are disabled', () => {
    const env = validateEnv({
      ...productionBase,
      // Advisory rails may legitimately stay deterministic or offline in
      // staging; they are not authentication or payment approval.
      QUALITY_PROVIDER: 'stub',
      MODERATION_PROVIDER: 'stub',
      ANTHROPIC_API_KEY: undefined,
    });
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
