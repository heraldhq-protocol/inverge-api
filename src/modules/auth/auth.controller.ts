import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { PrivyAuthGuard } from './guards/privy-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('session')
  @ApiOperation({ summary: 'Exchange a provider access token for an Inverge session' })
  session(@Body() dto: CreateSessionDto) {
    return this.auth.authenticate(dto.accessToken);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user.id);
  }
}
