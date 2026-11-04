import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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
import { AdminProgrammesService } from './admin-programmes.service';
import {
  AdminEntryDecisionDto,
  AssignJudgeDto,
  CreateProgrammeDto,
  CuratedRankDto,
  ListAdminProgrammesQueryDto,
  ProgrammeAnnouncementDto,
  ProgrammeEntryListQueryDto,
  ProgrammePrizeDto,
  ProgrammeSponsorDto,
  PublishResultsDto,
  UpdateProgrammeDto,
  UpdateProgrammePrizeDto,
  UpdateProgrammeSponsorDto,
  UpdateProgrammeStatusDto,
} from './dto/programme.dto';
import { ProgrammeResultsService } from './programme-results.service';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/programmes')
@UseGuards(PrivyAuthGuard, AdminGuard)
export class AdminProgrammesController {
  constructor(
    private readonly programmes: AdminProgrammesService,
    private readonly results: ProgrammeResultsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List programmes for administration' })
  list(@Query() query: ListAdminProgrammesQueryDto) {
    return this.programmes.list(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a draft programme (FR-1201)' })
  create(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: CreateProgrammeDto,
  ) {
    return this.programmes.create(admin.id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a programme with its internal configuration' })
  get(@Param('id') id: string) {
    return this.programmes.get(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a programme with optimistic concurrency',
    description:
      'The rubric and weighting lock once judging starts. Send the version you loaded; a stale version fails rather than overwriting a colleague.',
  })
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateProgrammeDto,
  ) {
    return this.programmes.update(admin.id, id, dto);
  }

  @Post(':id/status')
  @ApiOperation({
    summary: 'Move a programme through its lifecycle',
    description:
      'Opening registration validates the timeline, rubric and prize funding. Judging requires an assigned judge and a complete rubric.',
  })
  transition(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateProgrammeStatusDto,
  ) {
    return this.programmes.transition(admin.id, id, dto);
  }

  @Get(':id/entries')
  @ApiOperation({ summary: 'List every entry, including drafts and notes' })
  entries(
    @Param('id') id: string,
    @Query() query: ProgrammeEntryListQueryDto,
  ) {
    return this.programmes.listEntries(id, query);
  }

  @Post(':id/entries/:entryId/decision')
  @ApiOperation({
    summary: 'Shortlist, request changes, accept, reject or disqualify an entry',
  })
  decideEntry(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Body() dto: AdminEntryDecisionDto,
  ) {
    return this.programmes.decideEntry(admin.id, id, entryId, dto);
  }

  @Post(':id/entries/:entryId/curated-rank')
  @ApiOperation({ summary: 'Set the authorised order for a CURATED programme' })
  curatedRank(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Body() dto: CuratedRankDto,
  ) {
    return this.programmes.setCuratedRank(admin.id, id, entryId, dto);
  }

  @Post(':id/judges')
  @ApiOperation({ summary: 'Assign a judge to the panel (FR-1205)' })
  assignJudge(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssignJudgeDto,
  ) {
    return this.programmes.assignJudge(admin.id, id, dto);
  }

  @Delete(':id/judges/:assignmentId')
  @ApiOperation({ summary: 'Exclude a judge without deleting the audit trail' })
  removeJudge(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
  ) {
    return this.programmes.removeJudge(admin.id, id, assignmentId);
  }

  @Get(':id/results/preview')
  @ApiOperation({
    summary: 'Recompute standings without publishing them',
    description:
      'Missing evaluations are listed with a reason; they are not scored as zero unless the programme explicitly chose ZERO.',
  })
  previewResults(@Param('id') id: string) {
    return this.results.preview(id);
  }

  @Post(':id/results/publish')
  @ApiOperation({
    summary: 'Publish an immutable, checksummed result revision',
  })
  publishResults(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PublishResultsDto,
  ) {
    return this.results.publish(
      admin.id,
      id,
      dto.notes,
      dto.visibility ?? 'PUBLIC',
    );
  }

  @Post(':id/results/unpublish')
  @ApiOperation({ summary: 'Hide published results without deleting them' })
  unpublishResults(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.results.unpublish(admin.id, id);
  }

  @Get(':id/report')
  @ApiOperation({
    summary: 'Aggregate-only sponsor report (FR-1212/FR-1213)',
  })
  report(@Param('id') id: string) {
    return this.results.aggregateReport(id);
  }

  @Get(':id/analytics')
  @ApiOperation({ summary: 'Programme metrics view (FR-1216)' })
  analytics(@Param('id') id: string) {
    return this.programmes.analytics(id);
  }

  @Get(':id/audit')
  @ApiOperation({ summary: 'Programme audit trail' })
  audit(@Param('id') id: string) {
    return this.programmes.auditLog(id);
  }

  @Post(':id/prizes')
  @ApiOperation({ summary: 'Add a prize or benefit (FR-1206)' })
  addPrize(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ProgrammePrizeDto,
  ) {
    return this.programmes.addPrize(admin.id, id, dto);
  }

  @Patch(':id/prizes/:prizeId')
  @ApiOperation({ summary: 'Update a prize or its funding status' })
  updatePrize(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Param('prizeId') prizeId: string,
    @Body() dto: UpdateProgrammePrizeDto,
  ) {
    return this.programmes.updatePrize(admin.id, id, prizeId, dto);
  }

  @Delete(':id/prizes/:prizeId')
  @ApiOperation({ summary: 'Remove a prize before judging starts' })
  removePrize(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Param('prizeId') prizeId: string,
  ) {
    return this.programmes.removePrize(admin.id, id, prizeId);
  }

  @Post(':id/sponsors')
  @ApiOperation({ summary: 'Record a sponsor and its commitment (FR-1211)' })
  addSponsor(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ProgrammeSponsorDto,
  ) {
    return this.programmes.addSponsor(admin.id, id, dto);
  }

  @Patch(':id/sponsors/:sponsorId')
  @ApiOperation({ summary: 'Update a sponsor record' })
  updateSponsor(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Param('sponsorId') sponsorId: string,
    @Body() dto: UpdateProgrammeSponsorDto,
  ) {
    return this.programmes.updateSponsor(admin.id, id, sponsorId, dto);
  }

  @Delete(':id/sponsors/:sponsorId')
  @ApiOperation({ summary: 'Remove a sponsor record' })
  removeSponsor(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Param('sponsorId') sponsorId: string,
  ) {
    return this.programmes.removeSponsor(admin.id, id, sponsorId);
  }

  @Post(':id/announcements')
  @ApiOperation({ summary: 'Create an announcement; omit publishedAt to draft' })
  addAnnouncement(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ProgrammeAnnouncementDto,
  ) {
    return this.programmes.addAnnouncement(admin.id, id, dto);
  }

  @Patch(':id/announcements/:announcementId')
  @ApiOperation({ summary: 'Update or publish an announcement' })
  updateAnnouncement(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Param('announcementId') announcementId: string,
    @Body() dto: ProgrammeAnnouncementDto,
  ) {
    return this.programmes.updateAnnouncement(
      admin.id,
      id,
      announcementId,
      dto,
    );
  }
}
