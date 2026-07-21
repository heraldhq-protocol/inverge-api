import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { LinkWalletDto, SetWalletRoleDto } from './dto/wallet.dto';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@ApiBearerAuth()
@Controller('wallets')
@UseGuards(PrivyAuthGuard)
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.wallets.list(user.id);
  }

  @Post('link')
  link(@CurrentUser() user: AuthenticatedUser, @Body() dto: LinkWalletDto) {
    return this.wallets.link(user.id, dto);
  }

  @Patch(':id/role')
  setRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SetWalletRoleDto,
  ) {
    return this.wallets.setRole(user.id, id, dto.role);
  }
}
