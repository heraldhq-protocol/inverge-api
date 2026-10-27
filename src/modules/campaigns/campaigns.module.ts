import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminCampaignsController } from './admin-campaigns.controller';
import { CampaignReviewService } from './campaign-review.service';
import { CampaignsController, PlatformController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [
    CampaignsController,
    PlatformController,
    AdminCampaignsController,
  ],
  providers: [CampaignsService, CampaignReviewService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
