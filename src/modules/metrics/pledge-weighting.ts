// FR-207/208/210/213/216 — pure pre-pledge weighting logic (no I/O, unit-testable).
// The public "Estimated interest" figure is a weighted estimate, never a raw sum:
//   contribution = min(amountUsd, tier.capUSD) × tier.weight
// The per-account cap does the anti-distortion work; the weight adds the credibility
// gradient. All numbers here come from admin-tunable PlatformParams (calibration loop).

export interface TierConfig {
  id: string;
  weight: number; // 0..1
  capUSD: number; // per-account cap on stated amount, applied in USD
}

export interface PledgeWeightingParams {
  tiers: TierConfig[];
  minAccountAgeHours: number; // FR-213: below this, pledge counts at the floor tier
}

// The subset of a pledger's identity that affects weighting.
export interface PledgerIdentity {
  kycStatus: string; // 'VERIFIED' → top tier
  oauthSubject: string | null; // unique social (FR-212) → SOCIAL tier
  emailVerified: boolean;
  bannedAt: Date | null; // FR-216: banned → excluded entirely
  createdAt: Date; // account age (FR-213)
  pastFunder?: boolean; // has funded a real campaign → top tier (Phase 2+)
}

export interface PledgeInput {
  amountUsd: number;
  pledger: PledgerIdentity;
}

// Launch defaults (docs/srs-pre-pledge-weighting.md §12). EMAIL cap kept deliberately
// small so email-only accounts cannot manipulate the figure.
export const DEFAULT_TIERS: TierConfig[] = [
  { id: 'EMAIL', weight: 0.25, capUSD: 100 },
  { id: 'SOCIAL', weight: 0.7, capUSD: 500 },
  { id: 'VERIFIED', weight: 1.0, capUSD: 1000 },
];
export const DEFAULT_MIN_ACCOUNT_AGE_HOURS = 48;

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const tierById = (tiers: TierConfig[], id: string): TierConfig =>
  tiers.find((t) => t.id === id) ?? tiers[0];

// Highest tier the identity qualifies for, ignoring account age.
export function baseTierId(p: PledgerIdentity): 'EMAIL' | 'SOCIAL' | 'VERIFIED' {
  if (p.kycStatus === 'VERIFIED' || p.pastFunder) return 'VERIFIED';
  if (p.oauthSubject) return 'SOCIAL';
  return 'EMAIL';
}

// Resolve the tier config for a pledger. Returns null if the pledger is excluded
// (banned) — the caller treats a null tier as a zero contribution.
export function resolveTier(
  p: PledgerIdentity,
  params: PledgeWeightingParams,
  now: Date,
): TierConfig | null {
  if (p.bannedAt) return null; // FR-216
  let id = baseTierId(p);
  const ageHours = (now.getTime() - p.createdAt.getTime()) / 3_600_000;
  if (ageHours < params.minAccountAgeHours) id = 'EMAIL'; // FR-213 age floor
  return tierById(params.tiers, id);
}

// Per-pledge contribution to the weighted figure. Negative/NaN amounts clamp to 0.
export function contribution(amountUsd: number, tier: TierConfig | null): number {
  if (!tier) return 0;
  const amt = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
  return round2(Math.min(amt, tier.capUSD) * tier.weight);
}

// Σ contribution over all non-banned pledgers — the FR-207 figure.
export function weightedTotal(
  pledges: PledgeInput[],
  params: PledgeWeightingParams,
  now: Date,
): number {
  let sum = 0;
  for (const p of pledges) sum += contribution(p.amountUsd, resolveTier(p.pledger, params, now));
  return round2(sum);
}

// FR-210: normalize a stated amount to USD. USD passes through; NGN divides by the
// admin/job-refreshed rate. Unknown currencies are rejected by the caller's DTO, but
// we throw defensively here too.
export function normalizeToUsd(amount: number, currency: string, fxNgnPerUsd: number): number {
  if (currency === 'USD') return round2(amount);
  if (currency === 'NGN') {
    if (!(fxNgnPerUsd > 0)) throw new Error('NGN pledge rejected: fx.ngnPerUsd unavailable');
    return round2(amount / fxNgnPerUsd);
  }
  throw new Error(`Unsupported pre-pledge currency: ${currency}`);
}
