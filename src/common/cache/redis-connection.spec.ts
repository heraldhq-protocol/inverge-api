import { redisOptionsFromUrl } from './redis-connection';

describe('redisOptionsFromUrl', () => {
  it('keeps TLS for rediss:// with SNI set to the host', () => {
    expect(
      redisOptionsFromUrl('rediss://default:secret@enabled-lioness-241929.upstash.io:6379'),
    ).toMatchObject({
      host: 'enabled-lioness-241929.upstash.io',
      port: 6379,
      username: 'default',
      password: 'secret',
      tls: { servername: 'enabled-lioness-241929.upstash.io' },
    });
  });

  it('does not enable TLS for a plaintext redis:// URL', () => {
    const options = redisOptionsFromUrl('redis://localhost:6379');
    expect(options).toEqual({
      host: 'localhost',
      port: 6379,
      username: undefined,
      password: undefined,
    });
    expect(options).not.toHaveProperty('tls');
  });

  it('falls back to 6379 when the URL omits the port', () => {
    expect(redisOptionsFromUrl('rediss://default:secret@redis.internal').port).toBe(6379);
  });

  it('percent-decodes credentials', () => {
    expect(redisOptionsFromUrl('rediss://default:p%40ss%3Aword@redis.internal:6380')).toMatchObject(
      { username: 'default', password: 'p@ss:word' },
    );
  });
});
