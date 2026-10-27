import { createHash } from 'node:crypto';

/**
 * Canonical campaign terms and identifiers.
 *
 * FR-303 requires a content hash of the campaign terms to be stored on-chain and
 * the milestone/evidence definitions to be immutable once published. The
 * programme accepts `terms_hash: [u8; 32]` and `campaign_id: [u8; 32]` but does
 * not define what those bytes are derived from, so both derivations here are
 * versioned and documented as contract assumptions in
 * `docs/campaign-deployment.md`.
 *
 * Changing any string in this file changes the on-chain terms of every campaign
 * deployed afterwards. Treat the version constants as immutable.
 */

export const CAMPAIGN_TERMS_VERSION = 'inverge.campaign-terms.v1';
export const CAMPAIGN_ID_VERSION = 'inverge.campaign-id.v1';

/** Domain-separated 32-byte campaign id for the programme's `[u8; 32]` field. */
export function campaignIdBytes(campaignId: string): Uint8Array {
  if (!campaignId) throw new Error('campaignId is required');
  return createHash('sha256')
    .update(`${CAMPAIGN_ID_VERSION}:${campaignId}`, 'utf8')
    .digest();
}

export function campaignIdHex(campaignId: string): string {
  return Buffer.from(campaignIdBytes(campaignId)).toString('hex');
}

/**
 * Deterministic JSON: object keys sorted, `undefined` omitted, no Insignificant
 * whitespace. Prisma's `Json` columns do not preserve key insertion order, so a
 * hash of `JSON.stringify(row)` would not be reproducible after a round-trip.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot canonicalise a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item ?? null)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error(`Cannot canonicalise a value of type ${typeof value}`);
}

export interface CampaignTermsMilestone {
  index: number;
  title: string;
  deliverable: string;
  trancheBps: number;
  evidence: string;
  expectedAt: string | null;
}

export interface CampaignTermsInput {
  campaignId: string;
  creatorId: string;
  title: string;
  summary: string;
  tokenType: string;
  /** Atomic units of the funding asset, as a decimal string. */
  targetAmountAtomic: string;
  /** ISO 8601 UTC. */
  deadline: string;
  workingCapitalBps: number;
  objectionWindowDays: number;
  milestones: readonly CampaignTermsMilestone[];
  /** Presentation-only content that backers rely on; included so it cannot drift. */
  story?: unknown;
  rewardTiers?: unknown;
}

/**
 * The exact document hashed on-chain. Every field a backer relies on is present
 * and is written in a normalised form: money is atomic units, timestamps are ISO
 * UTC, percentages are integer basis points.
 */
export function canonicalCampaignTerms(input: CampaignTermsInput): Record<string, unknown> {
  return {
    campaignId: input.campaignId,
    creatorId: input.creatorId,
    deadline: input.deadline,
    milestones: input.milestones.map((milestone) => ({
      deliverable: milestone.deliverable,
      evidence: milestone.evidence,
      expectedAt: milestone.expectedAt,
      index: milestone.index,
      title: milestone.title,
      trancheBps: milestone.trancheBps,
    })),
    objectionWindowDays: input.objectionWindowDays,
    rewardTiers: input.rewardTiers ?? null,
    story: input.story ?? null,
    summary: input.summary,
    targetAmountAtomic: input.targetAmountAtomic,
    title: input.title,
    tokenType: input.tokenType,
    version: CAMPAIGN_TERMS_VERSION,
    workingCapitalBps: input.workingCapitalBps,
  };
}

/** SHA-256 over the canonical document, hex-encoded (64 chars → 32 bytes). */
export function campaignTermsHash(input: CampaignTermsInput): string {
  return createHash('sha256')
    .update(stableJson(canonicalCampaignTerms(input)), 'utf8')
    .digest('hex');
}

/**
 * Converts a decimal amount authored in whole settlement-asset units into the
 * mint's atomic units, without floating point.
 *
 * `decimals` is the mint's own `decimals` field, read from the cluster. It is
 * never assumed: scaling a 6-decimal USDC amount by 2 would deploy a campaign
 * worth one hundredth of what its creator typed.
 */
export function toAtomicUnits(
  amount: { toString(): string } | string,
  decimals: number,
): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid mint decimals: ${decimals}`);
  }
  const raw = typeof amount === 'string' ? amount : amount.toString();
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Amount is not a non-negative decimal value: ${trimmed}`);
  }
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(
      `Amount ${trimmed} has more decimal places than the settlement mint allows (${decimals}).`,
    );
  }
  return BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
}
