import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { AdminGuard } from '../auth/guards/admin.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { CampaignReviewService } from './campaign-review.service';
import {
  DecideCampaignReviewDto,
  ListCampaignReviewQueueDto,
} from './dto/campaign-review.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/campaigns')
@UseGuards(PrivyAuthGuard, AdminGuard)
export class AdminCampaignsController {
  constructor(private readonly reviews: CampaignReviewService) {}

  @Get()
  @ApiOperation({ summary: 'List campaigns by curation state (FR-304)' })
  list(@Query() query: ListCampaignReviewQueueDto) {
    return this.reviews.listQueue(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Campaign review detail with FR-103/FR-311 facts and review history',
  })
  detail(@Param('id') id: string) {
    return this.reviews.getForReview(id);
  }

  @Post(':id/review')
  @ApiOperation({
    summary: 'Approve, request changes or reject a campaign (FR-304)',
  })
  decide(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecideCampaignReviewDto,
  ) {
    return this.reviews.decide(admin.id, id, dto);
  }
}
