import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModerationController } from './moderation.controller';
import { ModerationService } from './moderation.service';

// MODERATION_CLASSIFIER_PORT comes from the @Global PortsModule; PrismaService and
// PlatformParamsService are also global. AuthModule provides the PrivyAuthGuard deps.
@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [ModerationController],
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}

