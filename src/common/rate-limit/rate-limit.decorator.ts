import { SetMetadata } from '@nestjs/common';
import { RateLimitPolicyName } from './rate-limit.policies';

export const RATE_LIMIT_KEY = 'inverge:rate-limit-policy';

/**
 * Override the path-based policy for one handler or controller. Use when the
 * route shape is not enough to classify the cost of the operation.
 */
export const RateLimit = (policy: RateLimitPolicyName) =>
  SetMetadata(RATE_LIMIT_KEY, policy);
