/**
 * Closed taxonomy and structural validation for product analytics.
 *
 * There is no public ingestion route. Domain code calls `ProductAnalyticsService`
 * after its own transaction commits, so this module is the last line of defence
 * against a future caller adding a user-authored field (a search query, a comment
 * body, an email) to an event. Only the fields declared below can be persisted.
 */

export const PRODUCT_ANALYTICS_EVENT_NAMES = [
  'IDEA_VIEWED',
  'IDEA_SIGNAL',
  'CAMPAIGN_VIEWED',
  'CAMPAIGN_STEP_STARTED',
  'CAMPAIGN_STEP_COMPLETED',
  'CONTRIBUTION_STARTED',
  'CONTRIBUTION_CONFIRMED',
  'SEARCH_PERFORMED',
] as const;

export type ProductAnalyticsEventName =
  (typeof PRODUCT_ANALYTICS_EVENT_NAMES)[number];

export type AnalyticsSignalType = 'SUPPORT' | 'PRE_PLEDGE';
export type AnalyticsSource = 'feed' | 'search' | 'direct';

export interface ProductAnalyticsEventInput {
  name: ProductAnalyticsEventName;
  occurredAt: Date;
  userId?: string;
  sessionId?: string;
  ideaId?: string;
  campaignId?: string;
  signalType?: AnalyticsSignalType;
  source?: AnalyticsSource;
  position?: number;
  step?: string;
  durationMs?: number;
  queryLength?: number;
  resultCount?: number;
  filterKeys?: string[];
  amountMinor?: bigint;
  currency?: string;
  countryCode?: string;
}

const MAX_ID_LENGTH = 64;
const MAX_STEP_LENGTH = 40;
const MAX_FILTER_KEYS = 20;
const MAX_FILTER_KEY_LENGTH = 40;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const OLD_EVENT_MS = 90 * 24 * 60 * 60 * 1000;

const SHARED_FIELDS = ['name', 'occurredAt', 'userId', 'sessionId', 'countryCode'];

const ALLOWED_FIELDS: Record<ProductAnalyticsEventName, string[]> = {
  IDEA_VIEWED: ['ideaId', 'source', 'position'],
  IDEA_SIGNAL: ['ideaId', 'signalType'],
  CAMPAIGN_VIEWED: ['campaignId', 'source', 'position'],
  CAMPAIGN_STEP_STARTED: ['campaignId', 'step'],
  CAMPAIGN_STEP_COMPLETED: ['campaignId', 'step', 'durationMs'],
  CONTRIBUTION_STARTED: ['campaignId'],
  CONTRIBUTION_CONFIRMED: ['campaignId', 'amountMinor', 'currency'],
  SEARCH_PERFORMED: ['queryLength', 'resultCount', 'filterKeys'],
};

function fail(message: string): never {
  throw new Error(message);
}

function requireId(value: string | undefined, field: string): void {
  if (!value || value.length === 0 || value.length > MAX_ID_LENGTH) {
    fail(`${field} must be 1-${MAX_ID_LENGTH} characters`);
  }
}

function requireCount(value: number | undefined, field: string): void {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    fail(`${field} must be a non-negative integer`);
  }
}

function requireSource(value: AnalyticsSource | undefined): void {
  if (value !== undefined && value !== 'feed' && value !== 'search' && value !== 'direct') {
    fail('source must be feed, search or direct');
  }
}

/** Validates an event against the taxonomy. Throws on misuse; callers drop it. */
export function assertProductAnalyticsEvent(
  event: ProductAnalyticsEventInput,
  now: Date,
): void {
  if (!PRODUCT_ANALYTICS_EVENT_NAMES.includes(event.name)) {
    fail('unknown analytics event name');
  }

  const at = event.occurredAt;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    fail('occurredAt must be a valid date');
  }
  if (at.getTime() > now.getTime() + CLOCK_SKEW_MS) {
    fail('occurredAt is in the future');
  }
  if (at.getTime() < now.getTime() - OLD_EVENT_MS) {
    fail('occurredAt is older than the retention window');
  }

  if (event.userId && event.sessionId) {
    fail('an event is either authenticated or anonymous, never both');
  }
  if (event.userId) requireId(event.userId, 'userId');
  if (event.sessionId) requireId(event.sessionId, 'sessionId');
  if (event.ideaId) requireId(event.ideaId, 'ideaId');
  if (event.campaignId) requireId(event.campaignId, 'campaignId');

  if (event.countryCode !== undefined && !/^[A-Z]{2}$/.test(event.countryCode)) {
    fail('countryCode must be an uppercase ISO 3166-1 alpha-2 code');
  }

  const allowed = new Set([...SHARED_FIELDS, ...ALLOWED_FIELDS[event.name]]);
  for (const key of Object.keys(event)) {
    if (event[key as keyof ProductAnalyticsEventInput] !== undefined && !allowed.has(key)) {
      fail(`${key} is not a field of ${event.name}`);
    }
  }

  switch (event.name) {
    case 'IDEA_SIGNAL':
      requireId(event.ideaId, 'ideaId');
      if (!event.userId) fail('IDEA_SIGNAL is authenticated');
      if (event.signalType !== 'SUPPORT' && event.signalType !== 'PRE_PLEDGE') {
        fail('signalType must be SUPPORT or PRE_PLEDGE');
      }
      break;
    case 'IDEA_VIEWED':
      requireId(event.ideaId, 'ideaId');
      requireSource(event.source);
      break;
    case 'CAMPAIGN_VIEWED':
      requireId(event.campaignId, 'campaignId');
      requireSource(event.source);
      break;
    case 'CAMPAIGN_STEP_STARTED':
      requireId(event.campaignId, 'campaignId');
      if (!event.step || !/^[a-z][a-z0-9-]{0,39}$/.test(event.step)) {
        fail(`step must be a lowercase slug of at most ${MAX_STEP_LENGTH} characters`);
      }
      break;
    case 'CAMPAIGN_STEP_COMPLETED':
      requireId(event.campaignId, 'campaignId');
      if (!event.step || !/^[a-z][a-z0-9-]{0,39}$/.test(event.step)) {
        fail(`step must be a lowercase slug of at most ${MAX_STEP_LENGTH} characters`);
      }
      requireCount(event.durationMs, 'durationMs');
      break;
    case 'CONTRIBUTION_STARTED':
      requireId(event.campaignId, 'campaignId');
      break;
    case 'CONTRIBUTION_CONFIRMED':
      requireId(event.campaignId, 'campaignId');
      if (event.amountMinor === undefined || event.amountMinor < 0n) {
        fail('amountMinor must be a non-negative integer');
      }
      if (!event.currency || !/^[A-Z]{3}$/.test(event.currency)) {
        fail('currency must be an uppercase ISO 4217 code');
      }
      break;
    case 'SEARCH_PERFORMED':
      requireCount(event.queryLength, 'queryLength');
      requireCount(event.resultCount, 'resultCount');
      if (event.filterKeys) {
        if (event.filterKeys.length > MAX_FILTER_KEYS) {
          fail(`filterKeys is limited to ${MAX_FILTER_KEYS} entries`);
        }
        for (const key of event.filterKeys) {
          if (!/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(key)) {
            fail(`filterKeys entries are limited to ${MAX_FILTER_KEY_LENGTH} characters`);
          }
        }
      }
      break;
  }

  if (event.position !== undefined) requireCount(event.position, 'position');
  if (event.durationMs !== undefined) requireCount(event.durationMs, 'durationMs');
  if (event.queryLength !== undefined) requireCount(event.queryLength, 'queryLength');
  if (event.resultCount !== undefined) requireCount(event.resultCount, 'resultCount');
}
