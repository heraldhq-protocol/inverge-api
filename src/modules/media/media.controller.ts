import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { OptionalPrivyAuthGuard } from '../auth/guards/optional-privy-auth.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import {
  CreateMediaUploadDto,
  UpdateMediaAssetDto,
} from './dto/media.dto';
import { MediaAssetsService } from './media-assets.service';

/**
 * Creator media.
 *
 * Ownership is decided in the service, never from a body or query value. The
 * optional-auth guard is used only on the two read routes, where an anonymous
 * caller may read media that belongs to published content and nothing else.
 */
@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaAssetsService) {}

  /**
   * What this deployment accepts, so a client can label the control honestly
   * instead of discovering the limit from a rejected upload.
   */
  @Get('config')
  @ApiOperation({ summary: 'Media capabilities and limits for this deployment' })
  config() {
    return this.media.capabilities();
  }

  @Post('uploads')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @RateLimit('media_upload')
  @ApiOperation({ summary: 'Start an image upload and get a signed upload target' })
  createUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMediaUploadDto,
  ) {
    return this.media.createUpload(user.id, dto);
  }

  @Post('uploads/:id/complete')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @RateLimit('media_upload')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify the uploaded bytes and make the asset attachable' })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.media.completeUpload(user.id, id);
  }

  @Get(':id/url')
  @UseGuards(OptionalPrivyAuthGuard)
  @ApiOperation({
    summary: 'A short-lived read URL, when the viewer may see this media',
  })
  readUrl(
    @Param('id') id: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.media.readUrl(user, id);
  }

  @Get(':id')
  @UseGuards(OptionalPrivyAuthGuard)
  @ApiOperation({ summary: 'Media metadata for its owner or published content' })
  get(@Param('id') id: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.media.getForViewer(user, id);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({ summary: 'Update display metadata (alt text, caption, name)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateMediaAssetDto,
  ) {
    return this.media.update(user.id, id, dto);
  }

  @Delete(':id')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete an asset. Idempotent.' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.media.remove(user.id, id);
  }
}
