import {
  AnalyticsResourceType,
  AnalyticsSignalType,
  AnalyticsSource,
  ProductAnalyticsEventInput,
  ProductAnalyticsEventName,
} from './product-analytics-event';

/**
 * JSON-safe queue payload. BullMQ cannot serialise a Date or a BigInt, so the
 * worker receives ISO strings and decimal strings and converts them back.
 */
export interface AnalyticsIngestJobEvent {
  eventKey: string;
  name: ProductAnalyticsEventName;
  occurredAt: string;
  userId?: string;
  sessionId?: string;
  ideaId?: string;
  campaignId?: string;
  resourceType?: AnalyticsResourceType;
  resourceId?: string;
  signalType?: AnalyticsSignalType;
  source?: AnalyticsSource;
  position?: number;
  step?: string;
  durationMs?: number;
  queryLength?: number;
  resultCount?: number;
  filterKeys?: string[];
  amountMinor?: string;
  currency?: string;
  countryCode?: string;
}

export interface AnalyticsIngestJobData {
  events: AnalyticsIngestJobEvent[];
}

export function toAnalyticsIngestJobEvent(
  event: ProductAnalyticsEventInput,
): AnalyticsIngestJobEvent {
  const { amountMinor, ...rest } = event;
  return {
    ...rest,
    eventKey: event.eventKey!,
    occurredAt: event.occurredAt.toISOString(),
    ...(amountMinor === undefined
      ? {}
      : { amountMinor: amountMinor.toString() }),
  };
}

export function fromAnalyticsIngestJobEvent(
  event: AnalyticsIngestJobEvent,
): ProductAnalyticsEventInput {
  const { amountMinor, ...rest } = event;
  return {
    ...rest,
    occurredAt: new Date(event.occurredAt),
    ...(amountMinor === undefined ? {} : { amountMinor: BigInt(amountMinor) }),
  };
}
