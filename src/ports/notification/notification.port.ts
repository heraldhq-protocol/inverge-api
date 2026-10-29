// Port: notifications (FR-702). Persisted in-app rows are dispatched through this
// port; the current adapter is the offline stub. Objection-window alerts are
// time-critical (Phase 2).

export interface NotificationMessage {
  toUserId: string;
  template: string; // e.g. "WAITLIST_CONVERSION", "CAMPAIGN_FUNDED"
  data: Record<string, unknown>;
  /**
   * Stable identity for a domain event. Replaying the same event (for example a
   * retried campaign conversion) must not create or dispatch a second row.
   */
  dedupeKey?: string;
}

export interface NotificationPort {
  send(message: NotificationMessage): Promise<void>;
}

export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT');
