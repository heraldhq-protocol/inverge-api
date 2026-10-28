import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { redisOptionsFromUrl } from '../../common/cache/redis-connection';
import { Env } from '../../config/env.validation';

// BullMQ root connection. Global so feature modules can BullModule.registerQueue()
// against the shared connection. The first registered queue (metrics-snapshot, FR-204a)
// connects Redis lazily; other feature queues (campaign-conversion, notification-dispatch,
// milestone-deadline, onramp/flatfee/kyc-webhook, indexer-reconcile) join as built out.
//
// lazyConnect is deliberate: an eager ioredis connection retries forever when Redis is
// unreachable, which hangs boot (and blocks tooling that only needs the module graph,
// such as the OpenAPI emitter). The snapshot scheduler already treats Redis as optional.
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        return {
          connection: {
            // Shared with the cache connection so `rediss://` keeps its TLS.
            ...redisOptionsFromUrl(config.get('REDIS_URL', { infer: true })),
            lazyConnect: true,
          },
        };
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
