import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.validation';
import {
  buildFeeBreakdown,
  resolveDeploymentFeePolicy,
  resolveTokenMint,
} from './solana-config';

type Config = Pick<ConfigService<Env, true>, 'get'>;

function config(values: Record<string, unknown>): Config {
  return {
    get: ((key: string) => values[key]) as Config['get'],
  };
}

describe('resolveTokenMint', () => {
  it('uses the canonical USDC mint per cluster', () => {
    // #given no override
    // #when resolved
    // #then the Circle devnet and mainnet mints are returned
    const devnet = resolveTokenMint('USDC', 'devnet', config({}));
    const mainnet = resolveTokenMint('USDC', 'mainnet-beta', config({}));

    expect(devnet).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    expect(mainnet).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('prefers an explicit map entry over the default', () => {
    // #given an operator override for USDC
    const mint = '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E';

    // #when resolved
    // #then the configured mint wins
    expect(
      resolveTokenMint('USDC', 'devnet', config({ SOLANA_TOKEN_MINTS: JSON.stringify({ USDC: mint }) })),
    ).toBe(mint);
  });

  it('never invents a cNGN mint', () => {
    // #given a campaign in cNGN with no configured mint
    // #when resolved
    // #then the result is null, which readiness reports as a blocker
    expect(resolveTokenMint('CNGN', 'devnet', config({}))).toBeNull();
  });

  it('treats a malformed map as "nothing configured"', () => {
    // #given a malformed JSON map
    // #when resolved
    // #then USDC still uses its default and cNGN stays unconfigured
    expect(resolveTokenMint('USDC', 'devnet', config({ SOLANA_TOKEN_MINTS: '{oops' }))).toBe(
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    );
    expect(resolveTokenMint('CNGN', 'devnet', config({ SOLANA_TOKEN_MINTS: '{oops' }))).toBeNull();
  });

  it('rejects an explicit USDC mint that is not a 32-byte address', () => {
    expect(
      resolveTokenMint('USDC', 'devnet', config({ SOLANA_USDC_MINT: 'not-a-mint' })),
    ).toBeNull();
  });
});

describe('resolveDeploymentFeePolicy', () => {
  it('defaults to not_required with a ten-dollar disclosure', () => {
    // #given no fee configuration
    const policy = resolveDeploymentFeePolicy(
      config({ CAMPAIGN_DEPLOYMENT_FEE_MODE: 'not_required', CAMPAIGN_DEPLOYMENT_FEE_USD: 10 }),
    );

    // #when resolved
    // #then the policy is explicit and formatted, not a float
    expect(policy).toMatchObject({
      amountUsd: '10.00',
      currency: 'USD',
      mode: 'not_required',
    });
  });
});

describe('buildFeeBreakdown', () => {
  const policy = {
    amountUsd: '10.00',
    currency: 'USD' as const,
    mode: 'flat_fee' as const,
    policyVersion: 'inverge.deployment-fee.v1',
  };

  it('shows the real linked charge rather than restating the policy amount', () => {
    // #given a successful charge in another currency
    const lines = buildFeeBreakdown({
      feeChargeConfirmed: true,
      networkFeeLamports: 5_000n,
      platformCharge: { amount: '10000.00', currency: 'NGN' },
      policy,
      rentLamports: 4_078_560n,
    });

    // #when the breakdown is built
    // #then the platform line carries the collected amount and asset
    expect(lines[0]).toMatchObject({
      amount: '10000.00',
      asset: 'NGN',
      id: 'platform_fee',
      state: 'charged',
    });
  });

  it('marks an unconfirmed fee as estimated and keeps the policy amount', () => {
    // #given no confirmed charge
    const lines = buildFeeBreakdown({
      feeChargeConfirmed: false,
      networkFeeLamports: 5_000n,
      policy,
      rentLamports: null,
    });

    // #when built
    // #then the platform line is an estimate and rent is unavailable, not zero
    expect(lines[0]).toMatchObject({ amount: '10.00', asset: 'USD', state: 'estimated' });
    expect(lines[2]).toMatchObject({ amount: 'Unknown', state: 'unavailable' });
  });

  it('separates platform, network and rent lines', () => {
    // #given a not_required deployment
    const lines = buildFeeBreakdown({
      feeChargeConfirmed: false,
      networkFeeLamports: 5_000n,
      policy: { ...policy, mode: 'not_required' },
      rentLamports: 4_078_560n,
    });

    // #when built
    // #then each cost has its own asset and recipient
    expect(lines.map((line) => line.id)).toEqual([
      'platform_fee',
      'network_fee',
      'account_rent',
    ]);
    expect(lines[0]).toMatchObject({ amount: '0.00', state: 'not_charged' });
    expect(lines[1]).toMatchObject({ amount: '5000 lamports', asset: 'SOL' });
    expect(lines[2]).toMatchObject({ amount: '4078560 lamports', asset: 'SOL' });
  });
});
