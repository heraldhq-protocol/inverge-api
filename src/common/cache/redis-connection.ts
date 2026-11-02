import type { RedisOptions } from 'ioredis';

/**
 * ioredis options derived from `REDIS_URL`.
 *
 * The scheme carries the transport: `rediss://` means TLS (`Upstash`, Render Key
 * Value, most managed Redis). Building the connection from `host`/`port`/
 * `password` alone drops it and silently dials in plaintext, which a TLS-only
 * endpoint answers by resetting the socket — the client then reports
 * "Connection is closed." forever and Redis looks permanently down.
 *
 * Shared by the cache connection and the BullMQ root connection so the two can
 * never disagree about transport.
 */
export function redisOptionsFromUrl(rawUrl: string): RedisOptions {
  const url = new URL(rawUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    ...(url.protocol === 'rediss:'
      ? {
          // servername is required for SNI; without it a shared TLS frontend
          // (Upstash serves many hosts) cannot select the right certificate.
          tls: { servername: url.hostname },
        }
      : {}),
  };
}
