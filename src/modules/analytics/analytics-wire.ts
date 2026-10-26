import {
  ProductAnalyticsEventInput,
  ProductAnalyticsEventName,
} from './product-analytics-event';

/**
 * Wire vocabulary for the signed service-to-service ingest route.
 *
 * Only server-observed events are accepted. Confirmed outcomes are emitted by the
 * domain service after its own commit; accepting them here would let a caller
 * inflate support, feedback or backing without a persisted business row.
 */
export const CLIENT_INGEST_WIRE_NAMES = [
  'page_viewed',
  'idea_viewed',
  'campaign_viewed',
  'campaign_step_started',
  'campaign_step_completed',
  'search_performed',
] as const;

export type ClientIngestWireName = (typeof CLIENT_INGEST_WIRE_NAMES)[number];

const WIRE_TO_INTERNAL: Record<ClientIngestWireName, ProductAnalyticsEventName> = {
  page_viewed: 'PAGE_VIEWED',
  idea_viewed: 'IDEA_VIEWED',
  campaign_viewed: 'CAMPAIGN_VIEWED',
  campaign_step_started: 'CAMPAIGN_STEP_STARTED',
  campaign_step_completed: 'CAMPAIGN_STEP_COMPLETED',
  search_performed: 'SEARCH_PERFORMED',
};

/** Names the public brief asks for that the domain owns. Never accepted on ingest. */
export const CONFIRMED_WIRE_NAMES = [
  'idea_supported',
  'idea_upvoted',
  'idea_followed',
  'idea_saved',
  'feedback_submitted',
  'prepledge_created',
  'competition_entry_started',
  'competition_entry_submitted',
  'competition_vote_cast',
  'campaign_backing_started',
  'campaign_backing_completed',
  'share_clicked',
] as const;

export type ConfirmedWireName = (typeof CONFIRMED_WIRE_NAMES)[number];

export function isClientIngestWireName(
  name: string,
): name is ClientIngestWireName {
  return (CLIENT_INGEST_WIRE_NAMES as readonly string[]).includes(name);
}

export function isConfirmedWireName(name: string): name is ConfirmedWireName {
  return (CONFIRMED_WIRE_NAMES as readonly string[]).includes(name);
}

export function toInternalEventName(
  name: ClientIngestWireName,
): ProductAnalyticsEventName {
  return WIRE_TO_INTERNAL[name];
}

/**
 * Converts one validated wire event to the internal shape. `resourceType` and
 * `resourceId` are required on the wire for views; the internal normalizer also
 * fills them from typed ids for domain callers.
 */
export function wireEventToInput(
  event: Omit<ProductAnalyticsEventInput, 'name'> & {
    name: ClientIngestWireName;
  },
): ProductAnalyticsEventInput {
  return {
    ...event,
    name: toInternalEventName(event.name),
  };
}
