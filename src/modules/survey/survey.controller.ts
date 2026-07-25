import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { SurveyService } from './survey.service';
import { SetSurveyDto, SubmitResponseDto } from './dto/survey.dto';

@ApiTags('survey')
@Controller('ideas/:id/survey')
export class SurveyController {
  constructor(private readonly survey: SurveyService) {}

  @Put()
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  setQuestions(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: SetSurveyDto) {
    return this.survey.setQuestions(user.id, id, dto);
  }

  @Get()
  getQuestions(@Param('id') id: string) {
    return this.survey.getQuestions(id);
  }

  @Post('responses')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  submit(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: SubmitResponseDto) {
    return this.survey.submitResponse(user.id, id, dto);
  }

  @Delete('responses')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  withdraw(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.survey.withdrawResponse(user.id, id);
  }
}
