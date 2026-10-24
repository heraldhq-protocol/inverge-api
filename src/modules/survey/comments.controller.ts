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
import { CommentsService } from './comments.service';
import {
  CreateCommentDto,
  HighlightCommentDto,
  ListCommentsQueryDto,
} from './dto/comment.dto';

@ApiTags('comments')
@Controller('ideas/:id/comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  post(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: CreateCommentDto) {
    return this.comments.post(user.id, id, dto);
  }

  @Get()
  @UseGuards(OptionalPrivyAuthGuard)
  list(
    @Param('id') id: string,
    @Query() query: ListCommentsQueryDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.comments.list(id, query, user?.id);
  }

  @Post(':commentId/like')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  like(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Param('commentId') commentId: string) {
    return this.comments.like(user.id, id, commentId);
  }

  @Delete(':commentId/like')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  unlike(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Param('commentId') commentId: string) {
    return this.comments.unlike(user.id, id, commentId);
  }

  @Delete(':commentId')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Param('commentId') commentId: string) {
    return this.comments.remove(user.id, id, commentId);
  }

  @Patch(':commentId/highlight')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  highlight(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() dto: HighlightCommentDto,
  ) {
    return this.comments.setHighlight(user.id, id, commentId, dto.highlighted);
  }
}
