import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';

// BullMQ root connection. Feature queues (campaign-conversion, notification-dispatch,
// milestone-deadline, onramp-webhook, flatfee-webhook, kyc-webhook, indexer-reconcile)
// register here as they are built out. No queue is registered in Phase 0, so Redis is
// not connected at boot — the idea-validation flow runs without it.
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
