import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CampaignsController, PlatformEscrowController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [CampaignsController, PlatformEscrowController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
