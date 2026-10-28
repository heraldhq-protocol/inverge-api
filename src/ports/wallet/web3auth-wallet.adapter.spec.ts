import { createServer, type Server } from 'node:http';
import { UnauthorizedException } from '@nestjs/common';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  resolveIdentityIssuers,
  Web3AuthWalletAdapter,
} from './web3auth-wallet.adapter';

const CLIENT_ID = 'inverge-test-client';
const ISSUER = 'https://api-auth.web3auth.io';

// 32 zero bytes is a valid (if degenerate) ed25519 public key; its base58 form
// is the well-known all-ones address, which keeps the fixture hash-free.
const ZERO_KEY_HEX = '0'.repeat(64);
const ZERO_KEY_ADDRESS = '11111111111111111111111111111111';

type ConfigOverrides = {
  WEB3AUTH_CLIENT_ID?: string | undefined;
};

let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  servers = [];
});

// jose's Node build fetches the JWKS over node:http(s), so a loopback server is
// the only way to exercise the real verification path without mocking jose.
async function serveJwks(jwk: Record<string, unknown>): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('JWKS server has no port');
  return `http://127.0.0.1:${address.port}/jwks`;
}

async function setup(overrides: ConfigOverrides = {}) {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  const jwksUrl = await serveJwks(jwk);

  const values: Record<string, string | undefined> = {
    WEB3AUTH_CLIENT_ID:
      'WEB3AUTH_CLIENT_ID' in overrides ? overrides.WEB3AUTH_CLIENT_ID : CLIENT_ID,
    WEB3AUTH_JWKS_URL: jwksUrl,
    WEB3AUTH_TOKEN_ISSUER: ISSUER,
  };

  const config = { get: jest.fn((key: string) => values[key]) };
  // Pin to the loopback family so no test ever dials the real JWKS endpoints.
  const adapter = new Web3AuthWalletAdapter(config as never, [{ issuer: ISSUER, jwksUrl }]);

  return { adapter, privateKey };
}

type Claims = Record<string, unknown>;

async function mint(
  privateKey: Parameters<SignJWT['sign']>[0],
  claims: Claims = {},
  options: { audience?: string; issuer?: string; expiresIn?: string; subject?: string } = {},
) {
  const token = new SignJWT({
    email: 'amara@example.com',
    authConnection: 'google',
    userId: 'user-1',
    ...claims,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m');

  if (options.subject !== undefined) token.setSubject(options.subject);
  else token.setSubject('google|user-1');

  return token.sign(privateKey);
}

describe('Web3AuthWalletAdapter', () => {
  it('verifies a token issued for this client', async () => {
    const { adapter, privateKey } = await setup();
    const token = await mint(privateKey);

    await expect(adapter.verifyAccessToken(token)).resolves.toEqual({
      providerUserId: 'google|user-1',
      email: 'amara@example.com',
      wallet: undefined,
    });
  });

  it('rejects a token minted for a different client', async () => {
    const { adapter, privateKey } = await setup();
    const token = await mint(privateKey, {}, { audience: 'someone-else' });

    await expect(adapter.verifyAccessToken(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token from a different issuer', async () => {
    const { adapter, privateKey } = await setup();
    const token = await mint(privateKey, {}, { issuer: 'https://authjs.web3auth.io' });

    await expect(adapter.verifyAccessToken(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', async () => {
    const { adapter, privateKey } = await setup();
    const token = await mint(privateKey, {}, { expiresIn: '-1m' });

    await expect(adapter.verifyAccessToken(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('fails closed when the client id is not configured', async () => {
    const { adapter, privateKey } = await setup({ WEB3AUTH_CLIENT_ID: undefined });
    const token = await mint(privateKey);

    await expect(adapter.verifyAccessToken(token)).rejects.toThrow(
      'WEB3AUTH_CLIENT_ID is not configured',
    );
  });

  it('links a wallet only when the token attests the claimed address', async () => {
    const { adapter, privateKey } = await setup();
    const token = await mint(privateKey, {
      wallets: [{ public_key: ZERO_KEY_HEX, type: 'web3auth_app_key', curve: 'ed25519' }],
    });

    await expect(
      adapter.verifyAccessToken(token, { walletAddress: ZERO_KEY_ADDRESS }),
    ).resolves.toMatchObject({
      wallet: { address: ZERO_KEY_ADDRESS, provider: 'web3auth' },
    });
  });

  it('rejects a claimed address the token does not attest', async () => {
    const { adapter, privateKey } = await setup();
    const token = await mint(privateKey, {
      wallets: [{ public_key: 'f'.repeat(64), type: 'web3auth_app_key', curve: 'ed25519' }],
    });

    await expect(
      adapter.verifyAccessToken(token, { walletAddress: ZERO_KEY_ADDRESS }),
    ).rejects.toThrow('not attested');
  });

  it('attests an external wallet by its address claim', async () => {
    const { adapter, privateKey } = await setup();
    const token = await mint(privateKey, {
      wallets: [{ address: '0xAbC0000000000000000000000000000000000001', type: 'ethereum' }],
    });

    await expect(
      adapter.verifyAccessToken(token, {
        walletAddress: '0xabc0000000000000000000000000000000000001',
      }),
    ).resolves.toMatchObject({
      wallet: { address: '0xabc0000000000000000000000000000000000001' },
    });
  });

  it('derives a stable subject when the token omits sub', async () => {
    const { adapter, privateKey } = await setup();
    const token = await new SignJWT({ authConnection: 'google', userId: 'user-1' })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(adapter.verifyAccessToken(token)).resolves.toMatchObject({
      providerUserId: 'google|user-1',
    });
  });

  it('rejects a token with no stable subject', async () => {
    const { adapter, privateKey } = await setup();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(adapter.verifyAccessToken(token)).rejects.toThrow('no stable subject');
  });

  it('falls back to the other known family when the configured one does not own the key', async () => {
    // A deployment still pinning the pre-v11 pair, receiving a v11 token: the
    // configured JWKS has no matching kid, so the second family must verify it.
    const { publicKey: otherKey } = await generateKeyPair('ES256');
    const primaryJwks = await serveJwks({
      ...(await exportJWK(otherKey)),
      kid: 'pre-v11-key',
      alg: 'ES256',
      use: 'sig',
    });
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const fallbackJwks = await serveJwks({
      ...(await exportJWK(publicKey)),
      kid: 'test-key',
      alg: 'ES256',
      use: 'sig',
    });

    const values: Record<string, string> = {
      WEB3AUTH_CLIENT_ID: CLIENT_ID,
      WEB3AUTH_JWKS_URL: primaryJwks,
      WEB3AUTH_TOKEN_ISSUER: 'https://api-auth.web3auth.io',
    };
    const config = { get: jest.fn((key: string) => values[key]) };
    const adapter = new Web3AuthWalletAdapter(config as never, [
      { issuer: 'https://api-auth.web3auth.io', jwksUrl: primaryJwks },
      { issuer: 'web3auth.io', jwksUrl: fallbackJwks },
    ]);

    const token = await mint(privateKey, {}, { issuer: 'web3auth.io' });

    await expect(adapter.verifyAccessToken(token)).resolves.toMatchObject({
      providerUserId: 'google|user-1',
    });
  });

  it('still rejects a token signed for another audience, whichever family matches', async () => {
    const { adapter, privateKey } = await setup();
    const token = await mint(privateKey, {}, { audience: 'someone-else' });

    await expect(adapter.verifyAccessToken(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('does not fetch a wallet server-side', async () => {
    const { adapter } = await setup();
    await expect(adapter.getEmbeddedWallet()).resolves.toBeNull();
  });
});

describe('resolveIdentityIssuers', () => {
  const V11 = {
    issuer: 'web3auth.io',
    jwksUrl: 'https://api.web3auth.io/citadel-service/.well-known/jwks.json',
  };
  const PRE_V11 = {
    issuer: 'https://api-auth.web3auth.io',
    jwksUrl: 'https://api-auth.web3auth.io/jwks',
  };

  it('tries the configured pair first', () => {
    expect(resolveIdentityIssuers(PRE_V11)[0]).toBe(PRE_V11);
    expect(resolveIdentityIssuers(V11)[0]).toBe(V11);
  });

  it('adds the other known family so a stale config cannot reject every login', () => {
    expect(resolveIdentityIssuers(PRE_V11).map((entry) => entry.issuer)).toEqual([
      PRE_V11.issuer,
      V11.issuer,
    ]);
  });

  it('never repeats the configured pair', () => {
    const issuers = resolveIdentityIssuers(V11);
    expect(issuers).toHaveLength(2);
    expect(new Set(issuers.map((entry) => entry.jwksUrl)).size).toBe(issuers.length);
  });

  it('keeps a deployment-specific issuer ahead of the known families', () => {
    const custom = { issuer: 'https://id.example.test', jwksUrl: 'https://id.example.test/jwks' };
    expect(resolveIdentityIssuers(custom)[0]).toBe(custom);
    expect(resolveIdentityIssuers(custom)).toHaveLength(3);
  });
});
