// Contract for one persisted notification. Delivery is performed by the shared
// email pipeline (`EmailDeliveryService`), which owns idempotency, suppression
// and provider status; there is no second notification adapter to keep in sync.

export interface NotificationMessage {
  toUserId: string;
  /** Resolved by the service at dispatch time; never persisted on the row. */
  toEmail?: string;
  /** Persisted row id, used as the provider idempotency key. */
  notificationId?: string;
  template: string; // e.g. "WAITLIST_CONVERSION", "CAMPAIGN_FUNDED"
  data: Record<string, unknown>;
  /**
   * Stable identity for a domain event. Replaying the same event (for example a
   * retried campaign conversion) must not create or dispatch a second row.
   */
  dedupeKey?: string;
}
