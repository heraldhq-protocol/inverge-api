import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Env } from '../../config/env.validation';
import { KeyValueStore } from './key-value-store';

/**
 * Redis connection for cache and rate-limit state (architecture plan §7.1–7.2).
 *
 * Redis is optional infrastructure. Every failure mode here is bounded:
 *
 * - `lazyConnect` — importing the module never dials Redis on boot.
 * - `enableOfflineQueue: false` — a command against a dead connection fails
 *   immediately instead of queueing for the duration of an outage.
 * - `maxRetriesPerRequest: 1` and a short connect timeout — a request never
 *   waits on a TCP retry loop.
 * - a 5 s breaker after a failure — a dead Redis costs one timeout per instance
 *   per window, not one per request.
 *
 * No method throws. Callers get `null`/`false` and fall back to Postgres or the
 * in-process rate-limit bucket.
 */
@Injectable()
export class RedisService implements KeyValueStore, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis | null;
  private readonly breakerMs = 5_000;
  private unavailableUntil = 0;
  private warned = false;
  private lastError: string | null = null;

  readonly enabled: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.enabled = config.get('REDIS_ENABLED', { infer: true });

    if (!this.enabled) {
      this.client = null;
      return;
    }

    const url = new URL(config.get('REDIS_URL', { infer: true }));
    this.client = new Redis({
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password || undefined,
      username: url.username || undefined,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
      commandTimeout: 250,
      // Reconnect in the background but never block a request on it.
      retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
    });

    // ioredis logs unhandled connection errors to stderr by default. A cache
    // outage must be a metric and one warning, not a log flood.
    this.client.on('error', (error: Error) => {
      this.lastError = error.message;
      this.unavailableUntil = Date.now() + this.breakerMs;
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          `Redis unavailable; continuing without cache/queue state (${error.message}).`,
        );
      }
    });
    this.client.on('ready', () => {
      this.warned = false;
      this.lastError = null;
      this.unavailableUntil = 0;
    });
  }

  /**
   * A lazy client starts in `wait`; issuing a command before it connects fails
   * immediately with `enableOfflineQueue: false`. Establish the connection on
   * first use instead, bounded by the 500 ms connect timeout, so the first cache
   * read (and the readiness probe) sees a usable client rather than tripping the
   * breaker and bypassing the cache for the next five seconds.
   */
  private async connectIfNeeded(): Promise<boolean> {
    if (!this.client || Date.now() < this.unavailableUntil) return false;
    if (this.client.status === 'ready') return true;
    if (this.client.status !== 'wait') return false;

    try {
      await this.client.connect();
      return String(this.client.status) === 'ready';
    } catch (error) {
      this.trip(error);
      return false;
    }
  }

  private trip(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.unavailableUntil = Date.now() + this.breakerMs;
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        `Redis command failed; using fallbacks (${this.lastError}).`,
      );
    }
  }

  /** Last connection/command error, for the readiness probe. Never a secret. */
  status(): { enabled: boolean; breakerOpen: boolean; lastError: string | null } {
    return {
      enabled: this.enabled,
      breakerOpen: this.enabled && Date.now() < this.unavailableUntil,
      lastError: this.lastError,
    };
  }

  async get(key: string): Promise<string | null> {
    if (!(await this.connectIfNeeded())) return null;
    try {
      return await this.client!.get(key);
    } catch (error) {
      this.trip(error);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (!(await this.connectIfNeeded())) return false;
    try {
      await this.client!.set(key, value, 'EX', Math.max(1, Math.ceil(ttlSeconds)));
      return true;
    } catch (error) {
      this.trip(error);
      return false;
    }
  }

  async del(key: string): Promise<void> {
    if (!(await this.connectIfNeeded())) return;
    try {
      await this.client!.del(key);
    } catch (error) {
      this.trip(error);
    }
  }

  async incr(key: string): Promise<number | null> {
    if (!(await this.connectIfNeeded())) return null;
    try {
      return await this.client!.incr(key);
    } catch (error) {
      this.trip(error);
      return null;
    }
  }

  async eval(
    script: string,
    keys: string[],
    args: string[],
  ): Promise<unknown> {
    if (!(await this.connectIfNeeded())) return null;
    try {
      return await this.client!.eval(script, keys.length, ...keys, ...args);
    } catch (error) {
      this.trip(error);
      return null;
    }
  }

  async ping(): Promise<boolean> {
    if (!(await this.connectIfNeeded())) return false;
    try {
      // A cold lazy connection can take longer than a cache command timeout.
      // Readiness gets a full second; it must not open the breaker, because a
      // slow probe would then bypass the cache and amplify database load.
      const result = await Promise.race([
        this.client!.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('ping timed out')), 1_000),
        ),
      ]);
      return result === 'PONG';
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    // `quit` waits for a connection that may not exist; disconnect is immediate.
    this.client.disconnect();
  }
}
