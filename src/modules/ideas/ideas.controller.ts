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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { OptionalPrivyAuthGuard } from '../auth/guards/optional-privy-auth.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import {
  CreateIdeaDto,
  ListIdeasQueryDto,
  PrePledgeDto,
  UpdateIdeaDto,
} from './dto/idea.dto';
import { IdeasService } from './ideas.service';

@ApiTags('ideas')
@Controller('ideas')
export class IdeasController {
  constructor(private readonly ideas: IdeasService) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateIdeaDto) {
    return this.ideas.create(user.id, dto);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateIdeaDto,
  ) {
    return this.ideas.update(user.id, id, dto);
  }

  @Post(':id/publish')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  publish(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.ideas.publish(user.id, id);
  }

  @Get()
  @UseGuards(OptionalPrivyAuthGuard)
  list(@Query() query: ListIdeasQueryDto, @CurrentUser() user?: AuthenticatedUser) {
    return this.ideas.list(query, user?.id);
  }

  @Get(':id')
  @UseGuards(OptionalPrivyAuthGuard)
  get(@Param('id') id: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.ideas.get(id, user);
  }

  @Get(':id/quality')
  @UseGuards(OptionalPrivyAuthGuard)
  quality(@Param('id') id: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.ideas.getQuality(id, user);
  }

  @Post(':id/support')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  support(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.ideas.support(user.id, id);
  }

  @Delete(':id/support')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  unsupport(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.ideas.unsupport(user.id, id);
  }

  @Post(':id/pre-pledge')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  prePledge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PrePledgeDto,
  ) {
    return this.ideas.prePledge(user.id, id, dto);
  }

  @Delete(':id/pre-pledge')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  withdrawPrePledge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.ideas.withdrawPrePledge(user.id, id);
  }
}
