import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import {
  DeclareJudgeConflictDto,
  SaveEvaluationDto,
  SubmitEvaluationDto,
} from './dto/programme.dto';
import { ProgrammeJudgingService } from './programme-judging.service';

@ApiTags('judging')
@ApiBearerAuth()
@Controller('judge/programmes')
@UseGuards(PrivyAuthGuard)
export class ProgrammeJudgeController {
  constructor(private readonly judging: ProgrammeJudgingService) {}

  @Get()
  @ApiOperation({ summary: 'List programmes the caller is assigned to judge' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.judging.listProgrammes(user.id);
  }

  @Get(':programmeId')
  @ApiOperation({ summary: 'Get the judging workspace and queue' })
  workspace(
    @CurrentUser() user: AuthenticatedUser,
    @Param('programmeId') programmeId: string,
  ) {
    return this.judging.getWorkspace(user, programmeId);
  }

  @Get(':programmeId/entries/:entryId')
  @ApiOperation({
    summary: 'Read one judgeable entry and the caller’s own evaluation',
  })
  entry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('programmeId') programmeId: string,
    @Param('entryId') entryId: string,
  ) {
    return this.judging.getEntry(user, programmeId, entryId);
  }

  @Put(':programmeId/entries/:entryId/evaluation')
  @ApiOperation({ summary: 'Save a draft evaluation' })
  save(
    @CurrentUser() user: AuthenticatedUser,
    @Param('programmeId') programmeId: string,
    @Param('entryId') entryId: string,
    @Body() dto: SaveEvaluationDto,
  ) {
    return this.judging.saveEvaluation(user, programmeId, entryId, dto);
  }

  @Post(':programmeId/entries/:entryId/evaluation/submit')
  @ApiOperation({
    summary: 'Submit a completed evaluation against the published rubric',
  })
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('programmeId') programmeId: string,
    @Param('entryId') entryId: string,
    @Body() dto: SubmitEvaluationDto,
  ) {
    return this.judging.submitEvaluation(user, programmeId, entryId, dto);
  }

  @Post(':programmeId/entries/:entryId/conflict')
  @ApiOperation({
    summary: 'Declare a conflict and be excluded from scoring that entry',
  })
  conflict(
    @CurrentUser() user: AuthenticatedUser,
    @Param('programmeId') programmeId: string,
    @Param('entryId') entryId: string,
    @Body() dto: DeclareJudgeConflictDto,
  ) {
    return this.judging.declareConflict(user, programmeId, entryId, dto);
  }
}
