import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformParamsModule } from '../platform-params/platform-params.module';
import { FeedController } from './feed.controller';
import { FeedService } from './feed.service';

@Module({
  imports: [AuthModule, PlatformParamsModule],
  controllers: [FeedController],
  providers: [FeedService],
  exports: [FeedService],
})
export class FeedModule {}
