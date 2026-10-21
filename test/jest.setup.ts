// e2e signs in with `stub:` tokens, so the provider is pinned here rather than
// inherited from the developer's .env — which provider adapter a suite exercises
// must not depend on the box it runs on. @nestjs/config gives process.env
// precedence over .env, so this wins.
process.env.WALLET_PROVIDER = 'stub';
