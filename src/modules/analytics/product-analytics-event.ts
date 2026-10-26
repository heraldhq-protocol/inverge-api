/**
 * Closed taxonomy and structural validation for product analytics.
 *
 * Views arrive through the signed service-to-service route; confirmed domain
 * events are written after their own transaction commits. This module is the last
 * line of defence against a caller adding a user-authored field (a search query,
 * a comment body, an email) to an event. Only the fields declared below can be
 * persisted.
 */

import { randomUUID } from 'node:crypto';

export const PRODUCT_ANALYTICS_EVENT_NAMES = [
  'PAGE_VIEWED',
  'IDEA_VIEWED',
  'IDEA_SIGNAL',
  'FEEDBACK_SUBMITTED',
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
export type AnalyticsSource = 'feed' | 'search' | 'direct' | 'internal';
export type AnalyticsResourceType = 'IDEA' | 'CAMPAIGN' | 'PAGE';

/**
 * Fixed page keys. A page view must never carry a URL or a route parameter, so a
 * page is identified by this closed vocabulary instead of free text.
 */
export const ANALYTICS_PAGE_KEYS = [
  'home',
  'ideas',
  'idea-detail',
  'campaigns',
  'campaign-detail',
  'creator-dashboard',
  'settings',
  'notifications',
  'auth',
] as const;

export type AnalyticsPageKey = (typeof ANALYTICS_PAGE_KEYS)[number];

export interface ProductAnalyticsEventInput {
  /** Caller idempotency key. Domain rows use their own id; views use a UUID. */
  eventKey?: string;
  name: ProductAnalyticsEventName;
  occurredAt: Date;
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
  amountMinor?: bigint;
  currency?: string;
  countryCode?: string;
}

const MAX_ID_LENGTH = 64;
const MAX_EVENT_KEY_LENGTH = 128;
const MAX_STEP_LENGTH = 40;
const MAX_FILTER_KEYS = 20;
const MAX_FILTER_KEY_LENGTH = 40;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const OLD_EVENT_MS = 90 * 24 * 60 * 60 * 1000;

const SOURCES: AnalyticsSource[] = ['feed', 'search', 'direct', 'internal'];
const RESOURCE_TYPES: AnalyticsResourceType[] = ['IDEA', 'CAMPAIGN', 'PAGE'];

const SHARED_FIELDS = [
  'eventKey',
  'name',
  'occurredAt',
  'userId',
  'sessionId',
  'resourceType',
  'resourceId',
  'countryCode',
];

const ALLOWED_FIELDS: Record<ProductAnalyticsEventName, string[]> = {
  PAGE_VIEWED: ['source'],
  IDEA_VIEWED: ['ideaId', 'source', 'position'],
  IDEA_SIGNAL: ['ideaId', 'signalType'],
  FEEDBACK_SUBMITTED: ['ideaId'],
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
  if (value === undefined || !SOURCES.includes(value)) {
    fail(`source must be one of ${SOURCES.join(', ')}`);
  }
}

function requireStep(value: string | undefined): void {
  if (!value || !/^[a-z][a-z0-9-]{0,39}$/.test(value)) {
    fail(`step must be a lowercase slug of at most ${MAX_STEP_LENGTH} characters`);
  }
}

/**
 * Fills the generic resource pair and the event key. The generic pair is what the
 * aggregate pipeline reads, so every view has one resource regardless of surface.
 */
export function normalizeProductAnalyticsEvent(
  event: ProductAnalyticsEventInput,
): ProductAnalyticsEventInput {
  const normalized: ProductAnalyticsEventInput = {
    ...event,
    eventKey: event.eventKey ?? randomUUID(),
  };

  if (!normalized.resourceType && !normalized.resourceId) {
    if (normalized.ideaId) {
      normalized.resourceType = 'IDEA';
      normalized.resourceId = normalized.ideaId;
    } else if (normalized.campaignId) {
      normalized.resourceType = 'CAMPAIGN';
      normalized.resourceId = normalized.campaignId;
    }
  }

  if (
    normalized.source === undefined &&
    (normalized.name === 'PAGE_VIEWED' ||
      normalized.name === 'IDEA_VIEWED' ||
      normalized.name === 'CAMPAIGN_VIEWED')
  ) {
    normalized.source = 'direct';
  }

  return normalized;
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

  if (event.eventKey !== undefined) {
    if (
      event.eventKey.length === 0 ||
      event.eventKey.length > MAX_EVENT_KEY_LENGTH ||
      !/^[A-Za-z0-9:_-]+$/.test(event.eventKey)
    ) {
      fail(`eventKey must be 1-${MAX_EVENT_KEY_LENGTH} safe characters`);
    }
  }

  if (event.countryCode !== undefined && !/^[A-Z]{2}$/.test(event.countryCode)) {
    fail('countryCode must be an uppercase ISO 3166-1 alpha-2 code');
  }

  if (event.resourceType !== undefined) {
    if (!RESOURCE_TYPES.includes(event.resourceType)) {
      fail(`resourceType must be one of ${RESOURCE_TYPES.join(', ')}`);
    }
    requireId(event.resourceId, 'resourceId');
  } else if (event.resourceId !== undefined) {
    fail('resourceId requires resourceType');
  }

  if (event.resourceType === 'PAGE') {
    if (
      !event.resourceId ||
      !(ANALYTICS_PAGE_KEYS as readonly string[]).includes(event.resourceId)
    ) {
      fail('resourceId must be a known page key');
    }
    if (event.ideaId || event.campaignId) {
      fail('a PAGE resource cannot carry an idea or campaign id');
    }
  }
  if (event.resourceType === 'IDEA' && event.ideaId && event.resourceId !== event.ideaId) {
    fail('resourceId must match ideaId');
  }
  if (
    event.resourceType === 'CAMPAIGN' &&
    event.campaignId &&
    event.resourceId !== event.campaignId
  ) {
    fail('resourceId must match campaignId');
  }

  const allowed = new Set([...SHARED_FIELDS, ...ALLOWED_FIELDS[event.name]]);
  for (const key of Object.keys(event)) {
    if (event[key as keyof ProductAnalyticsEventInput] !== undefined && !allowed.has(key)) {
      fail(`${key} is not a field of ${event.name}`);
    }
  }

  switch (event.name) {
    case 'PAGE_VIEWED':
      if (event.resourceType !== 'PAGE') {
        fail('PAGE_VIEWED requires resourceType PAGE');
      }
      requireSource(event.source);
      break;
    case 'IDEA_SIGNAL':
      requireId(event.ideaId, 'ideaId');
      if (!event.userId) fail('IDEA_SIGNAL is authenticated');
      if (event.signalType !== 'SUPPORT' && event.signalType !== 'PRE_PLEDGE') {
        fail('signalType must be SUPPORT or PRE_PLEDGE');
      }
      break;
    case 'IDEA_VIEWED':
      requireId(event.ideaId, 'ideaId');
      if (event.resourceType !== undefined && event.resourceType !== 'IDEA') {
        fail('IDEA_VIEWED requires an IDEA resource');
      }
      requireSource(event.source);
      break;
    case 'FEEDBACK_SUBMITTED':
      requireId(event.ideaId, 'ideaId');
      if (!event.userId) fail('FEEDBACK_SUBMITTED is authenticated');
      if (event.resourceType !== undefined && event.resourceType !== 'IDEA') {
        fail('FEEDBACK_SUBMITTED requires an IDEA resource');
      }
      break;
    case 'CAMPAIGN_VIEWED':
      requireId(event.campaignId, 'campaignId');
      if (event.resourceType !== undefined && event.resourceType !== 'CAMPAIGN') {
        fail('CAMPAIGN_VIEWED requires a CAMPAIGN resource');
      }
      requireSource(event.source);
      break;
    case 'CAMPAIGN_STEP_STARTED':
      requireId(event.campaignId, 'campaignId');
      if (event.resourceType !== undefined && event.resourceType !== 'CAMPAIGN') {
        fail('CAMPAIGN_STEP_STARTED requires a CAMPAIGN resource');
      }
      requireStep(event.step);
      break;
    case 'CAMPAIGN_STEP_COMPLETED':
      requireId(event.campaignId, 'campaignId');
      if (event.resourceType !== undefined && event.resourceType !== 'CAMPAIGN') {
        fail('CAMPAIGN_STEP_COMPLETED requires a CAMPAIGN resource');
      }
      requireStep(event.step);
      requireCount(event.durationMs, 'durationMs');
      break;
    case 'CONTRIBUTION_STARTED':
      requireId(event.campaignId, 'campaignId');
      if (event.resourceType !== undefined && event.resourceType !== 'CAMPAIGN') {
        fail('CONTRIBUTION_STARTED requires a CAMPAIGN resource');
      }
      break;
    case 'CONTRIBUTION_CONFIRMED':
      requireId(event.campaignId, 'campaignId');
      if (event.resourceType !== undefined && event.resourceType !== 'CAMPAIGN') {
        fail('CONTRIBUTION_CONFIRMED requires a CAMPAIGN resource');
      }
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
