import { CacheService } from './cache.service';
import { KeyValueStore } from './key-value-store';

class FakeStore implements KeyValueStore {
  enabled = true;
  fail = false;
  readonly data = new Map<string, string>();
  readonly generations = new Map<string, number>();
  readonly ttls: number[] = [];

  async get(key: string): Promise<string | null> {
    return this.fail ? null : (this.data.get(key) ?? null);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.fail) return false;
    this.ttls.push(ttlSeconds);
    this.data.set(key, value);
    return true;
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  async incr(key: string): Promise<number | null> {
    if (this.fail) return null;
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    return next;
  }

  async ping(): Promise<boolean> {
    return !this.fail;
  }

  async eval(): Promise<unknown> {
    return null;
  }
}

describe('CacheService (§7.1)', () => {
  it('serves a cached value without running the loader twice', async () => {
    const store = new FakeStore();
    const cache = new CacheService(store);
    const loader = jest.fn().mockResolvedValue({ value: 1 });

    const first = await cache.getOrSet('ideas', 'page', 20, loader);
    const second = await cache.getOrSet('ideas', 'page', 20, loader);

    expect(first).toEqual({ value: 1 });
    expect(second).toEqual({ value: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('coalesces concurrent reads of a cold key into one loader call', async () => {
    const store = new FakeStore();
    const cache = new CacheService(store);
    let release!: (value: { value: number }) => void;
    const gate = new Promise<{ value: number }>((resolve) => (release = resolve));
    const loader = jest.fn(() => gate);

    const pending = [1, 2, 3].map(() => cache.getOrSet('ideas', 'page', 20, loader));
    release({ value: 7 });
    const results = await Promise.all(pending);

    expect(results).toEqual([{ value: 7 }, { value: 7 }, { value: 7 }]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stats().coalesced).toBe(2);
  });

  it('does not cache a rejected loader', async () => {
    const store = new FakeStore();
    const cache = new CacheService(store);
    const loader = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true });

    await expect(cache.getOrSet('ideas', 'page', 20, loader)).rejects.toThrow('boom');
    await expect(cache.getOrSet('ideas', 'page', 20, loader)).resolves.toEqual({
      ok: true,
    });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('invalidates a namespace by bumping its generation', async () => {
    const store = new FakeStore();
    const cache = new CacheService(store);
    const loader = jest
      .fn()
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce({ version: 2 });

    await cache.getOrSet('campaigns', 'page', 20, loader);
    await cache.bump('campaigns');
    const fresh = await cache.getOrSet('campaigns', 'page', 20, loader);

    expect(fresh).toEqual({ version: 2 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('falls back to the loader when Redis is disabled', async () => {
    const store = new FakeStore();
    store.enabled = false;
    const cache = new CacheService(store);
    const loader = jest.fn().mockResolvedValue({ value: 1 });

    await cache.getOrSet('ideas', 'page', 20, loader);
    await cache.getOrSet('ideas', 'page', 20, loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(store.data.size).toBe(0);
  });

  it('discards a malformed cached value instead of returning it', async () => {
    const store = new FakeStore();
    const cache = new CacheService(store);
    const key = 'v1:ideas:g0:page';
    store.data.set(key, '{not-json');

    const value = await cache.getOrSet('ideas', 'page', 20, async () => ({ ok: true }));

    expect(value).toEqual({ ok: true });
    expect(cache.stats().readErrors).toBe(1);
  });

  it('jitters the TTL within ±10 % of the requested window', async () => {
    const store = new FakeStore();
    const cache = new CacheService(store);

    await cache.getOrSet('ideas', 'page', 100, async () => ({ ok: true }));

    expect(store.ttls).toHaveLength(1);
    expect(store.ttls[0]).toBeGreaterThanOrEqual(90);
    expect(store.ttls[0]).toBeLessThanOrEqual(110);
  });

  it('still serves reads from Postgres during a Redis outage', async () => {
    const store = new FakeStore();
    store.fail = true;
    const cache = new CacheService(store);
    const loader = jest.fn().mockResolvedValue({ ok: true });

    await expect(cache.getOrSet('ideas', 'page', 20, loader)).resolves.toEqual({
      ok: true,
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
