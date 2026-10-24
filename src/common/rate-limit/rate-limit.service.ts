import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { KEY_VALUE_STORE } from '../cache/cache.service';
import { KeyValueStore } from '../cache/key-value-store';
import { RateLimitPolicy } from './rate-limit.policies';

export type RateLimitDecision = {
  allowed: boolean;
  /** Tokens left after this request. */
  remaining: number;
  /** Seconds until one token is available again (0 when allowed). */
  retryAfterSeconds: number;
  source: 'redis' | 'local' | 'unavailable';
};

// Token bucket in one atomic script. A read-modify-write split across GET/SET
// would let two concurrent requests spend the same token.
const TOKEN_BUCKET = `
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])
local values = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(values[1])
local ts = tonumber(values[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end
local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * refillPerMs)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], ttlMs)
return {allowed, tokens}
`;

type Bucket = { tokens: number; updatedAt: number };

const MAX_LOCAL_KEYS = 10_000;

/**
 * Redis-backed token bucket with a bounded per-instance fallback (§7.2).
 *
 * The fallback is intentionally approximate: it enforces per instance, so with
 * N replicas an attacker can spend N buckets. That is documented and acceptable
 * for abuse control; it is never used for the fail-closed policies.
 */
@Injectable()
export class RateLimitService {
  private readonly local = new Map<string, Bucket>();

  constructor(@Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore) {}

  /**
   * Hash the identifier before it becomes a Redis key. Rate limiting needs the
   * IP; analytics and logs must not store it, and neither should a shared cache.
   */
  keyFor(policyName: string, identifier: string): string {
    const digest = createHash('sha256').update(identifier).digest('hex').slice(0, 32);
    return `v1:rl:${policyName}:${digest}`;
  }

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    const capacity = policy.burst;
    const refillPerMs = policy.limit / (policy.windowSeconds * 1_000);
    const now = Date.now();
    const ttlMs = Math.max(policy.windowSeconds * 1_000, 60_000);

    if (this.store.enabled) {
      const result = await this.store.eval(TOKEN_BUCKET, [key], [
        String(capacity),
        String(refillPerMs),
        String(now),
        String(ttlMs),
      ]);

      if (Array.isArray(result) && result.length >= 2) {
        const allowed = Number(result[0]) === 1;
        const tokens = Number(result[1]);
        return {
          allowed,
          remaining: Math.max(0, Math.floor(tokens)),
          retryAfterSeconds: allowed
            ? 0
            : Math.max(1, Math.ceil((1 - tokens) / (refillPerMs * 1_000))),
          source: 'redis',
        };
      }

      if (policy.failClosed) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: 1,
          source: 'unavailable',
        };
      }
    }

    return this.consumeLocal(key, policy, now);
  }

  private consumeLocal(
    key: string,
    policy: RateLimitPolicy,
    now: number,
  ): RateLimitDecision {
    if (this.local.size >= MAX_LOCAL_KEYS) this.prune(now, policy);

    const capacity = policy.burst;
    const refillPerMs = policy.limit / (policy.windowSeconds * 1_000);
    const bucket = this.local.get(key) ?? { tokens: capacity, updatedAt: now };

    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.updatedAt = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.local.set(key, bucket);

    return {
      allowed,
      remaining: Math.max(0, Math.floor(bucket.tokens)),
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil((1 - bucket.tokens) / (refillPerMs * 1_000))),
      source: 'local',
    };
  }

  /** Bound memory under a spray of unique keys: drop the oldest entries. */
  private prune(now: number, policy: RateLimitPolicy): void {
    const idleMs = Math.max(policy.windowSeconds * 1_000, 60_000) * 2;
    for (const [key, bucket] of this.local) {
      if (now - bucket.updatedAt > idleMs) this.local.delete(key);
    }
    if (this.local.size < MAX_LOCAL_KEYS) return;

    const excess = this.local.size - MAX_LOCAL_KEYS + 1_000;
    let removed = 0;
    for (const key of this.local.keys()) {
      this.local.delete(key);
      removed += 1;
      if (removed >= excess) break;
    }
  }
}
