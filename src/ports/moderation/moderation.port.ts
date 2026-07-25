// Port: AI moderation classifier (FR-1003 Layer 2). The port is the committed contract;
// the AI adapter calls an Anthropic-compatible LLM, the stub adapter runs deterministic
// keyword rules. Output is OFF-CHAIN flags only (NFR-17) — advisory to admins, never a
// block or an on-chain action.

// FR-1001 policy taxonomy (normative category codes).
export type PolicyCode =
  | 'POL-SEC' // securities / returns language
  | 'POL-AML' // financial-crime signals
  | 'POL-FRD' // fraud structure
  | 'POL-CAT' // prohibited categories
  | 'POL-IP' // impersonation / infringing
  | 'POL-MIS'; // misleading claims

export const POLICY_CODES: PolicyCode[] = ['POL-SEC', 'POL-AML', 'POL-FRD', 'POL-CAT', 'POL-IP', 'POL-MIS'];

export const POLICY_SCOPE: Record<PolicyCode, string> = {
  'POL-SEC':
    'Securities/returns language: any promise or implication of financial return, profit share, interest, ROI, dividends, or investment framing — including euphemisms ("your money works for you", "get back more than you put in").',
  'POL-AML':
    'Financial-crime signals surfaced in text: solicitation of structuring, mixing/tumbling, sanctioned entities, or moving illicit funds.',
  'POL-FRD':
    'Fraud structure: implausible or missing budgets, fabricated traction/social proof, unverifiable claims, guaranteed outcomes, duplicated/copied campaigns.',
  'POL-CAT':
    'Prohibited categories: weapons, controlled substances, gambling, adult content, political fundraising, token/coin launches, MLM structures, unsubstantiated medical claims.',
  'POL-IP': 'Impersonation of a real person or brand; infringing/plagiarised content.',
  'POL-MIS': 'Misleading claims: unevidenced statements of traction, partnership, endorsement, or capability.',
};

export interface CategoryFinding {
  code: PolicyCode;
  riskScore: number; // 0..1
  excerpt: string | null; // the triggering span, if any
  draftReason: string; // creator-facing draft external reason
}

export interface ModerationResult {
  categories: CategoryFinding[]; // one per flagged category (riskScore may be 0 for cleared)
  maxRisk: number; // max riskScore across categories
  policyVersion: string; // FR-1001: version in force at decision time
  provider: string; // 'stub' | 'ai:<model>'
}

export interface ModeratableContent {
  kind: 'idea' | 'campaign';
  title?: string;
  text: string; // concatenated pitch/campaign text to screen
}

export interface ModerationClassifierPort {
  classify(content: ModeratableContent): Promise<ModerationResult>;
}

export const MODERATION_CLASSIFIER_PORT = Symbol('MODERATION_CLASSIFIER_PORT');

export const POLICY_VERSION = '2026-07-25';

// Shared helpers used by both adapters, so scoring/shape stays consistent.
export const clampRisk = (n: unknown): number => {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return Math.min(1, Math.max(0, x));
};

export function summarize(categories: CategoryFinding[], provider: string): ModerationResult {
  const maxRisk = categories.reduce((m, c) => Math.max(m, c.riskScore), 0);
  return { categories, maxRisk: Math.round(maxRisk * 1e4) / 1e4, policyVersion: POLICY_VERSION, provider };
}
