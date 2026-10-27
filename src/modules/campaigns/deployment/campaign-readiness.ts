import { createHash } from 'node:crypto';
import {
  DEFAULT_FEE_BPS,
  MAX_MILESTONES,
  MIN_MILESTONES,
  TOTAL_BPS,
  WORKING_CAPITAL_BPS,
} from './anchor-escrow';
import { stableJson } from './campaign-terms';

/**
 * Deployment readiness: everything the programme's `create_campaign` will
 * enforce, checked server-side before a wallet is ever opened.
 *
 * Pure and database-free so the prepare route, the creator UI projection and the
 * tests all read the same facts. A check never guesses a missing value: an
 * incomplete campaign is reported as blocked with a named reason.
 */

export const DEPLOYMENT_OBJECTION_WINDOW_DAYS = 7;

export interface ReadinessMilestone {
  index: number;
  title: string;
  deliverable: string;
  /** Decimal percentage as Prisma returns it, e.g. "25.00". */
  tranchePct: string;
  evidenceDefinition: unknown;
  expectedAt: Date | null;
}

export interface ReadinessCampaign {
  id: string;
  creatorId: string;
  title: string;
  summary: string;
  status: string;
  tokenType: string;
  targetAmount: string;
  deadline: Date;
  workingCapitalPct: string;
  objectionWindowDays: number | null;
  story: unknown;
  milestones: readonly ReadinessMilestone[];
}

export interface ReadinessCheck {
  key: string;
  label: string;
  satisfied: boolean;
  detail: string;
}

export interface ReadinessResult {
  ready: boolean;
  blockers: string[];
  checks: ReadinessCheck[];
  trancheBps: number[];
  workingCapitalBps: number;
}

/** Exact percentage (max 2dp) → integer basis points, with no float path. */
export function percentToBps(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const bps =
    BigInt(whole ?? '0') * 100n + BigInt(fraction.padEnd(2, '0'));
  return bps <= BigInt(TOTAL_BPS) ? Number(bps) : null;
}

/** The evidence definition hash committed on-chain for one milestone. */
export function evidenceHash(definition: unknown): string {
  return createHash('sha256').update(stableJson(definition), 'utf8').digest('hex');
}

function storyStrings(story: unknown): Record<string, string> {
  if (!story || typeof story !== 'object' || Array.isArray(story)) return {};
  const record = story as Record<string, unknown>;
  const strings: Record<string, string> = {};
  for (const key of ['location', 'problem', 'solution', 'beneficiaries']) {
    const value = record[key];
    if (typeof value === 'string') strings[key] = value;
  }
  return strings;
}

export function evaluateDeploymentReadiness(input: {
  campaign: ReadinessCampaign;
  /** The creator's linked Solana address, or null when none is linked. */
  creatorWallet: string | null;
  /** Whether a settlement mint is configured for the campaign's asset. */
  tokenMint: string | null;
  now?: Date;
}): ReadinessResult {
  const { campaign, creatorWallet, tokenMint } = input;
  const now = input.now ?? new Date();
  const checks: ReadinessCheck[] = [];
  const blockers: string[] = [];

  const check = (key: string, label: string, satisfied: boolean, detail: string) => {
    checks.push({ detail, key, label, satisfied });
    if (!satisfied) blockers.push(detail);
  };

  check(
    'owner',
    'Creator account',
    Boolean(campaign.creatorId),
    'The campaign has no creator account.',
  );

  check(
    'lifecycle',
    'Campaign is still a draft',
    campaign.status === 'DRAFT' || campaign.status === 'IN_REVIEW',
    'Only a draft or in-review campaign can be deployed. A published campaign is immutable (FR-303).',
  );

  check(
    'title',
    'Title and summary',
    campaign.title.trim().length >= 3 && campaign.summary.trim().length >= 20,
    'The campaign needs a title and a summary of at least 20 characters.',
  );

  const story = storyStrings(campaign.story);
  check(
    'story',
    'Story',
    ['problem', 'solution', 'beneficiaries', 'location'].every(
      (key) => (story[key] ?? '').trim().length > 0,
    ),
    'The story needs a location, the problem, the solution and who benefits.',
  );

  const target = Number(campaign.targetAmount);
  check(
    'target',
    'Funding target',
    Number.isFinite(target) && target > 0,
    'The funding target must be greater than zero.',
  );

  check(
    'deadline',
    'Funding deadline',
    campaign.deadline.getTime() > now.getTime(),
    'The funding deadline has passed. Choose a future date.',
  );

  check(
    'asset',
    'Funding asset',
    tokenMint !== null,
    `No settlement mint is configured for ${campaign.tokenType}. Set SOLANA_TOKEN_MINTS before deploying.`,
  );

  // Only USDC has confirmed mint, decimals and a 1:1 unit policy in this
  // repository. Treating a cNGN amount as USDC would deploy the wrong sum, so the
  // asset is a blocker until product confirms the conversion.
  check(
    'asset-policy',
    'Settlement asset confirmed',
    campaign.tokenType === 'USDC',
    `Escrow deployment is confirmed for USDC only. ${campaign.tokenType} needs a confirmed mint, decimals and conversion policy.`,
  );

  check(
    'wallet',
    'Creator wallet',
    creatorWallet !== null,
    'Link a Solana wallet before deploying the escrow (the creator pays rent and signs).',
  );

  const milestones = [...campaign.milestones].sort((a, b) => a.index - b.index);
  const countOk = milestones.length >= MIN_MILESTONES && milestones.length <= MAX_MILESTONES;
  check(
    'milestone-count',
    'Milestone plan',
    countOk,
    `The programme accepts ${MIN_MILESTONES}–${MAX_MILESTONES} milestones; this campaign has ${milestones.length}.`,
  );

  const trancheBps = milestones.map((milestone) => percentToBps(milestone.tranchePct) ?? 0);
  const milestoneBpsTotal = trancheBps.reduce((sum, bps) => sum + bps, 0);
  check(
    'tranches',
    'Milestone tranches',
    countOk && trancheBps.every((bps) => bps > 0),
    'Every milestone tranche must be greater than zero.',
  );

  // Milestone weights divide what the fixed working-capital tranche leaves
  // behind, so they total 100% on their own. The programme no longer adds the
  // working-capital bps to this total (create_campaign.rs).
  check(
    'milestone-total',
    'Milestone weights',
    countOk && milestoneBpsTotal === TOTAL_BPS,
    `Milestone tranche weights must total exactly 100% of the post-tranche remainder; this campaign totals ${
      milestoneBpsTotal / 100
    }%.`,
  );

  const detailsOk = milestones.every(
    (milestone) =>
      milestone.title.trim().length > 0 &&
      milestone.deliverable.trim().length > 0 &&
      milestone.evidenceDefinition !== null &&
      milestone.evidenceDefinition !== undefined,
  );
  check(
    'milestone-detail',
    'Milestone evidence',
    countOk && detailsOk,
    'Every milestone needs a title, a deliverable and an evidence definition (FR-302).',
  );

  const datesOk = milestones.every(
    (milestone) => milestone.expectedAt !== null && milestone.expectedAt.getTime() > now.getTime(),
  );
  check(
    'milestone-dates',
    'Milestone dates',
    countOk && datesOk,
    'Every milestone needs a future submission date; the programme stores a deadline per milestone.',
  );

  const workingCapitalBps = percentToBps(campaign.workingCapitalPct) ?? 0;
  check(
    'working-capital',
    'Working capital',
    workingCapitalBps === WORKING_CAPITAL_BPS,
    // FR-503a now fixes the initial tranche at 20% of the original target; it is
    // not a creator-tunable 20–25% band and it does not grow with the raise.
    `The working-capital tranche is fixed at 20% of the target (FR-503a); this campaign sets ${
      workingCapitalBps / 100
    }%.`,
  );

  // The programme hard-codes OBJECTION_WINDOW_SECONDS = 7 days. Recording a
  // different window off-chain would promise backers something the programme
  // will not enforce.
  check(
    'objection-window',
    'Objection window',
    campaign.objectionWindowDays === DEPLOYMENT_OBJECTION_WINDOW_DAYS,
    `The escrow programme fixes the objection window at ${DEPLOYMENT_OBJECTION_WINDOW_DAYS} days (FR-602).`,
  );

  return {
    blockers,
    checks,
    ready: blockers.length === 0,
    trancheBps,
    workingCapitalBps,
  };
}

/**
 * Default fee rate used for the human-readable breakdown only. The programme's
 * `default_fee_bps` is read from `PlatformConfig` at execution time.
 */
export const PLATFORM_SUCCESS_FEE_BPS = DEFAULT_FEE_BPS;
