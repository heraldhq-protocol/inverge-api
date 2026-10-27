import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { OptionalPrivyAuthGuard } from '../auth/guards/optional-privy-auth.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { CampaignsService } from './campaigns.service';
import {
  ListCampaignsQueryDto,
  SubmitCampaignDto,
} from './dto/campaign.dto';
import { PlatformSummaryDto } from './dto/platform-summary.dto';

@ApiTags('campaigns')
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  @UseGuards(OptionalPrivyAuthGuard)
  @ApiOperation({ summary: 'List public campaigns or creator campaigns (mine=true)' })
  list(
    @Query() query: ListCampaignsQueryDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.campaigns.list(query, user?.id);
  }

  @Get(':id')
  @UseGuards(OptionalPrivyAuthGuard)
  @ApiOperation({
    summary: 'Get a public campaign by id or source-idea slug',
    description:
      'A campaign is publicly readable in ACTIVE, FUNDED, FAILED or COMPLETED. A draft, in-review or rejected campaign resolves only for its creator; every other caller receives 404.',
  })
  get(@Param('id') idOrSlug: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.campaigns.get(idOrSlug, user?.id);
  }

  @Post(':id/submit')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({ summary: 'Submit draft campaign for curation review' })
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SubmitCampaignDto,
  ) {
    return this.campaigns.submit(user.id, id, dto);
  }
}

@ApiTags('platform')
@Controller('platform')
export class PlatformController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Get public platform counters',
    description:
      'Counts only: published ideas a visitor can discover, plus active, completed and total public campaigns. ' +
      'No escrow balance, funding total or per-user data is returned. Cached for 60 s; read `asOf` for freshness.',
  })
  @ApiOkResponse({ type: PlatformSummaryDto })
  getSummary() {
    return this.campaigns.getPlatformSummary();
  }

  @Get('escrow')
  @ApiOperation({ summary: 'Get aggregate platform escrow figures (FR-801)' })
  getEscrowStats() {
    return this.campaigns.getPlatformEscrowStats();
  }
}
