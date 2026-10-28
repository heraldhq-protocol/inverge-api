import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { StubFlatFeeAdapter } from './stub-flat-fee.adapter';

const configFor = (nodeEnv: Env['NODE_ENV']) =>
  ({ get: () => nodeEnv }) as unknown as ConfigService<Env, true>;

describe('StubFlatFeeAdapter', () => {
  it('creates a local simulated charge in test mode', async () => {
    const adapter = new StubFlatFeeAdapter();
    const charge = await adapter.createCharge({
      userId: 'u1',
      purpose: 'BOOST',
      amount: 1000,
      currency: 'NGN',
    });

    expect(charge.processorRef).toMatch(/^stub_/);
    expect(charge.redirectUrl).toContain('/dev/flat-fee/complete');
  });

  it('parses an unsigned body only as an offline simulator', () => {
    const adapter = new StubFlatFeeAdapter();
    expect(
      adapter.parseWebhook(
        JSON.stringify({ processorRef: 'stub_1', status: 'SUCCEEDED' }),
      ),
    ).toMatchObject({ processorRef: 'stub_1', status: 'SUCCEEDED' });
  });

  it('refuses to create or accept a charge in production', async () => {
    const adapter = new StubFlatFeeAdapter(configFor('production'));

    await expect(
      adapter.createCharge({
        userId: 'u1',
        purpose: 'BOOST',
        amount: 1000,
        currency: 'NGN',
      }),
    ).rejects.toThrow(/stub flat-fee provider is development\/test-only/i);

    expect(() =>
      adapter.parseWebhook(
        JSON.stringify({ processorRef: 'stub_1', status: 'SUCCEEDED' }),
      ),
    ).toThrow(/production/i);
  });

  it('refuses when NODE_ENV=production is only in process.env', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        new StubFlatFeeAdapter().createCharge({
          userId: 'u1',
          purpose: 'BOOST',
          amount: 1000,
          currency: 'NGN',
        }),
      ).rejects.toThrow(/production/i);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('remains usable in test and development', async () => {
    await expect(
      new StubFlatFeeAdapter(configFor('test')).createCharge({
        userId: 'u1',
        purpose: 'BOOST',
        amount: 1000,
        currency: 'NGN',
      }),
    ).resolves.toMatchObject({ processorRef: expect.stringMatching(/^stub_/) });
  });
});
