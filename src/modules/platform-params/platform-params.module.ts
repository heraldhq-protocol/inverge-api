import { Global, Module } from '@nestjs/common';
import { PlatformParamsService } from './platform-params.service';

// Global: params are cross-cutting config consumed by Ideas, Boosts, Sync, Admin.
@Global()
@Module({
  providers: [PlatformParamsService],
  exports: [PlatformParamsService],
})
export class PlatformParamsModule {}
