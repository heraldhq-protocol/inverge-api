export const VERIFICATION_WEBHOOK_QUEUE = 'verification-webhook';
export const VERIFICATION_RECONCILE_QUEUE = 'verification-reconcile';

/** Payload of a queued webhook apply. No body, no identity data, no provider secret. */
export interface VerificationWebhookJob {
  caseId: string;
  providerRef: string;
  eventId: string | null;
  payloadAuthenticated: boolean;
  /**
   * Provider-reported status, used only as a fallback when the authoritative decision
   * cannot be fetched. It is never trusted when the payload signature did not verify.
   */
  fallbackProviderStatus: string | null;
  fallbackAml: 'CLEAR' | 'IN_REVIEW' | 'FLAGGED' | null;
  occurredAtIso: string;
}
