import { Global, Module } from '@nestjs/common';
import { CacheService, KEY_VALUE_STORE } from './cache.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    RedisService,
    { provide: KEY_VALUE_STORE, useExisting: RedisService },
    CacheService,
  ],
  exports: [RedisService, CacheService, KEY_VALUE_STORE],
})
export class CacheModule {}
