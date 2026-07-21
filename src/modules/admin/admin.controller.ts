import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { PlatformParamsService } from '../platform-params/platform-params.service';
import { UpdateParamsDto } from './dto/update-params.dto';

// FR-901/904. NOTE: guarded by session auth; admin RBAC (role/allowlist) is a
// pre-production TODO — every param change is attributed to the acting user.
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(PrivyAuthGuard)
export class AdminController {
  constructor(private readonly params: PlatformParamsService) {}

  @Get('params')
  getParams() {
    return this.params.getAll();
  }

  @Patch('params')
  async patchParams(
    @Body() dto: UpdateParamsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    for (const [key, value] of Object.entries(dto.params)) {
      await this.params.set(key, value, user.id);
    }
    return this.params.getAll();
  }
}
