import {
  Body,
  Controller,
  Delete,
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
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import {
  CreateCampaignCommentDto,
  ListCommentsQueryDto,
} from '../survey/dto/comment.dto';
import { CampaignCommentsService } from './campaign-comments.service';

@ApiTags('comments')
@Controller('campaigns/:id/comments')
export class CampaignCommentsController {
  constructor(private readonly comments: CampaignCommentsService) {}

  @Get()
  @ApiOperation({
    summary: 'List the public discussion thread for a campaign',
    description:
      'Readable for a publicly accessible campaign only. Draft, in-review and rejected campaigns return 404.',
  })
  list(@Param('id') id: string, @Query() query: ListCommentsQueryDto) {
    return this.comments.list(id, query);
  }

  @Post()
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @RateLimit('comments')
  @ApiOperation({ summary: 'Post a comment on a public campaign' })
  post(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateCampaignCommentDto,
  ) {
    return this.comments.post(user.id, id, dto);
  }

  @Delete(':commentId')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({ summary: 'Delete your own comment (or one on your campaign)' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
  ) {
    return this.comments.remove(user.id, id, commentId);
  }
}
