import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MediaAssetsService } from './media-assets.service';
import { MediaController } from './media.controller';

/**
 * Media assets. The storage provider comes from the global `PortsModule`; this
 * module owns only the asset lifecycle and its authorisation rules.
 */
@Module({
  controllers: [MediaController],
  exports: [MediaAssetsService],
  imports: [forwardRef(() => AuthModule)],
  providers: [MediaAssetsService],
})
export class MediaModule {}
