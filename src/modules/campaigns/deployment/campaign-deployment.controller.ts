import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { RateLimit } from '../../../common/rate-limit/rate-limit.decorator';
import { PrivyAuthGuard } from '../../auth/guards/privy-auth.guard';
import { CampaignDraftsService } from './campaign-drafts.service';
import { CampaignDeploymentService } from './campaign-deployment.service';
import {
  CreateCampaignDraftDto,
  PrepareDeploymentDto,
  SubmitDeploymentDto,
  UpdateCampaignDraftDto,
} from '../dto/campaign-deployment.dto';

/**
 * Creator-facing campaign draft routes.
 *
 * Every route is authenticated and owner-scoped. `@RateLimit('dashboard')` covers
 * autosave; the money-touching deployment routes use the stricter `financial`
 * policy, which fails closed when Redis is unavailable so an outage cannot become
 * an unlimited retry loop against the cluster.
 */
@ApiTags('campaigns')
@ApiBearerAuth()
@Controller('campaigns')
@UseGuards(PrivyAuthGuard)
export class CampaignDraftsController {
  constructor(private readonly drafts: CampaignDraftsService) {}

  @Post()
  @RateLimit('dashboard')
  @ApiOperation({ summary: 'Create a persistent campaign draft' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCampaignDraftDto,
  ) {
    return this.drafts.create(user.id, dto);
  }

  @Patch(':id')
  @RateLimit('dashboard')
  @ApiOperation({ summary: 'Update a draft with optimistic concurrency (version required)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCampaignDraftDto,
  ) {
    return this.drafts.update(user.id, id, dto);
  }

  @Get(':id/draft')
  @RateLimit('dashboard')
  @ApiOperation({ summary: 'Read the authoritative draft and its deployment readiness' })
  getDraft(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.drafts.getDraft(user.id, id);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RateLimit('financial')
  @ApiOperation({ summary: 'Publish after review approval and verified deployment (FR-304, FR-305)' })
  publish(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.drafts.publish(user.id, id);
  }
}

@ApiTags('campaigns')
@ApiBearerAuth()
@Controller('campaigns/:id/deployment')
@UseGuards(PrivyAuthGuard)
export class CampaignDeploymentController {
  constructor(private readonly deployments: CampaignDeploymentService) {}

  @Get()
  @RateLimit('dashboard')
  @ApiOperation({ summary: 'Read the authoritative deployment status' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.deployments.get(user.id, id);
  }

  @Post('prepare')
  @HttpCode(HttpStatus.OK)
  @RateLimit('financial')
  @ApiOperation({ summary: 'Validate readiness and prepare (or return) a deployment attempt' })
  prepare(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PrepareDeploymentDto,
  ) {
    return this.deployments.prepare(user.id, id, dto.acceptTerms);
  }

  @Post('submit')
  @HttpCode(HttpStatus.OK)
  @RateLimit('financial')
  @ApiOperation({ summary: 'Record a signed transaction and verify it against the cluster' })
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SubmitDeploymentDto,
  ) {
    return this.deployments.submit(user.id, id, dto.signature, dto.attemptId);
  }

  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  @RateLimit('financial')
  @ApiOperation({ summary: 'Re-check a submitted transaction after a timeout or outage' })
  reconcile(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.deployments.reconcile(user.id, id);
  }
}
