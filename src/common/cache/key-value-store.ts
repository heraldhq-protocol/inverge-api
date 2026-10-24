/**
 * The smallest Redis surface the cache and rate limiter need.
 *
 * Keeping this as an interface lets the unit tests exercise cache behaviour
 * (hit/miss, single-flight, outage fallback) without a live Redis. Implementations
 * must never throw: an unreachable Redis is a degraded mode, not a request error.
 */
export interface KeyValueStore {
  /** False when Redis is configured off; callers then skip it entirely. */
  readonly enabled: boolean;

  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number | null>;
  ping(): Promise<boolean>;

  /**
   * Atomic script execution. Used by the token-bucket limiter, where a
   * read-modify-write split across commands would let concurrent requests spend
   * the same token. Returns `null` when Redis is unavailable.
   */
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}
