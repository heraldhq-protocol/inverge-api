import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';

// BullMQ root connection. Global so feature modules can BullModule.registerQueue()
// against the shared connection. The first registered queue (metrics-snapshot, FR-204a)
// connects Redis at boot; other feature queues (campaign-conversion, notification-dispatch,
// milestone-deadline, onramp/flatfee/kyc-webhook, indexer-reconcile) join as built out.
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const url = new URL(config.get('REDIS_URL', { infer: true }));
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            password: url.password || undefined,
          },
        };
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
