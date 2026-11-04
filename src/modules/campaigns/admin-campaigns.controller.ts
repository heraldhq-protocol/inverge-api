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
  @ApiOperation({ summary: 'List campaigns by curation state' })
  list(@Query() query: ListCampaignReviewQueueDto) {
    return this.reviews.listQueue(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Campaign review detail with verification and fee facts and review history',
  })
  detail(@Param('id') id: string) {
    return this.reviews.getForReview(id);
  }

  @Post(':id/review')
  @ApiOperation({
    summary: 'Approve, request changes or reject a campaign',
  })
  decide(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecideCampaignReviewDto,
  ) {
    return this.reviews.decide(admin.id, id, dto);
  }
}
