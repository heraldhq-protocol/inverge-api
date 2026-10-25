import type { Request } from 'express';

export type RateLimitPolicyName =
  | 'discovery'
  | 'search'
  | 'auth'
  | 'username'
  | 'signals'
  | 'comments'
  | 'dashboard'
  | 'financial'
  | 'webhook'
  | 'admin'
  | 'analytics_ingest'
  | 'analytics_read'
  | 'analytics_premium'
  | 'analytics_request'
  | 'analytics_admin';

export type RateLimitScope = 'ip' | 'user';

export type RateLimitPolicy = {
  /** Requests allowed per `windowSeconds` once the burst is spent. */
  limit: number;
  windowSeconds: number;
  /** Bucket capacity: the most requests accepted back-to-back. */
  burst: number;
  scope: RateLimitScope;
  /**
   * When Redis is enabled but unreachable, refuse instead of using the local
   * bucket. Reserved for paths where an anonymous unlimited retry is worse than
   * a short outage: session exchange, boosts/fees and admin writes.
   */
  failClosed: boolean;
};

/**
 * One table for every policy (architecture plan §7.2). Controllers either rely on
 * the path-based resolver below or opt in explicitly with `@RateLimit('name')`.
 */
export const RATE_LIMIT_POLICIES: Record<RateLimitPolicyName, RateLimitPolicy> = {
  discovery: { limit: 120, windowSeconds: 60, burst: 30, scope: 'ip', failClosed: false },
  search: { limit: 30, windowSeconds: 60, burst: 10, scope: 'ip', failClosed: false },
  auth: { limit: 10, windowSeconds: 300, burst: 3, scope: 'ip', failClosed: true },
  username: { limit: 20, windowSeconds: 60, burst: 5, scope: 'ip', failClosed: false },
  signals: { limit: 30, windowSeconds: 60, burst: 10, scope: 'user', failClosed: false },
  comments: { limit: 10, windowSeconds: 60, burst: 3, scope: 'user', failClosed: false },
  dashboard: { limit: 60, windowSeconds: 60, burst: 20, scope: 'user', failClosed: false },
  financial: { limit: 5, windowSeconds: 60, burst: 2, scope: 'user', failClosed: true },
  webhook: { limit: 300, windowSeconds: 60, burst: 60, scope: 'ip', failClosed: false },
  admin: { limit: 60, windowSeconds: 60, burst: 10, scope: 'user', failClosed: true },
  // Ingest is already HMAC-authenticated; this bucket bounds a compromised or
  // misconfigured caller without turning a Redis outage into dropped views.
  analytics_ingest: { limit: 600, windowSeconds: 60, burst: 120, scope: 'ip', failClosed: false },
  analytics_read: { limit: 60, windowSeconds: 60, burst: 20, scope: 'user', failClosed: false },
  analytics_premium: { limit: 30, windowSeconds: 60, burst: 10, scope: 'user', failClosed: false },
  // A request is a support workflow, not a page action: five an hour is generous
  // and keeps a retry loop from filling the admin queue.
  analytics_request: { limit: 5, windowSeconds: 3600, burst: 2, scope: 'user', failClosed: false },
  analytics_admin: { limit: 60, windowSeconds: 60, burst: 10, scope: 'user', failClosed: true },
};

const FILTER_QUERY_KEYS = [
  'q',
  'search',
  'category',
  'region',
  'status',
  'sort',
  'topic',
  'tag',
  'tags',
  'minAsk',
  'maxAsk',
  'stage',
];

/**
 * Resolve the policy for a request that did not declare one.
 *
 * `req.route?.path` is the controller pattern (for example `/ideas/:id/support`),
 * so the rules are stable and do not depend on concrete ids.
 */
export function resolveRateLimitPolicy(
  request: Request,
): RateLimitPolicyName | null {
  const path = ((request.route as { path?: unknown } | undefined)?.path ??
    request.path) as string;
  const method = request.method.toUpperCase();

  if (
    path === '/health/live' ||
    path === '/health/ready' ||
    path === '/metrics' ||
    method === 'OPTIONS'
  ) {
    return null;
  }

  if (path === '/auth/check-username') return 'username';
  if (path === '/auth/session') return 'auth';
  if (path === '/auth/me' || path === '/auth/capabilities') return 'dashboard';

  if (path.startsWith('/internal/analytics')) return 'analytics_ingest';
  if (path.startsWith('/admin/analytics')) return 'analytics_admin';
  if (path === '/analytics/access-requests') return 'analytics_request';
  if (path === '/analytics/access') return 'analytics_read';
  if (
    path.includes('/analytics/acquisition') ||
    path.includes('/analytics/geography') ||
    path.includes('/analytics/funnel')
  ) {
    return 'analytics_premium';
  }
  if (path.includes('/analytics/')) return 'analytics_read';

  if (path.startsWith('/admin')) return 'admin';

  if (path === '/flat-fee/webhook' || path === '/kyc/webhook') return 'webhook';

  // Money initiation. A boost purchase is the only live one today.
  if (path === '/ideas/:id/boosts' && method === 'POST') return 'financial';

  if (
    path === '/ideas/:id/support' ||
    path === '/ideas/:id/pre-pledge' ||
    path === '/ideas/:id/boost' ||
    path === '/me/interests' ||
    /\/like$/.test(path)
  ) {
    return 'signals';
  }

  // Comments and survey feedback are user-authored content: the tightest bucket.
  if (
    path.includes('/comments') ||
    path === '/ideas/:id/survey/responses' ||
    path === '/ideas/:id/survey'
  ) {
    return 'comments';
  }

  if (path === '/ideas/:id/insights' || path === '/me/campaigns') {
    return 'dashboard';
  }

  if (path === '/campaigns' && method === 'GET' && request.query.mine === 'true') {
    return 'dashboard';
  }

  if (
    method === 'GET' &&
    (path === '/ideas' || path === '/campaigns' || path === '/feed') &&
    FILTER_QUERY_KEYS.some((key) => request.query[key] !== undefined)
  ) {
    return 'search';
  }

  if (method === 'GET') return 'discovery';

  // Writes that are not explicitly classified still get the signal bucket rather
  // than an unlimited path.
  return 'signals';
}
