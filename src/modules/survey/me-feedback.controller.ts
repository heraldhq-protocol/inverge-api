import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { SurveyService } from './survey.service';

@ApiTags('survey')
@ApiBearerAuth()
@Controller('me/feedback')
@UseGuards(PrivyAuthGuard)
@RateLimit('dashboard')
export class MeFeedbackController {
  constructor(private readonly survey: SurveyService) {}

  @Get()
  @ApiOperation({ summary: 'List anonymous feedback responses across the caller’s ideas' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    return this.survey.listMyFeedback(user.id, Number(limit));
  }
}
