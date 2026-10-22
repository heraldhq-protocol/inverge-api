import { RateLimitService } from './rate-limit.service';
import { RATE_LIMIT_POLICIES, resolveRateLimitPolicy } from './rate-limit.policies';
import { KeyValueStore } from '../cache/key-value-store';

class FakeStore implements KeyValueStore {
  enabled = true;
  evalResult: unknown = null;
  readonly evalCalls: { script: string; keys: string[]; args: string[] }[] = [];

  async get(): Promise<string | null> {
    return null;
  }
  async set(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {}
  async incr(): Promise<number | null> {
    return 1;
  }
  async ping(): Promise<boolean> {
    return true;
  }
  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    this.evalCalls.push({ script, keys, args });
    return this.evalResult;
  }
}

describe('RateLimitService (§7.2)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the atomic script result when Redis answers', async () => {
    const store = new FakeStore();
    store.evalResult = [1, 4.2];
    const limiter = new RateLimitService(store);

    const decision = await limiter.consume('key', RATE_LIMIT_POLICIES.discovery);

    expect(decision).toEqual({
      allowed: true,
      remaining: 4,
      retryAfterSeconds: 0,
      source: 'redis',
    });
    expect(store.evalCalls).toHaveLength(1);
    expect(store.evalCalls[0].keys).toEqual(['key']);
  });

  it('reports the wait until the next token when the bucket is empty', async () => {
    const store = new FakeStore();
    store.evalResult = [0, 0];
    const limiter = new RateLimitService(store);

    const decision = await limiter.consume('key', RATE_LIMIT_POLICIES.discovery);

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(1);
    expect(decision.source).toBe('redis');
  });

  it('fails closed for money and auth when Redis is enabled but unavailable', async () => {
    const store = new FakeStore();
    store.evalResult = null;
    const limiter = new RateLimitService(store);

    const decision = await limiter.consume('key', RATE_LIMIT_POLICIES.financial);

    expect(decision).toMatchObject({ allowed: false, source: 'unavailable' });
  });

  it('uses the bounded local bucket for non-financial policies on a Redis outage', async () => {
    const store = new FakeStore();
    store.evalResult = null;
    const limiter = new RateLimitService(store);

    const decision = await limiter.consume('key', RATE_LIMIT_POLICIES.discovery);

    expect(decision.source).toBe('local');
    expect(decision.allowed).toBe(true);
  });

  it('enforces the burst capacity locally and refills over time', async () => {
    const store = new FakeStore();
    store.enabled = false;
    const limiter = new RateLimitService(store);
    const policy = {
      ...RATE_LIMIT_POLICIES.discovery,
      limit: 60,
      windowSeconds: 60,
      burst: 3,
    };

    expect((await limiter.consume('k', policy)).allowed).toBe(true);
    expect((await limiter.consume('k', policy)).allowed).toBe(true);
    expect((await limiter.consume('k', policy)).allowed).toBe(true);
    const blocked = await limiter.consume('k', policy);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);

    jest.advanceTimersByTime(1_000);
    expect((await limiter.consume('k', policy)).allowed).toBe(true);
  });

  it('never puts a raw identifier in a Redis key', () => {
    const limiter = new RateLimitService(new FakeStore());
    const key = limiter.keyFor('discovery', 'ip:203.0.113.9');

    expect(key).not.toContain('203.0.113.9');
    expect(key).toMatch(/^v1:rl:discovery:[0-9a-f]{32}$/);
  });
});

describe('resolveRateLimitPolicy (§7.2)', () => {
  const resolve = (
    method: string,
    path: string,
    query: Record<string, unknown> = {},
  ) =>
    resolveRateLimitPolicy({
      method,
      path,
      query,
      route: { path },
    } as never);

  it.each([
    ['POST', '/auth/session', {}, 'auth'],
    ['GET', '/auth/check-username', {}, 'username'],
    ['GET', '/auth/me', {}, 'dashboard'],
    ['POST', '/flat-fee/webhook', {}, 'webhook'],
    ['POST', '/kyc/webhook', {}, 'webhook'],
    ['POST', '/ideas/:id/boosts', {}, 'financial'],
    ['POST', '/ideas/:id/support', {}, 'signals'],
    ['POST', '/ideas/:id/comments', {}, 'comments'],
    ['PUT', '/ideas/:id/survey', {}, 'comments'],
    ['GET', '/ideas/:id/insights', {}, 'dashboard'],
    ['GET', '/campaigns', { mine: 'true' }, 'dashboard'],
    ['GET', '/ideas', { category: 'climate' }, 'search'],
    ['GET', '/ideas', {}, 'discovery'],
    ['PATCH', '/admin/users/:id/role', {}, 'admin'],
  ])('%s %s -> %s', (method, path, query, expected) => {
    expect(resolve(method, path, query as Record<string, unknown>)).toBe(expected);
  });

  it('skips probes and scrape requests', () => {
    expect(resolve('GET', '/health/live')).toBeNull();
    expect(resolve('GET', '/health/ready')).toBeNull();
    expect(resolve('GET', '/metrics')).toBeNull();
  });
});
