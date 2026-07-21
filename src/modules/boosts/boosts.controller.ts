import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { PurchaseBoostDto } from './dto/purchase-boost.dto';
import { BoostsService } from './boosts.service';

@ApiTags('boosts')
@Controller('ideas/:id/boosts')
export class BoostsController {
  constructor(private readonly boosts: BoostsService) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  purchase(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') ideaId: string,
    @Body() dto: PurchaseBoostDto,
  ) {
    return this.boosts.purchase(user.id, ideaId, dto);
  }

  @Get()
  active(@Param('id') ideaId: string) {
    return this.boosts.active(ideaId);
  }
}
