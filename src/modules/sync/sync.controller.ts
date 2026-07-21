import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { ConvertIdeaDto } from './dto/convert-idea.dto';
import { SyncService } from './sync.service';

@ApiTags('sync')
@Controller('ideas/:id')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('convert')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  convert(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') ideaId: string,
    @Body() dto: ConvertIdeaDto,
  ) {
    return this.sync.convert(user.id, ideaId, dto);
  }
}
