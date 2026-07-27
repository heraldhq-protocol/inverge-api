import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { OptionalPrivyAuthGuard } from '../auth/guards/optional-privy-auth.guard';
import { FeedQueryDto, UpdateInterestsDto } from './dto/feed.dto';
import { FeedService } from './feed.service';

@ApiTags('feed')
@Controller()
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  // Discovery feed. Optional auth: signed-in → personalised; anonymous → global-popular.
  @Get('feed')
  @ApiBearerAuth()
  @UseGuards(OptionalPrivyAuthGuard)
  getFeed(@Req() req: Request, @Query() query: FeedQueryDto) {
    return this.feed.getFeed((req as Request & { user?: AuthenticatedUser }).user, query);
  }

  // Onboarding personalization capture.
  @Put('me/interests')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  updateInterests(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateInterestsDto) {
    return this.feed.updateInterests(user.id, dto);
  }
}
