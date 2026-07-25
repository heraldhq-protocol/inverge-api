import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { InsightsService } from './insights.service';

@ApiTags('insights')
@Controller('ideas/:id/insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get()
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({ summary: 'Creator-only analytics for an idea (chart-ready)' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.insights.getInsights(user.id, id);
  }
}
