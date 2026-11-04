import {
  Body,
  Controller,
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
import { OptionalPrivyAuthGuard } from '../auth/guards/optional-privy-auth.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import {
  CreateProgrammeEntryDto,
  ListProgrammesQueryDto,
  RegisterForProgrammeDto,
  SubmitProgrammeEntryDto,
  UpdateProgrammeEntryDto,
  WithdrawProgrammeEntryDto,
} from './dto/programme.dto';
import { ProgrammesService } from './programmes.service';

@ApiTags('programmes')
@Controller('programmes')
export class ProgrammesController {
  constructor(private readonly programmes: ProgrammesService) {}

  @Get()
  @UseGuards(OptionalPrivyAuthGuard)
  @ApiOperation({
    summary: 'List public programmes',
    description:
      'Only published, non-archived programmes appear. Drafts and internal review data never enter this response.',
  })
  list(@Query() query: ListProgrammesQueryDto) {
    return this.programmes.listPublic(query);
  }

  @Get('mine')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({ summary: 'List programmes the caller has registered for' })
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.programmes.listMine(user.id);
  }

  @Get(':idOrSlug')
  @UseGuards(OptionalPrivyAuthGuard)
  @ApiOperation({
    summary: 'Get a public programme by id or slug',
    description:
      'Results are returned only when the organiser published them. Prizes are returned only after their funding is confirmed (FR-1207).',
  })
  get(@Param('idOrSlug') idOrSlug: string) {
    return this.programmes.getPublic(idOrSlug);
  }

  @Get(':idOrSlug/standings')
  @ApiOperation({ summary: 'Get the published official standings' })
  standings(@Param('idOrSlug') idOrSlug: string) {
    return this.programmes.getPublicStandings(idOrSlug);
  }

  @Get(':idOrSlug/entries')
  @ApiOperation({
    summary: 'List publicly visible entries (shortlist or published results)',
  })
  entries(@Param('idOrSlug') idOrSlug: string) {
    return this.programmes.listPublicEntries(idOrSlug);
  }

  @Get(':idOrSlug/me')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({
    summary: 'Get the caller’s registration, drafts and entries for a programme',
  })
  mineForProgramme(
    @CurrentUser() user: AuthenticatedUser,
    @Param('idOrSlug') idOrSlug: string,
  ) {
    return this.programmes.getMine(user.id, idOrSlug);
  }

  @Post(':idOrSlug/register')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({
    summary: 'Register for a programme (free, FR-1210)',
    description:
      'Repeating the call is idempotent. Every refusal returns a machine-readable issue list.',
  })
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Param('idOrSlug') idOrSlug: string,
    @Body() dto: RegisterForProgrammeDto,
  ) {
    return this.programmes.register(user, idOrSlug, dto);
  }

  @Post(':idOrSlug/entries')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({
    summary: 'Create a draft entry from an idea the caller owns',
    description:
      'A new-idea entry is created by publishing the idea first, then referencing it here. This keeps one editable idea record rather than a second content system.',
  })
  createEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('idOrSlug') idOrSlug: string,
    @Body() dto: CreateProgrammeEntryDto,
  ) {
    return this.programmes.createEntry(user, idOrSlug, dto);
  }

  @Get(':idOrSlug/entries/:entryId')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({ summary: 'Get one of the caller’s own entries' })
  getEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('idOrSlug') idOrSlug: string,
    @Param('entryId') entryId: string,
  ) {
    return this.programmes.getMyEntry(user.id, idOrSlug, entryId);
  }

  @Patch(':idOrSlug/entries/:entryId')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({
    summary: 'Edit a draft entry',
    description:
      'A submitted entry is immutable. The only path to a new version is a requested change followed by a new submission.',
  })
  updateEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('idOrSlug') idOrSlug: string,
    @Param('entryId') entryId: string,
    @Body() dto: UpdateProgrammeEntryDto,
  ) {
    return this.programmes.updateEntry(user, idOrSlug, entryId, dto);
  }

  @Post(':idOrSlug/entries/:entryId/submit')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({
    summary: 'Submit an entry and freeze its judging snapshot',
    description:
      'Repeating the call returns the existing snapshot. Editing the underlying idea afterwards cannot change what judges see.',
  })
  submitEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('idOrSlug') idOrSlug: string,
    @Param('entryId') entryId: string,
    @Body() dto: SubmitProgrammeEntryDto,
  ) {
    return this.programmes.submitEntry(user, idOrSlug, entryId, dto);
  }

  @Post(':idOrSlug/entries/:entryId/withdraw')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({ summary: 'Withdraw an entry before judging starts' })
  withdrawEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('idOrSlug') idOrSlug: string,
    @Param('entryId') entryId: string,
    @Body() dto: WithdrawProgrammeEntryDto,
  ) {
    return this.programmes.withdrawEntry(user, idOrSlug, entryId, dto);
  }
}
