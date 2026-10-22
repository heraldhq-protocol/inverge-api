import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './create-test-app';
import { CacheService } from '../src/common/cache/cache.service';
import { RedisService } from '../src/common/cache/redis.service';
import { RateLimitService } from '../src/common/rate-limit/rate-limit.service';
import type { RateLimitPolicy } from '../src/common/rate-limit/rate-limit.policies';

/**
 * Redis-backed behaviour is unreachable in the default e2e run, which pins
 * `REDIS_ENABLED=false` to prove graceful degradation. This suite is opt-in:
 *
 *   docker run --rm -d -p 6379:6379 redis:7-alpine
 *   $env:REDIS_E2E="true"; node ./node_modules/jest/bin/jest.js \
 *     --config jest-e2e.config.js test/redis.e2e-spec.ts --runInBand --forceExit
 *
 * It exercises the real ioredis connection, the Lua token bucket and the
 * generation counter; the unit suites use fakes.
 */
const describeRedis =
  process.env.REDIS_E2E === 'true' ? describe : describe.skip;

describeRedis('Redis-backed cache and limiter (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();

    // The client is lazy. On a cold connection the first command can exceed the
    // 250 ms command timeout, which opens the 5 s breaker; that is the intended
    // degradation path, not the state this suite is asserting. Warm it first.
    const redis = app.get(RedisService);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let up = false;
    for (let attempt = 0; attempt < 3 && !up; attempt += 1) {
      up = await redis.ping();
      if (!up) await sleep(5_100);
    }
    expect(up).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('serves the second read from Redis and coalesces concurrent misses', async () => {
    const cache = app.get(CacheService);
    const namespace = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const before = cache.stats();
    let loads = 0;

    const loader = async (value: number) => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { value };
    };

    const [first, second] = await Promise.all([
      cache.getOrSet(namespace, 'item', 60, () => loader(1)),
      cache.getOrSet(namespace, 'item', 60, () => loader(2)),
    ]);

    expect(first).toEqual({ value: 1 });
    expect(second).toEqual(first);
    expect(loads).toBe(1);

    const third = await cache.getOrSet(namespace, 'item', 60, () => loader(3));
    expect(third).toEqual({ value: 1 });
    expect(loads).toBe(1);

    const after = cache.stats();
    expect(after.sets - before.sets).toBe(1);
    expect(after.coalesced - before.coalesced).toBeGreaterThanOrEqual(1);
    expect(after.hits - before.hits).toBeGreaterThanOrEqual(1);
  });

  it('invalidates a namespace by advancing its generation', async () => {
    const cache = app.get(CacheService);
    const namespace = `e2e-bump-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    expect(await cache.getOrSet(namespace, 'item', 60, async () => 'old')).toBe(
      'old',
    );
    await cache.bump(namespace);

    expect(await cache.getOrSet(namespace, 'item', 60, async () => 'new')).toBe(
      'new',
    );
  });

  it('spends tokens in Redis and refuses after the burst', async () => {
    const limiter = app.get(RateLimitService);
    const policy: RateLimitPolicy = {
      limit: 2,
      windowSeconds: 60,
      burst: 2,
      scope: 'ip',
      failClosed: false,
    };
    const key = limiter.keyFor(
      'e2e',
      `identifier-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    const first = await limiter.consume(key, policy);
    const second = await limiter.consume(key, policy);
    const third = await limiter.consume(key, policy);

    expect(first).toMatchObject({ allowed: true, source: 'redis' });
    expect(second).toMatchObject({ allowed: true, source: 'redis' });
    expect(third).toMatchObject({ allowed: false, source: 'redis' });
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reports Redis as up in readiness without making it a hard dependency', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect(response.body.checks).toMatchObject({ database: 'up', redis: 'up' });
    expect(response.body.status).toBe('ok');
  });
});
