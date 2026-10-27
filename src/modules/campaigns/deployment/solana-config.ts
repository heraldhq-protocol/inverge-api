import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.validation';
import { base58ToBytes } from '../../../common/utils/base58.util';
import type { SolanaCluster } from '../../../ports/escrow/escrow-chain.port';

/**
 * Settlement-asset and fee configuration for a deployment.
 *
 * Mints are never guessed at runtime: a token type with no configured mint is a
 * readiness blocker, not a fallback to something else. The two USDC defaults are
 * the canonical Circle mints for each cluster and can be overridden per
 * environment.
 */

const USDC_BY_CLUSTER: Record<SolanaCluster, string> = {
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

function isSolanaAddress(value: string): boolean {
  try {
    return base58ToBytes(value).length === 32;
  } catch {
    return false;
  }
}

function parseMintMap(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && isSolanaAddress(entry[1]),
    );
    return Object.fromEntries(entries);
  } catch {
    // A malformed map is reported as "no mints configured" rather than silently
    // falling back to a default for a different asset.
    return {};
  }
}

export function resolveTokenMint(
  tokenType: string,
  cluster: SolanaCluster,
  config: Pick<ConfigService<Env, true>, 'get'>,
): string | null {
  const overrides = parseMintMap(config.get('SOLANA_TOKEN_MINTS', { infer: true }));
  const direct = overrides[tokenType];
  if (direct) return direct;

  if (tokenType === 'USDC') {
    const explicit = config.get('SOLANA_USDC_MINT', { infer: true })?.trim();
    if (explicit) return isSolanaAddress(explicit) ? explicit : null;
    return USDC_BY_CLUSTER[cluster];
  }

  // cNGN has no canonical on-chain mint in this repository. It is deployable only
  // once an operator configures the exact mint.
  return null;
}

export type DeploymentFeeMode = 'not_required' | 'flat_fee';

export const DEPLOYMENT_FEE_POLICY_VERSION = 'inverge.deployment-fee.v1';

export interface DeploymentFeePolicy {
  mode: DeploymentFeeMode;
  /** Human-readable USD amount, always two decimal places. */
  amountUsd: string;
  currency: 'USD';
  policyVersion: string;
}

export function resolveDeploymentFeePolicy(
  config: Pick<ConfigService<Env, true>, 'get'>,
): DeploymentFeePolicy {
  const mode = config.get('CAMPAIGN_DEPLOYMENT_FEE_MODE', { infer: true });
  const amount = config.get('CAMPAIGN_DEPLOYMENT_FEE_USD', { infer: true });
  return {
    amountUsd: amount.toFixed(2),
    currency: 'USD',
    mode,
    policyVersion: DEPLOYMENT_FEE_POLICY_VERSION,
  };
}

/**
 * The fee breakdown shown before the wallet opens. Every line is labelled with
 * who receives it and which asset pays it, because mixing a platform fee, a
 * network fee and rent into one number is how creators get surprised.
 */
export interface FeeBreakdownLine {
  id: 'platform_fee' | 'network_fee' | 'account_rent';
  label: string;
  amount: string;
  asset: string;
  recipient: string;
  state: 'charged' | 'estimated' | 'not_charged' | 'unavailable';
  detail: string;
}

export function buildFeeBreakdown(input: {
  policy: DeploymentFeePolicy;
  feeChargeConfirmed: boolean;
  /** The linked FR-311 charge, when one exists. Its amount and currency win. */
  platformCharge?: { amount: string; currency: string } | null;
  networkFeeLamports: bigint | null;
  rentLamports: bigint | null;
}): FeeBreakdownLine[] {
  const { policy } = input;
  const charge = input.feeChargeConfirmed ? (input.platformCharge ?? null) : null;

  const platformLine: FeeBreakdownLine =
    policy.mode === 'not_required'
      ? {
          amount: '0.00',
          asset: 'USD',
          detail:
            'No separate deployment fee is being collected. The campaign application fee is charged separately at review submission (FR-311).',
          id: 'platform_fee',
          label: 'Inverge deployment fee',
          recipient: 'Inverge',
          state: 'not_charged',
        }
      : {
          // Never restate the policy amount over a real charge: the creator must
          // see exactly what was collected, in the asset it was collected in.
          amount: charge?.amount ?? policy.amountUsd,
          asset: charge?.currency ?? 'USD',
          detail: charge
            ? 'A successful application-fee payment is linked to this campaign.'
            : 'A successful application-fee payment is required before deployment.',
          id: 'platform_fee',
          label: 'Inverge deployment fee',
          recipient: 'Inverge',
          state: charge ? 'charged' : 'estimated',
        };

  return [
    platformLine,
    {
      amount:
        input.networkFeeLamports === null
          ? 'Unknown'
          : `${input.networkFeeLamports.toString()} lamports`,
      asset: 'SOL',
      detail:
        'Paid to the Solana network for the signature. Quoted from the cluster; it can change before the transaction lands.',
      id: 'network_fee',
      label: 'Network transaction fee',
      recipient: 'Solana validators',
      state: input.networkFeeLamports === null ? 'unavailable' : 'estimated',
    },
    {
      amount:
        input.rentLamports === null ? 'Unknown' : `${input.rentLamports.toString()} lamports`,
      asset: 'SOL',
      detail:
        'Refundable rent for the campaign account and its escrow vault, paid from your wallet when the transaction confirms.',
      id: 'account_rent',
      label: 'Account rent',
      recipient: 'Solana (refundable while the accounts exist)',
      state: input.rentLamports === null ? 'unavailable' : 'estimated',
    },
  ];
}
