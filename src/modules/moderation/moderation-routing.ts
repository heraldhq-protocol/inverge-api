// Pure routing + reason-building for the moderation harness (FR-1004/1005/1006/1007).
// No I/O — unit-testable. The service wraps these with the classifier + persistence.
import { CategoryFinding } from '../../ports/moderation/moderation.port';

export type Decision = 'AUTO_CLEAR' | 'HELD_FOR_REVIEW';

export interface Routing {
  decision: Decision;
  reasonCodes: string[];
}

// Generic, pre-approved AML external text (FR-1007/D2). It discloses nothing about the
// existence or nature of financial-crime review and is not editable into specifics.
export const AML_GENERIC_EXTERNAL =
  'Your submission is under additional review. We will follow up if anything further is needed.';

const uniq = (xs: string[]): string[] => [...new Set(xs)];

// FR-1004: below threshold in all categories AND L1 passed → auto-clear; otherwise hold.
// Auto-rejection is disabled at launch (D1) — a high-risk case HOLDS, it is never rejected.
export function route(
  l1Passed: boolean,
  l1FailureCodes: string[],
  flaggedCategoryCodes: string[],
): Routing {
  if (!l1Passed) {
    return { decision: 'HELD_FOR_REVIEW', reasonCodes: uniq([...l1FailureCodes, ...flaggedCategoryCodes]) };
  }
  if (flaggedCategoryCodes.length > 0) {
    return { decision: 'HELD_FOR_REVIEW', reasonCodes: uniq(flaggedCategoryCodes) };
  }
  return { decision: 'AUTO_CLEAR', reasonCodes: [] };
}

// FR-1006: dual reasons. Internal = full detail (audit/compliance). External = creator-facing,
// and generic whenever a POL-AML flag contributes (FR-1007/D2 — applies to holds too).
export function buildReasons(
  l1FailureCodes: string[],
  categories: CategoryFinding[],
  flaggedCategoryCodes: string[],
): { internalReason: string; externalReason: string } {
  const internalParts: string[] = [];
  if (l1FailureCodes.length) internalParts.push(`L1: ${l1FailureCodes.join(', ')}`);
  for (const c of categories) {
    internalParts.push(`${c.code} (${c.riskScore}): "${c.excerpt ?? '—'}" — ${c.draftReason}`);
  }
  const internalReason = internalParts.join('\n') || 'No findings.';

  const amlContributes = categories.some((c) => c.code === 'POL-AML' && c.riskScore > 0);
  const held = l1FailureCodes.length > 0 || flaggedCategoryCodes.length > 0;

  let externalReason: string;
  if (amlContributes) {
    externalReason = AML_GENERIC_EXTERNAL; // D2: never disclose financial-crime review
  } else if (!held) {
    externalReason = ''; // auto-clear — nothing shown to the creator
  } else {
    const coaching = categories
      .filter((c) => flaggedCategoryCodes.includes(c.code) && c.draftReason)
      .map((c) => c.draftReason)
      .join(' ');
    externalReason = coaching || 'This submission was flagged for review against our content policy.';
  }
  return { internalReason, externalReason };
}

// FR-1005: pre-review brief for the admin queue — L1 outcome + L2 flags with excerpts
// and suggested reason codes.
export function buildBrief(
  kind: string,
  l1Passed: boolean,
  l1FailureCodes: string[],
  categories: CategoryFinding[],
  decision: Decision,
): string {
  const lines = [`Pre-review brief — ${kind} — decision: ${decision}`];
  lines.push(l1Passed ? 'L1 gates: passed' : `L1 gates: HELD (${l1FailureCodes.join(', ')})`);
  if (categories.length === 0) {
    lines.push('L2: no policy flags.');
  } else {
    for (const c of categories) {
      lines.push(`L2 ${c.code} risk=${c.riskScore} excerpt="${c.excerpt ?? ''}" → suggested reason: ${c.code}`);
    }
  }
  return lines.join('\n');
}
