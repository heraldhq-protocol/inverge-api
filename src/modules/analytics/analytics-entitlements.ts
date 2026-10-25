/**
 * Premium analytics entitlement, kept pure so the API gate and the capabilities
 * payload cannot disagree.
 *
 * Access is granted explicitly. `CreatorTier` is a creator-quality tier, not a
 * billing plan and not an automatic grant. A future paid wall issues the same
 * `APPROVED` grant with `source: 'PAID'` and an `expiresAt`; no report code needs
 * to change. No price, subscription or invoice is implied here.
 */

export const ANALYTICS_PREMIUM_FEATURE = 'analytics.premium';

export type CreatorTier = 'STARTER' | 'TRUSTED' | 'ESTABLISHED';
export type AnalyticsTier = 'basic' | 'premium' | 'admin';
export type AnalyticsAccessStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type AnalyticsAccessSource = 'REQUEST' | 'ADMIN' | 'PAID';
export type AnalyticsRequestStatus =
  | 'NONE'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'NOT_REQUIRED';

export type AnalyticsFeature =
  | 'summary'
  | 'timeseries'
  | 'validation'
  | 'acquisition'
  | 'geography'
  | 'campaign-funnel'
  | 'admin-overview';

const BASIC_FEATURES: readonly AnalyticsFeature[] = [
  'summary',
  'timeseries',
  'validation',
];

const PREMIUM_FEATURES: readonly AnalyticsFeature[] = [
  ...BASIC_FEATURES,
  'acquisition',
  'geography',
  'campaign-funnel',
];

const ADMIN_FEATURES: readonly AnalyticsFeature[] = [
  ...PREMIUM_FEATURES,
  'admin-overview',
];

export interface AnalyticsAccessFacts {
  status: AnalyticsAccessStatus;
  source: AnalyticsAccessSource;
  expiresAt: Date | null;
}

export interface AnalyticsEntitlement {
  tier: AnalyticsTier;
  creatorTier: CreatorTier | null;
  premium: boolean;
  requestStatus: AnalyticsRequestStatus;
  canRequest: boolean;
  available: boolean;
  features: AnalyticsFeature[];
}

export interface AnalyticsEntitlementInput {
  role: 'USER' | 'ADMIN';
  creatorTier?: CreatorTier | null;
  access?: AnalyticsAccessFacts | null;
  available?: boolean;
  now?: Date;
}

function isActive(
  access: AnalyticsAccessFacts | null | undefined,
  now: Date,
): boolean {
  if (!access || access.status !== 'APPROVED') return false;
  return access.expiresAt === null || access.expiresAt.getTime() > now.getTime();
}

export function analyticsEntitlement(
  input: AnalyticsEntitlementInput,
): AnalyticsEntitlement {
  const creatorTier = input.creatorTier ?? null;
  const available = input.available ?? true;
  const now = input.now ?? new Date();

  if (input.role === 'ADMIN') {
    return {
      tier: 'admin',
      creatorTier,
      premium: true,
      requestStatus: 'NOT_REQUIRED',
      canRequest: false,
      available,
      features: [...ADMIN_FEATURES],
    };
  }

  const premium = isActive(input.access, now);
  const requestStatus: AnalyticsRequestStatus = !input.access
    ? 'NONE'
    : input.access.status === 'APPROVED' && !premium
      ? 'EXPIRED'
      : input.access.status;

  return {
    tier: premium ? 'premium' : 'basic',
    creatorTier: creatorTier ?? 'STARTER',
    premium,
    requestStatus,
    canRequest:
      !premium &&
      (requestStatus === 'NONE' ||
        requestStatus === 'REJECTED' ||
        requestStatus === 'EXPIRED'),
    available,
    features: premium ? [...PREMIUM_FEATURES] : [...BASIC_FEATURES],
  };
}

export function hasAnalyticsFeature(
  entitlement: AnalyticsEntitlement,
  feature: AnalyticsFeature,
): boolean {
  return entitlement.features.includes(feature);
}
