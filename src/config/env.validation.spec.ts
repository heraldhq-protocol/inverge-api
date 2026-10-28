import { DEFAULT_SESSION_JWT_SECRET, validateEnv } from './env.validation';

const base = {
  DATABASE_URL: 'postgresql://inverge:inverge@localhost:5432/inverge',
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

  it('accepts a real secret in production', () => {
    const secret = 'b7f4c2a1d8e6f0a3c5b9d2e7f1a8c4b6';

    expect(
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        SESSION_JWT_SECRET: secret,
      }).SESSION_JWT_SECRET,
    ).toBe(secret);
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
