import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateCreatorProfileDto } from './dto/update-creator-profile.dto';
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

  @Get('check-username')
  @ApiOperation({ summary: 'Check if a username handle is available' })
  checkUsername(@Query('username') username: string) {
    return this.auth.checkUsernameAvailability(username);
  }

  @Patch('me/profile')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({ summary: 'Update creator display profile' })
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateCreatorProfileDto,
  ) {
    return this.auth.updateProfile(user.id, dto);
  }

  @Get('creators/:idOrUsername')
  @ApiOperation({ summary: 'Get public creator profile and their projects/backed ideas' })
  getPublicProfile(@Param('idOrUsername') idOrUsername: string) {
    return this.auth.getPublicProfile(idOrUsername);
  }
}
