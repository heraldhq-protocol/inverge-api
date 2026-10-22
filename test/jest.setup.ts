// e2e signs in with `stub:` tokens, so the provider is pinned here rather than
// inherited from the developer's .env - which provider adapter a suite exercises
// must not depend on the box it runs on. @nestjs/config gives process.env
// precedence over .env, so this wins.
process.env.WALLET_PROVIDER = 'stub';

// e2e must not require infrastructure that is not part of the assertion. Redis
// is optional at runtime; with these flags the app boots, serves and degrades
// exactly as it would on a box where Redis is down. Queue registration is
// disabled at module-definition time (a BullMQ Worker dials Redis on boot).
process.env.REDIS_ENABLED = 'false';
process.env.QUEUE_ENABLED = 'false';
process.env.RATE_LIMIT_ENABLED = 'false';
