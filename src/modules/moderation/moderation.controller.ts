import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { AdminGuard } from '../auth/guards/admin.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { ModerationService } from './moderation.service';
import { ScreenContentDto } from './dto/screen-content.dto';

// FR-1001–1007. Admin/tooling entry to run the moderation harness on arbitrary content.
// FR-901: admin RBAC. PrivyAuthGuard authenticates, AdminGuard requires role ADMIN (or the
// ADMIN_ALLOWLIST break-glass set). This route can run the vendor classifier on arbitrary
// text, so authentication alone is not enough.
@ApiTags('moderation')
@ApiBearerAuth()
@Controller('admin/moderation')
@UseGuards(PrivyAuthGuard, AdminGuard)
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
