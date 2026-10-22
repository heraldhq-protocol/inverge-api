import { Inject, Injectable, Logger } from '@nestjs/common';
import { KeyValueStore } from './key-value-store';

export const KEY_VALUE_STORE = Symbol('KEY_VALUE_STORE');

export type CacheStats = {
  hits: number;
  misses: number;
  coalesced: number;
  sets: number;
  readErrors: number;
};

/**
 * Cache-aside reads with a versioned namespace (architecture plan §7.1).
 *
 * Keys are `v1:{namespace}:g{generation}:{key}`. Invalidation increments the
 * generation counter instead of scanning for keys, so there is no `KEYS`/`SCAN`
 * on the hot path and a stale page can never leak across a write.
 *
 * Guarantees:
 * - Redis down or disabled -> the loader runs, the request succeeds.
 * - A cold key on N concurrent requests -> one loader per instance (single-flight).
 * - A cached value is never authoritative for money, identity or authorization;
 *   callers only cache public projections.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly generationMemo = new Map<
    string,
    { value: number; expiresAt: number }
  >();
  private readonly counters: CacheStats = {
    hits: 0,
    misses: 0,
    coalesced: 0,
    sets: 0,
    readErrors: 0,
  };

  constructor(@Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore) {}

  stats(): CacheStats {
    return { ...this.counters };
  }

  private async generation(namespace: string): Promise<number> {
    if (!this.store.enabled) return 0;

    const now = Date.now();
    const memo = this.generationMemo.get(namespace);
    if (memo && memo.expiresAt > now) return memo.value;

    // A missing counter is generation 0. The first invalidation increments it to
    // 1, which is why every key carries the generation it was written under.
    const raw = await this.store.get(`v1:gen:${namespace}`);
    const parsed = raw === null ? 0 : Number(raw);
    const value = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    // Short memo keeps invalidation prompt across instances while removing one
    // Redis round-trip from every read.
    this.generationMemo.set(namespace, {
      value,
      expiresAt: now + 5_000,
    });
    return value;
  }

  async getOrSet<T>(
    namespace: string,
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    if (!this.store.enabled || ttlSeconds <= 0) return loader();

    const fullKey = `v1:${namespace}:g${await this.generation(namespace)}:${key}`;

    const existing = this.inflight.get(fullKey);
    if (existing) {
      this.counters.coalesced += 1;
      return existing as Promise<T>;
    }

    // Register the in-flight promise before the first await, otherwise N
    // requests that all miss Redis at the same time each start their own loader.
    const pending = (async () => {
      const raw = await this.store.get(fullKey);
      if (raw !== null) {
        try {
          this.counters.hits += 1;
          return JSON.parse(raw) as T;
        } catch {
          // A truncated or schema-drifted value is not worth serving.
          this.counters.readErrors += 1;
          await this.store.del(fullKey);
        }
      }

      this.counters.misses += 1;
      const value = await loader();
      const ttl = Math.max(1, Math.round(ttlSeconds * (0.9 + Math.random() * 0.2)));
      const stored = await this.store.set(fullKey, JSON.stringify(value), ttl);
      if (stored) this.counters.sets += 1;
      return value;
    })();

    this.inflight.set(fullKey, pending);
    try {
      return await pending;
    } finally {
      this.inflight.delete(fullKey);
    }
  }

  /**
   * Invalidate every key in a namespace. The increment itself is the only
   * operation; old keys expire on their own TTL.
   */
  async bump(namespace: string): Promise<void> {
    if (!this.store.enabled) return;

    const next = await this.store.incr(`v1:gen:${namespace}`);
    if (next === null) {
      // Redis is unreachable. Every read is also missing, so no stale value can
      // be served; drop the memo so recovery starts from the stored counter.
      this.generationMemo.delete(namespace);
      return;
    }
    this.generationMemo.set(namespace, {
      value: next,
      expiresAt: Date.now() + 5_000,
    });
  }

  /** Best-effort bump used from write paths: never fails the mutation. */
  bumpEventually(namespace: string): void {
    void this.bump(namespace).catch((error: unknown) => {
      this.logger.warn(
        `Cache invalidation failed for ${namespace}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
}
