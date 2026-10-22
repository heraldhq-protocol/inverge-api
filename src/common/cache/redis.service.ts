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

  private get usable(): boolean {
    return (
      this.client !== null &&
      Date.now() >= this.unavailableUntil &&
      (this.client.status === 'ready' || this.client.status === 'wait')
    );
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
    if (!this.usable) return null;
    try {
      return await this.client!.get(key);
    } catch (error) {
      this.trip(error);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (!this.usable) return false;
    try {
      await this.client!.set(key, value, 'EX', Math.max(1, Math.ceil(ttlSeconds)));
      return true;
    } catch (error) {
      this.trip(error);
      return false;
    }
  }

  async del(key: string): Promise<void> {
    if (!this.usable) return;
    try {
      await this.client!.del(key);
    } catch (error) {
      this.trip(error);
    }
  }

  async incr(key: string): Promise<number | null> {
    if (!this.usable) return null;
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
    if (!this.usable) return null;
    try {
      return await this.client!.eval(script, keys.length, ...keys, ...args);
    } catch (error) {
      this.trip(error);
      return null;
    }
  }

  async ping(): Promise<boolean> {
    if (!this.client || Date.now() < this.unavailableUntil) return false;
    try {
      // Readiness must answer quickly even while the connection is being made.
      const result = await Promise.race([
        this.client.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('ping timed out')), 300),
        ),
      ]);
      return result === 'PONG';
    } catch (error) {
      this.trip(error);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    // `quit` waits for a connection that may not exist; disconnect is immediate.
    this.client.disconnect();
  }
}
