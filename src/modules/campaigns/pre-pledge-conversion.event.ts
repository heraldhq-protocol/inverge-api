/**
 * A campaign derived from an idea has become publicly backable.
 *
 * This is the only event that may notify pre-pledgers. A conversion draft,
 * submission for review, or approval is deliberately not this event.
 */
export const IDEA_CONVERTED_TO_CAMPAIGN = 'IDEA_CONVERTED_TO_CAMPAIGN' as const;

export interface IdeaConvertedToCampaignEvent {
  type: typeof IDEA_CONVERTED_TO_CAMPAIGN;
  /** Stable identity for the published campaign transition. */
  eventId: string;
  ideaId: string;
  campaignId: string;
  creatorId: string;
  occurredAt: string;
}

/** The fields a recipient message may quote; all come from the published row. */
export interface PublishedCampaignSnapshot {
  id: string;
  ideaId: string | null;
  creatorId: string;
  title: string;
  summary: string;
  coverImageUrl: string | null;
  targetAmount: { toFixed(decimals: number): string } | null;
  deadline: Date | null;
}
