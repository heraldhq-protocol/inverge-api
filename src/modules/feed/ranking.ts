// Pure discovery-feed ranking logic (no I/O, unit-testable). This is Stage 2 (ranking)
// and the Stage 3 policy re-rank of the three-stage feed architecture. The service owns
// retrieval (Stage 1) and paid injection wiring; everything statistical lives here so it
// can be tested in isolation and audited.
//
// The organic score is the ONLY thing computed here. Paid placement (injectPaid) is a
// separate step that never touches an organic score — the organic ranking is fully
// computable with all paid placement removed (FR-206a / NFR-15, by construction).
//
// import a shared pure text-similarity helper for content-based personalization.
import { similarity } from '../../ports/dedup/shingle';

// ─────────────────────────────── Params ───────────────────────────────

export interface OrganicWeights {
  prePledge: number;
  velocity: number;
  feedback: number;
  quality: number;
  trust: number;
}

export interface PersonalizationParams {
  min: number;
  max: number;
  categoryBonus: number;
  regionBonus: number;
  similarityBonus: number;
  engagedCorpusMax: number;
}

export interface TrustWeights {
  kyc: number;
  kyb: number;
  cosign: number;
}

export interface FeedRankingParams {
  weights: OrganicWeights;
  dupPenaltyWeight: number;
  velocityBayesC: number;
  feedbackBayesC: number;
  feedbackPriorMean: number;
  gravity: number;
  explorationSlotShare: number;
  explorationBeta: number;
  explorationMinQuality: number;
  perCreatorCap: number;
  categoryMaxShare: number;
}

// ─────────────────────────────── Inputs ───────────────────────────────

// The feed ranks more than one kind of object as the platform matures: ideas at launch
// (Phase 0), and live campaigns from Phase 1+. The scoring math here is deliberately
// object-agnostic — a campaign is just another FeedItemSignals with its own signals wired
// up in the service. Campaign-only signals (delivery track record, milestone health,
// funding proximity) fold into the existing terms/chips when that retrieval path ships.
export type FeedObjectType = 'idea' | 'campaign';

// Per-item signals assembled by the service (Stage 1 → Stage 2 boundary). Raw velocity
// and feedback are passed pre-smoothing so the Bayesian shrinkage stays pure and testable.
export interface FeedItemSignals {
  objectType: FeedObjectType;
  id: string;
  creatorId: string;
  category: string | null;
  region: string | null;
  ageHours: number;
  qualityScore: number; // 0..1
  trustScore: number; // 0..1
  weightedPrePledge: number; // >= 0 (already sybil-weighted upstream — primary anti-gaming defence)
  velocityEvents: number; // supporter accrual within the trailing window
  velocityExposureDays: number; // observation length in days (>0)
  feedbackRatingSum: number; // Σ of RATING answers (1..5)
  feedbackRatingCount: number; // number of RATING answers
  duplicatePenalty: number; // 0..1 near-duplicate penalty
  feedImpressions: number; // >= 0 aggregate exposure (UCB)
  personalizationMultiplier: number; // bounded [min,max], service-computed
  matchReason: 'region' | 'category' | null;
}

export interface FeedChip {
  code: string;
  label: string;
}

export interface RankedFeedEntry {
  objectType: FeedObjectType;
  id: string;
  score: number; // final organic score (post decay); 0 for a paid-only injected slot
  chip: FeedChip;
  exploration: boolean; // filled an exploration (under-exposed) slot
  promoted: boolean; // paid placement (Stage 3) — never affects `score`
  boostTier: string | null;
}

// ─────────────────────────────── Small stats helpers ───────────────────────────────

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function stddev(xs: number[], m = mean(xs)): number {
  if (xs.length < 2) return 0;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

// Returns a standardizer over a fixed pool. When the pool has zero variance every item
// maps to 0 (no signal can dominate on noise) — the normalization step naive feeds skip.
export function standardizer(pool: number[]): (x: number) => number {
  const m = mean(pool);
  const sd = stddev(pool, m);
  if (sd === 0) return () => 0;
  return (x: number) => (x - m) / sd;
}

// SmoothedRate = (events + C·m) / (exposure + C). Shrinks a small-sample rate toward the
// global prior `m`; higher C demands more evidence before an item's own rate is trusted.
export function bayesianSmooth(events: number, exposure: number, C: number, priorMean: number): number {
  const denom = exposure + C;
  return denom <= 0 ? priorMean : (events + C * priorMean) / denom;
}

// UCB: items seen less get a larger bonus that shrinks automatically as exposure accrues.
export function explorationBonus(totalImpressions: number, itemImpressions: number, beta: number): number {
  const total = Math.max(totalImpressions, 1);
  return beta * Math.sqrt(Math.log(total + 1) / (itemImpressions + 1));
}

// Final = Personalised / (age_hours + 2)^gravity.
export function timeDecay(personalised: number, ageHours: number, gravity: number): number {
  return personalised / (Math.max(ageHours, 0) + 2) ** gravity;
}

// ─────────────────────────────── Composable pure pieces ───────────────────────────────

export interface UserInterests {
  categories: string[]; // lowercased
  regions: string[]; // lowercased
}

// Bounded personalization multiplier. A tilt, never a filter: even a strong idea outside a
// backer's region/category still surfaces because the multiplier is clamped to [min,max].
export function personalizationMultiplier(
  item: { category: string | null; region: string | null; text: string },
  interests: UserInterests,
  engagedTexts: string[],
  p: PersonalizationParams,
): { multiplier: number; matchReason: 'region' | 'category' | null } {
  let mult = 1;
  let reason: 'region' | 'category' | null = null;

  const reg = item.region?.toLowerCase();
  if (reg && interests.regions.includes(reg)) {
    mult *= 1 + p.regionBonus;
    reason = 'region'; // region is the stronger "from X" chip signal — takes precedence
  }
  const cat = item.category?.toLowerCase();
  if (cat && interests.categories.includes(cat)) {
    mult *= 1 + p.categoryBonus;
    if (!reason) reason = 'category';
  }
  if (engagedTexts.length && item.text) {
    let best = 0;
    for (const t of engagedTexts.slice(0, p.engagedCorpusMax)) {
      best = Math.max(best, similarity(item.text, t));
    }
    if (best > 0) mult *= 1 + p.similarityBonus * best;
  }

  return { multiplier: clamp(mult, p.min, p.max), matchReason: reason };
}

// TrustScore (0..1) — thin at launch (KYC + co-sign) and ramps as delivery history accrues.
export function computeTrustScore(
  f: { kycVerified: boolean; kybVerifiedClear: boolean; cosign: boolean },
  w: TrustWeights,
): number {
  const s = (f.kycVerified ? w.kyc : 0) + (f.kybVerifiedClear ? w.kyb : 0) + (f.cosign ? w.cosign : 0);
  return clamp(s, 0, 1);
}

// Per-item organic components (kept for chip derivation + auditability).
export interface OrganicBreakdown {
  prePledge: number;
  velocity: number;
  feedback: number;
  quality: number;
  trust: number;
  dup: number; // negative
  organic: number; // Σ of the above
}

// ─────────────────────────────── The pipeline ───────────────────────────────

interface Scored {
  item: FeedItemSignals;
  breakdown: OrganicBreakdown;
  final: number; // post personalization + decay
  ucb: number; // final + exploration bonus (Stage 3 exploration ordering)
}

const EPSILON = 0.01;

// Score the whole candidate pool (Stage 2). Returns per-item organic breakdown + the
// personalised, time-decayed final score, plus a UCB-augmented score for exploration.
export function scorePool(items: FeedItemSignals[], p: FeedRankingParams): Scored[] {
  if (!items.length) return [];

  // Bayesian-smooth the rate signals toward pool/prior means.
  const pooledVelocityRate =
    items.reduce((a, i) => a + i.velocityEvents, 0) /
    Math.max(items.reduce((a, i) => a + i.velocityExposureDays, 0), 1);

  const smoothedVelocity = items.map((i) =>
    bayesianSmooth(i.velocityEvents, i.velocityExposureDays, p.velocityBayesC, pooledVelocityRate),
  );
  const smoothedFeedback = items.map((i) =>
    bayesianSmooth(i.feedbackRatingSum, i.feedbackRatingCount, p.feedbackBayesC, p.feedbackPriorMean),
  );

  // Normalize behavioural signals within the pool (z-score) before combining.
  const zPre = standardizer(items.map((i) => i.weightedPrePledge));
  const zVel = standardizer(smoothedVelocity);
  const zFb = standardizer(smoothedFeedback);

  const w = p.weights;
  const scored: Scored[] = items.map((item, idx) => {
    const breakdown: OrganicBreakdown = {
      prePledge: w.prePledge * zPre(item.weightedPrePledge),
      velocity: w.velocity * zVel(smoothedVelocity[idx]),
      feedback: w.feedback * zFb(smoothedFeedback[idx]),
      quality: w.quality * clamp(item.qualityScore, 0, 1),
      trust: w.trust * clamp(item.trustScore, 0, 1),
      dup: -p.dupPenaltyWeight * clamp(item.duplicatePenalty, 0, 1),
      organic: 0,
    };
    breakdown.organic =
      breakdown.prePledge +
      breakdown.velocity +
      breakdown.feedback +
      breakdown.quality +
      breakdown.trust +
      breakdown.dup;
    return { item, breakdown, final: 0, ucb: 0 };
  });

  // Shift organic to a positive floor before applying the personalization multiplier, so a
  // match (multiplier > 1) can only lift — multiplying a negative z-score would invert it.
  const minOrganic = Math.min(...scored.map((s) => s.breakdown.organic));
  const totalImpressions = items.reduce((a, i) => a + i.feedImpressions, 0);

  for (const s of scored) {
    const shifted = s.breakdown.organic - minOrganic + EPSILON;
    // The multiplier is already bounded by personalizationMultiplier() upstream; floor at 0
    // defensively so it can only ever lift a (now positive) organic score.
    const personalised = shifted * Math.max(0, s.item.personalizationMultiplier);
    s.final = timeDecay(personalised, s.item.ageHours, p.gravity);
    s.ucb = s.final + explorationBonus(totalImpressions, s.item.feedImpressions, p.explorationBeta);
  }
  return scored;
}

// Chip derived from the dominant score component (explainability layer). Because the
// ranking is transparent, we can surface an honest reason for each item.
export function deriveChip(s: Scored): FeedChip {
  const item = s.item;
  // Personalization match takes chip precedence when it actually lifted the score.
  if (item.personalizationMultiplier > 1 && item.matchReason === 'region') {
    return { code: 'REGION', label: item.region ? `From ${item.region}` : 'From your region' };
  }
  if (item.personalizationMultiplier > 1 && item.matchReason === 'category') {
    return { code: 'CATEGORY', label: 'Matches your interests' };
  }
  const b = s.breakdown;
  const dominant = (
    [
      ['prePledge', b.prePledge],
      ['velocity', b.velocity],
      ['feedback', b.feedback],
      ['quality', b.quality],
      ['trust', b.trust],
    ] as const
  ).reduce((best, cur) => (cur[1] > best[1] ? cur : best));
  switch (dominant[0]) {
    case 'prePledge':
      return { code: 'INTENT', label: 'Strong early interest' };
    case 'velocity':
      return { code: 'VELOCITY', label: 'Gaining momentum' };
    case 'feedback':
      return { code: 'FEEDBACK', label: 'Highly rated by backers' };
    case 'quality':
      return { code: 'QUALITY', label: 'Well-crafted pitch' };
    default:
      return { code: 'TRUST', label: 'From a verified creator' };
  }
}

// Diversity + per-creator dedup state for the policy layer.
class PolicyState {
  private creatorCount = new Map<string, number>();
  private categoryCount = new Map<string, number>();
  constructor(
    private readonly perCreatorCap: number,
    private readonly categoryCap: number,
  ) {}

  allows(item: FeedItemSignals): boolean {
    const c = this.creatorCount.get(item.creatorId) ?? 0;
    if (c >= this.perCreatorCap) return false;
    if (item.category) {
      const cat = this.categoryCount.get(item.category) ?? 0;
      if (cat >= this.categoryCap) return false;
    }
    return true;
  }

  place(item: FeedItemSignals): void {
    this.creatorCount.set(item.creatorId, (this.creatorCount.get(item.creatorId) ?? 0) + 1);
    if (item.category) this.categoryCount.set(item.category, (this.categoryCount.get(item.category) ?? 0) + 1);
  }
}

// Pull the next candidate that satisfies diversity/dedup; if none does (e.g. a thin pool
// dominated by one creator/category), fall back to the next available so the page still
// fills rather than leaving empty slots.
function pullNext(order: Scored[], used: Set<string>, policy: PolicyState): Scored | null {
  let fallback: Scored | null = null;
  for (const s of order) {
    if (used.has(s.item.id)) continue;
    if (fallback === null) fallback = s;
    if (policy.allows(s.item)) return s;
  }
  return fallback;
}

// Stage 3 (organic half): build the ranked page. Reserves `explorationSlotShare` of the
// page for under-exposed items chosen by the UCB score (exposure that cannot be bought),
// applies category-diversity + per-creator dedup, and attaches explainability chips.
export function rankFeed(items: FeedItemSignals[], p: FeedRankingParams, take: number): RankedFeedEntry[] {
  const scored = scorePool(items, p);
  if (!scored.length) return [];

  const mainOrder = [...scored].sort((a, b) => b.final - a.final);
  // Exploration order: UCB-dominant → least-exposed first (bounded by a quality floor so we
  // never spend an exploration slot on a low-quality item).
  const exploreOrder = [...scored]
    .filter((s) => s.item.qualityScore >= p.explorationMinQuality)
    .sort((a, b) => b.ucb - a.ucb);

  const n = Math.min(take, scored.length);
  const reserved = Math.min(Math.round(p.explorationSlotShare * n), n);
  const step = reserved > 0 ? Math.max(1, Math.floor(n / reserved)) : 0;

  const perCreatorCap = Math.max(1, p.perCreatorCap);
  const categoryCap = Math.max(1, Math.ceil(p.categoryMaxShare * n));
  const policy = new PolicyState(perCreatorCap, categoryCap);

  const used = new Set<string>();
  const out: RankedFeedEntry[] = [];
  let explorationPlaced = 0;

  for (let pos = 0; pos < n; pos++) {
    // Reserve every `step`-th slot for exploration until the reserved quota is met.
    const isExplorationSlot = step > 0 && explorationPlaced < reserved && pos % step === 0;
    let pick: Scored | null = null;
    let exploration = false;

    if (isExplorationSlot) {
      pick = pullNext(exploreOrder, used, policy);
      if (pick) {
        exploration = true;
        explorationPlaced++;
      }
    }
    if (!pick) pick = pullNext(mainOrder, used, policy);
    if (!pick) break;

    used.add(pick.item.id);
    policy.place(pick.item);
    out.push({
      objectType: pick.item.objectType,
      id: pick.item.id,
      score: pick.final,
      chip: exploration ? { code: 'EXPLORE', label: 'New, worth a look' } : deriveChip(pick),
      exploration,
      promoted: false,
      boostTier: null,
    });
  }
  return out;
}

// ─────────────────────────────── Stage 3: paid injection ───────────────────────────────

export interface PromotedCandidate {
  objectType: FeedObjectType;
  id: string;
  boostTier: string;
}

export interface PaidParams {
  everyN: number;
  maxSlots: number;
}

// Inject clearly-labelled promoted slots into an already-built organic page. Boosts enter
// ONLY here — they never modify a `score`, a signal, or the organic order. Promoted items
// already present organically are skipped (no double placement). The input `organic` is the
// unpaid ranking, always recomputable with paid placement removed.
export function injectPaid(
  organic: RankedFeedEntry[],
  promoted: PromotedCandidate[],
  p: PaidParams,
): RankedFeedEntry[] {
  if (!promoted.length || p.maxSlots <= 0 || p.everyN <= 0) return organic;

  const present = new Set(organic.map((e) => e.id));
  const queue = promoted.filter((c) => !present.has(c.id));
  if (!queue.length) return organic;

  const out: RankedFeedEntry[] = [];
  let injected = 0;
  let qi = 0;
  for (let i = 0; i < organic.length; i++) {
    // Insert a promoted slot before every N-th organic item, up to the frequency cap.
    if (injected < p.maxSlots && qi < queue.length && i > 0 && i % p.everyN === 0) {
      const c = queue[qi++];
      out.push({
        objectType: c.objectType,
        id: c.id,
        score: 0, // paid slot — explicitly outside the organic score space
        chip: { code: 'PROMOTED', label: 'Promoted' },
        exploration: false,
        promoted: true,
        boostTier: c.boostTier,
      });
      injected++;
    }
    out.push(organic[i]);
  }
  return out;
}
