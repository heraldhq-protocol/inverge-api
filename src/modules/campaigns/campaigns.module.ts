import { BullModule } from '@nestjs/bullmq';
import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FlatFeeModule } from '../flat-fee/flat-fee.module';
import { KycModule } from '../kyc/kyc.module';
import { envFlag } from '../../config/feature-flags';
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
import {
  CampaignDeploymentReconcileProcessor,
  CampaignDeploymentReconcileScheduler,
  DEPLOYMENT_RECONCILE_QUEUE,
} from './deployment/campaign-deployment-reconciler';

const queueEnabled = envFlag('QUEUE_ENABLED');

@Module({
  imports: [
    forwardRef(() => AuthModule),
    FlatFeeModule,
    KycModule,
    ...(queueEnabled
      ? [BullModule.registerQueue({ name: DEPLOYMENT_RECONCILE_QUEUE })]
      : []),
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
    ...(queueEnabled
      ? [CampaignDeploymentReconcileProcessor, CampaignDeploymentReconcileScheduler]
      : []),
  ],
  exports: [CampaignsService, CampaignDraftsService, CampaignDeploymentService],
})
export class CampaignsModule {}
