import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FlatFeeModule } from '../flat-fee/flat-fee.module';
import { KycModule } from '../kyc/kyc.module';
import { MediaModule } from '../media/media.module';
import { AdminCampaignsController } from './admin-campaigns.controller';
import { ApplicationFeeService } from './application-fee.service';
import { CampaignReviewService } from './campaign-review.service';
import { CampaignsController, PlatformController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignDraftsService } from './deployment/campaign-drafts.service';
import { CampaignDeploymentService } from './deployment/campaign-deployment.service';
import {
  CampaignDeploymentController,
  CampaignDraftsController,
} from './deployment/campaign-deployment.controller';

// Deployment reconciliation is time-driven and runs in-process from
// `modules/jobs/periodic-jobs.service.ts`; this module registers no queue.
@Module({
  imports: [
    forwardRef(() => AuthModule),
    FlatFeeModule,
    KycModule,
    MediaModule,
  ],
  controllers: [
    CampaignsController,
    PlatformController,
    AdminCampaignsController,
    CampaignDraftsController,
    CampaignDeploymentController,
  ],
  providers: [
    ApplicationFeeService,
    CampaignsService,
    CampaignReviewService,
    CampaignDraftsService,
    CampaignDeploymentService,
  ],
  exports: [CampaignsService, CampaignDraftsService, CampaignDeploymentService],
})
export class CampaignsModule {}
