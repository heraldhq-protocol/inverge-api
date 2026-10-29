// e2e signs in with `stub:` tokens, so the provider is pinned here rather than
// inherited from the developer's .env - which provider adapter a suite exercises
// must not depend on the box it runs on. @nestjs/config gives process.env
// precedence over .env, so this wins.
process.env.WALLET_PROVIDER = 'stub';

// e2e must not require infrastructure that is not part of the assertion. Redis
// is optional at runtime; with these flags the app boots, serves and degrades
// exactly as it would on a box where Redis is down. Queue registration is
// disabled at module-definition time (a BullMQ Worker dials Redis on boot).
//
// `REDIS_E2E=true` opts one run into the Redis-backed suite. The flag is read
// here, before `AppModule` is imported, because module metadata evaluates it.
const redisE2e = process.env.REDIS_E2E === 'true';
process.env.REDIS_ENABLED = redisE2e ? 'true' : 'false';
process.env.QUEUE_ENABLED = 'false';
process.env.RATE_LIMIT_ENABLED = redisE2e ? 'true' : 'false';

// The signed ingest route is exercised by the analytics suite. A fixed test secret
// keeps the HMAC assertion deterministic; production requires its own value.
process.env.ANALYTICS_INGEST_ENABLED = 'true';
process.env.ANALYTICS_INGEST_SECRET =
  'e2e-analytics-ingest-secret-0000000000000000';
process.env.ANALYTICS_READ_ENABLED = 'true';

// The assistant suite must be deterministic and offline. The production guard
// rejects `stub`, but tests run with NODE_ENV=test.
process.env.AI_PROVIDER = 'stub';
process.env.AI_DAILY_REQUESTS_PER_USER = '50';
process.env.AI_DAILY_TOKENS_PER_USER = '1000000';
