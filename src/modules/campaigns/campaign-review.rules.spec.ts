import {
  CAMPAIGN_REVIEW_REASON_MAX,
  isCampaignReviewAction,
  nextReviewStatus,
  normalizeReviewReason,
  validateReviewDecision,
} from './campaign-review.rules';

const reason = (length: number) => 'x'.repeat(length);

describe('campaign review rules (FR-304)', () => {
  describe('reason validation', () => {
    it('refuses a change request without a reason', () => {
      expect(validateReviewDecision({ action: 'REQUEST_CHANGES' })).toMatch(
        /at least 20 characters/,
      );
    });

    it('refuses a rejection with a 19-character reason', () => {
      expect(
        validateReviewDecision({ action: 'REJECT', reason: reason(19) }),
      ).toMatch(/at least 20 characters/);
    });

    it('accepts exactly 20 characters, ignoring surrounding whitespace', () => {
      expect(
        validateReviewDecision({
          action: 'REJECT',
          reason: `  ${reason(20)}  `,
        }),
      ).toBeNull();
    });

    it('refuses a reason beyond the maximum', () => {
      expect(
        validateReviewDecision({
          action: 'REQUEST_CHANGES',
          reason: reason(CAMPAIGN_REVIEW_REASON_MAX + 1),
        }),
      ).toMatch(/cannot exceed 2000 characters/);
    });

    it('allows approval without a reason', () => {
      expect(validateReviewDecision({ action: 'APPROVE' })).toBeNull();
    });

    it('still bounds an optional approval note', () => {
      expect(
        validateReviewDecision({
          action: 'APPROVE',
          reason: reason(CAMPAIGN_REVIEW_REASON_MAX + 1),
        }),
      ).toMatch(/cannot exceed 2000 characters/);
    });
  });

  describe('state transitions', () => {
    it('maps each action to its own review state', () => {
      expect(nextReviewStatus('APPROVE')).toBe('APPROVED');
      expect(nextReviewStatus('REQUEST_CHANGES')).toBe('CHANGES_REQUESTED');
      expect(nextReviewStatus('REJECT')).toBe('REJECTED');
    });
  });

  describe('action guard', () => {
    it('accepts only the three review actions', () => {
      expect(isCampaignReviewAction('APPROVE')).toBe(true);
      expect(isCampaignReviewAction('PUBLISH')).toBe(false);
      expect(isCampaignReviewAction(null)).toBe(false);
    });
  });

  describe('normalisation', () => {
    it('trims and treats blank reasons as absent', () => {
      expect(normalizeReviewReason('  fix the budget  ')).toBe('fix the budget');
      expect(normalizeReviewReason('   ')).toBeNull();
      expect(normalizeReviewReason(undefined)).toBeNull();
    });
  });
});
