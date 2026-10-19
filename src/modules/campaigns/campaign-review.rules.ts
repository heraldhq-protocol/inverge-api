// FR-304: pure curation rules shared by the service, the DTO guard and tests.
// Review state is deliberately independent of the funding lifecycle - approving a
// campaign clears it for publication, it does not publish or fund it.

export const CAMPAIGN_REVIEW_ACTIONS = [
  'APPROVE',
  'REQUEST_CHANGES',
  'REJECT',
] as const;

export type CampaignReviewActionValue =
  (typeof CAMPAIGN_REVIEW_ACTIONS)[number];

export const CAMPAIGN_REVIEW_REASON_MIN = 20;
export const CAMPAIGN_REVIEW_REASON_MAX = 2000;

// Only a campaign currently in the queue can be decided.
export const DECIDABLE_REVIEW_STATUS = 'IN_REVIEW' as const;

const NEXT_REVIEW_STATUS = {
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
  REJECT: 'REJECTED',
} as const;

export type NextReviewStatus = (typeof NEXT_REVIEW_STATUS)[keyof typeof NEXT_REVIEW_STATUS];

export function isCampaignReviewAction(
  value: unknown,
): value is CampaignReviewActionValue {
  return (
    typeof value === 'string' &&
    (CAMPAIGN_REVIEW_ACTIONS as readonly string[]).includes(value)
  );
}

// Rejection and change requests must tell the creator what to fix. Approval may
// carry an optional note, but never requires one.
export function reviewActionRequiresReason(
  action: CampaignReviewActionValue,
): boolean {
  return action !== 'APPROVE';
}

export function nextReviewStatus(
  action: CampaignReviewActionValue,
): NextReviewStatus {
  return NEXT_REVIEW_STATUS[action];
}

export function normalizeReviewReason(reason?: string | null): string | null {
  const trimmed = reason?.trim();
  return trimmed ? trimmed : null;
}

// Returns a human-readable error, or null when the decision is valid.
export function validateReviewDecision(input: {
  action: CampaignReviewActionValue;
  reason?: string | null;
}): string | null {
  const reason = normalizeReviewReason(input.reason);
  const length = reason?.length ?? 0;

  if (reviewActionRequiresReason(input.action)) {
    if (length < CAMPAIGN_REVIEW_REASON_MIN) {
      return `A reason of at least ${CAMPAIGN_REVIEW_REASON_MIN} characters is required to ${
        input.action === 'REJECT' ? 'reject' : 'request changes to'
      } a campaign`;
    }
  }

  if (length > CAMPAIGN_REVIEW_REASON_MAX) {
    return `A review reason cannot exceed ${CAMPAIGN_REVIEW_REASON_MAX} characters`;
  }

  return null;
}
