import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { ModerationService } from './moderation.service';
import { ScreenContentDto } from './dto/screen-content.dto';

// FR-1001–1007. Admin/tooling entry to run the moderation harness on arbitrary content.
// NOTE: guarded by session auth; admin RBAC is a pre-production TODO (as with AdminController).
@ApiTags('moderation')
@ApiBearerAuth()
@Controller('admin/moderation')
@UseGuards(PrivyAuthGuard)
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Post('screen')
  @ApiOperation({ summary: 'Run the moderation harness (L1 gates → L2 classify → route) on content' })
  screen(@CurrentUser() user: AuthenticatedUser, @Body() dto: ScreenContentDto) {
    return this.moderation.screen(
      { kind: dto.kind, title: dto.title, text: dto.text },
      { submittedById: user.id },
    );
  }
}
