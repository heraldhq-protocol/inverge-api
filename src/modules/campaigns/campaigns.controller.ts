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
import { OptionalPrivyAuthGuard } from '../auth/guards/optional-privy-auth.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { CampaignsService } from './campaigns.service';
import {
  ListCampaignsQueryDto,
  SubmitCampaignDto,
} from './dto/campaign.dto';

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
  @ApiOperation({ summary: 'Get campaign details by ID' })
  get(@Param('id') id: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.campaigns.get(id, user?.id);
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
export class PlatformEscrowController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get('escrow')
  @ApiOperation({ summary: 'Get aggregate platform escrow figures (FR-801)' })
  getEscrowStats() {
    return this.campaigns.getPlatformEscrowStats();
  }
}
