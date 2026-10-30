import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { IdeasService } from './ideas.service';

@ApiTags('ideas')
@ApiBearerAuth()
@Controller('me/pre-pledges')
@UseGuards(PrivyAuthGuard)
@RateLimit('dashboard')
export class MePrePledgesController {
  constructor(private readonly ideas: IdeasService) {}

  @Get()
  @ApiOperation({ summary: 'List the signed-in user’s non-binding pre-pledges' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    return this.ideas.listMyPrePledges(user.id, Number(limit));
  }
}
