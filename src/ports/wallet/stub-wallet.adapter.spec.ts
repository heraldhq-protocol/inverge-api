import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { StubWalletAdapter } from './stub-wallet.adapter';

const configFor = (nodeEnv: Env['NODE_ENV']) =>
  ({ get: () => nodeEnv }) as unknown as ConfigService<Env, true>;

describe('StubWalletAdapter', () => {
  it('derives a distinct identity from the stub token format', async () => {
    const adapter = new StubWalletAdapter();
    const identity = await adapter.verifyAccessToken(
      'stub:user-a:user-a@example.test',
    );

    expect(identity.providerUserId).toBe('did:privy:stub:user-a');
    expect(identity.email).toBe('user-a@example.test');
    expect(identity.wallet?.provider).toBe('stub');
  });

  it('refuses to authenticate when the validated environment is production', async () => {
    const adapter = new StubWalletAdapter(configFor('production'));

    await expect(
      adapter.verifyAccessToken('stub:attacker:attacker@example.test'),
    ).rejects.toThrow(/stub wallet provider is development\/test-only/i);
    await expect(adapter.getEmbeddedWallet('did:privy:stub:x')).rejects.toThrow(
      /production/i,
    );
  });

  it('refuses to authenticate when NODE_ENV=production is only in process.env', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        new StubWalletAdapter().verifyAccessToken('stub:attacker'),
      ).rejects.toThrow(/production/i);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('remains usable in test and development', async () => {
    await expect(
      new StubWalletAdapter(configFor('test')).verifyAccessToken('stub:a'),
    ).resolves.toMatchObject({ providerUserId: 'did:privy:stub:a' });
    await expect(
      new StubWalletAdapter(configFor('development')).verifyAccessToken('stub:b'),
    ).resolves.toMatchObject({ providerUserId: 'did:privy:stub:b' });
  });
});
